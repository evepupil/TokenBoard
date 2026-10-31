import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { ccusagePackageSpecifier, resolvePackageRunner, type PackageRunner } from '../package-runner'
import { prepareDynamicCcusageConfig, type PricingFetcher } from '../model-pricing'
import { phaseNames, timePhase, type PhaseTimings } from '../phase-timings'
import { assertHookReconciliationSnapshots, collectHookIncremental, isHookMode } from './hook-incremental'
import { mergeSnapshots } from './session-cursor'
import { assertValidDateFilterRange } from '../iso-calendar-date'

export type CollectUsageOptions = {
  timezone?: string
  collectedAt?: string
  since?: string
  until?: string
  runner?: CommandRunner
  stderr?: (line: string) => void
  stateDir?: string
  env?: NodeJS.ProcessEnv
  pricingFetcher?: PricingFetcher
  timings?: PhaseTimings
}

const DEFAULT_PACKAGE_COMMAND_RETRIES = 2
// ccusage scans every Claude Code session file to build one day's totals, so a large session
// library on a loaded machine can outlast a short budget. The Codex provider gives its
// ccusage calls 15 minutes; this side used to fall back to the generic 2-minute default, which
// turned busy-machine hook syncs into `Command failed` with no timeout in the message.
const DEFAULT_CCUSAGE_TIMEOUT_MS = 900_000

export async function collectClaudeCodeUsage(options: CollectUsageOptions = {}): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const env = options.env ?? process.env
  const stateDir = options.stateDir?.trim() || env.TOKENBOARD_STATE_DIR?.trim() || env.TOKENBOARD_CONFIG_DIR?.trim()
  const prepared = await prepareDynamicCcusageConfig({
    endpoint: env.TOKENBOARD_ENDPOINT,
    stateDir,
    hookMode: isHookMode(env),
    explicitConfigPath: env.TOKENBOARD_CCUSAGE_CONFIG,
    fetcher: options.pricingFetcher,
    stderr: env.TOKENBOARD_ENDPOINT ? options.stderr : undefined
  })
  const commandEnv: NodeJS.ProcessEnv = prepared.configPath
    ? { ...env, TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG: prepared.configPath }
    : { ...env }
  const collectionOptions: CollectUsageOptions = {
    ...options,
    env: commandEnv,
    stateDir
  }
  const packageRunner = resolvePackageRunner(
    commandEnv.TOKENBOARD_PACKAGE_MANAGER,
    process.platform,
    existsSync,
    commandEnv,
    isHookMode(env)
  )
  const collectedAt = options.collectedAt ?? new Date().toISOString()

  if (isHookMode(env)) {
    const snapshots = await collectClaudeHookUsage({
      runner,
      packageRunner,
      options: collectionOptions,
      collectedAt,
      env: commandEnv
    })
    reportUnpricedClaudeSnapshots(snapshots, prepared.coveredModelIds, options.stderr)
    return snapshots
  }

  const rangeArgs = buildRangeArgs({
    since: options.since ?? (env.TOKENBOARD_SINCE || env.TOKENBOARD_DEFAULT_SINCE || ''),
    until: options.until ?? env.TOKENBOARD_UNTIL ?? ''
  })

  const snapshots = await collectClaudeCcusageRange({
    runner,
    packageRunner,
    rangeArgs,
    options: collectionOptions,
    collectedAt,
    env: commandEnv
  })
  reportUnpricedClaudeSnapshots(snapshots, prepared.coveredModelIds, options.stderr)
  return snapshots
}

async function collectClaudeHookUsage(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectUsageOptions
  collectedAt: string
  env: NodeJS.ProcessEnv
}) {
  const claudeHome = readClaudeHome(input.env)
  const timezone = input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const incremental = await timePhase(input.options.timings, phaseNames.cursorScan, () =>
    collectHookIncremental({
      source: 'claude-code',
      sessionsDir: join(claudeHome, 'projects'),
      cursorName: 'claude-code-cursor.json',
      stateDir: input.options.stateDir,
      stderr: input.options.stderr,
      timezone,
      collectedAt: input.collectedAt
    })
  )

  if (!incremental.changed) {
    return []
  }

  const snapshots =
    incremental.rangeArgs.length > 0
      ? await collectClaudeCcusageRange({
          runner: input.runner,
          packageRunner: input.packageRunner,
          rangeArgs: withTimezoneArgs(incremental.rangeArgs, timezone),
          options: input.options,
          collectedAt: input.collectedAt,
          env: { ...input.env, CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HOME: claudeHome }
        })
      : []
  if (incremental.rangeArgs.length > 0) {
    assertHookReconciliationSnapshots({
      sourceLabel: 'Claude',
      expectedDates: incremental.changedDates,
      expectedKeys: incremental.changedKeys,
      snapshots
    })
  }
  return mergeSnapshots([...snapshots, ...incremental.cachedSnapshots])
}

async function collectClaudeCcusageRange(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  options: CollectUsageOptions
  collectedAt: string
  env: NodeJS.ProcessEnv
}) {
  const json = await timePhase(input.options.timings, phaseNames.ccusageDaily, () =>
    input.runner(
      input.packageRunner.command,
      input.packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', [
        'claude',
        'daily',
        '--json',
        '--breakdown',
        // Loads the session JSONLs sequentially instead of all at once. ccusage
        // peaks at 4.6-7.6 GB resident on a large history in parallel mode, and
        // this runs as a background hook; the Codex provider passes the same
        // flag everywhere. The cost is longer wall time, which the phase timings
        // now make visible.
        '--single-thread',
        ...input.rangeArgs
      ]),
      packageCommandOptions({
        env: input.env,
        timeoutMs: readCcusageTimeoutMs(input.env),
        stderr: input.options.stderr
      })
    )
  )
  const sessions = await timePhase(input.options.timings, phaseNames.ccusageSession, () =>
    input.runner(
      input.packageRunner.command,
      input.packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', [
        'claude',
        'session',
        '--json',
        '--single-thread',
        ...input.rangeArgs
      ]),
      packageCommandOptions({
        env: input.env,
        timeoutMs: readCcusageTimeoutMs(input.env),
        stderr: input.options.stderr
      })
    )
  )

  return normalizeCcusageDailyJson(json, {
    source: 'claude-code',
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: input.collectedAt,
    sessions
  })
}

function packageCommandOptions({
  env,
  timeoutMs,
  stderr = console.error
}: {
  env: NodeJS.ProcessEnv
  timeoutMs: number
  stderr?: (line: string) => void
}) {
  return {
    env,
    timeoutMs,
    retries: readPackageCommandRetries(env),
    onRetry: stderr
  }
}

export function readCcusageTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const value = Number.parseInt(env.TOKENBOARD_CCUSAGE_TIMEOUT_MS || '', 10)
  if (Number.isFinite(value) && value > 0) {
    return value
  }
  return DEFAULT_CCUSAGE_TIMEOUT_MS
}

function readPackageCommandRetries(env: NodeJS.ProcessEnv = process.env) {
  const value = Number.parseInt(env.TOKENBOARD_PACKAGE_COMMAND_RETRIES || '', 10)
  if (Number.isFinite(value) && value >= 0) {
    return value
  }
  return DEFAULT_PACKAGE_COMMAND_RETRIES
}

// A model missing from the TokenBoard override set is not by itself a problem: ccusage prices
// it from its own builtin catalogue and the cost arrives with the snapshot. Warning on the
// override set alone buried the log (43-44 models per run, all priced, 1666 lines in one week
// of this machine's rotated stderr). Only a model that came back with zero cost — and real
// usage, so a zero-token row is not confused with a free tier — is worth a line.
function reportUnpricedClaudeSnapshots(
  snapshots: readonly UsageSnapshot[],
  coveredModelIds: ReadonlySet<string>,
  stderr?: (line: string) => void
) {
  const models = new Set(
    snapshots
      .filter((snapshot) => snapshot.source === 'claude-code' && snapshot.totalTokens > 0)
      .filter((snapshot) => !(snapshot.costUsd > 0))
      .map((snapshot) => snapshot.model)
      .filter((model) => !coveredModelIds.has(model))
  )
  for (const model of models) {
    stderr?.(`TokenBoard model pricing unavailable for Claude Code model ${model}; preserving ccusage result`)
  }
}

function buildRangeArgs(options: { since?: string; until?: string }) {
  const range = assertValidDateFilterRange({
    ...options,
    sinceField: 'Claude since date',
    untilField: 'Claude until date'
  })
  const args: string[] = []
  if (range.since) args.push('--since', range.since)
  if (range.until) args.push('--until', range.until)
  return args
}

function withTimezoneArgs(args: string[], timezone: string) {
  return [...args, '--timezone', timezone]
}

function readClaudeHome(env: NodeJS.ProcessEnv = process.env) {
  return env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || join(homedir(), '.claude')
}
