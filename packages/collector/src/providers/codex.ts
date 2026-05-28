import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { resolvePackageRunner, type PackageRunner } from '../package-runner'
import { packageCommandOptions, readDailyTimeoutMs, readSessionTimeoutMs } from './codex-command-options'
import { createCodexSessionScopeBatches, type CodexSessionScope } from './codex-session-scope'
import { applyCodexSubagentUsageCorrections } from './codex-subagent-usage'
import {
  assertHookReconciliationSnapshots,
  collectHookIncremental,
  isHookMode
} from './hook-incremental'
import { mergeSnapshots } from './session-cursor'

const DEFAULT_CODEX_BATCH_SIZE = 200
const MAX_CODEX_BATCH_SIZE = 1000

export type CollectCodexUsageOptions = {
  timezone?: string
  collectedAt?: string
  codexHome?: string
  runner?: CommandRunner
  stderr?: (line: string) => void
}

export async function collectCodexUsage(
  options: CollectCodexUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const packageRunner = resolvePackageRunner()
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  if (isHookMode()) {
    return collectCodexHookUsage({
      runner,
      packageRunner,
      options,
      collectedAt
    })
  }

  const since = readSince()
  const until = process.env.TOKENBOARD_UNTIL
  const rangeArgs = buildRangeArgs({ since, until })
  const usesScopedScan = since === 'all' || Boolean(since) || Boolean(until)
  if (usesScopedScan) {
    return collectScopedCodexUsage({
      runner,
      packageRunner,
      rangeArgs,
      since,
      until,
      options,
      collectedAt
    })
  }

  const env = options.codexHome
    ? { ...process.env, CODEX_HOME: options.codexHome }
    : process.env
  return collectCodexCcusageRange({
    runner,
    packageRunner,
    rangeArgs,
    options,
    collectedAt,
    env
  })
}

async function collectScopedCodexUsage(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
}) {
  const snapshots: UsageSnapshot[] = []
  for await (const scope of createCodexSessionScopeBatches({
    codexHome: input.options.codexHome,
    since: input.since,
    until: input.until,
    batchSize: readBatchSize(),
    onMissingSessionFile: (sessionPath) =>
      input.options.stderr?.(`Skipping Codex session file that disappeared before copy: ${sessionPath}`)
  })) {
    snapshots.push(...(await collectScopedBatch({
      runner: input.runner,
      packageRunner: input.packageRunner,
      rangeArgs: input.rangeArgs,
      scope,
      options: input.options,
      collectedAt: input.collectedAt
    })))
  }

  return mergeSnapshots(snapshots)
}

async function collectCodexHookUsage(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  collectedAt: string
}) {
  const codexHome = resolveCodexHome(input.options.codexHome)
  const timezone = input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const incremental = await collectHookIncremental({
    source: 'codex',
    sessionsDir: join(codexHome, 'sessions'),
    cursorName: 'codex-cursor.json',
    timezone,
    collectedAt: input.collectedAt
  })

  if (!incremental.changed) {
    return []
  }

  const snapshots = await collectCodexCcusageRange({
    runner: input.runner,
    packageRunner: input.packageRunner,
    rangeArgs: withTimezoneArgs(incremental.rangeArgs, timezone),
    options: input.options,
    collectedAt: input.collectedAt,
    env: { ...process.env, CODEX_HOME: codexHome }
  })
  assertHookReconciliationSnapshots({
    sourceLabel: 'Codex',
    expectedDates: incremental.changedDates,
    expectedKeys: incremental.changedKeys,
    snapshots
  })
  return snapshots
}

async function collectCodexCcusageRange(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  options: CollectCodexUsageOptions
  collectedAt: string
  env: NodeJS.ProcessEnv
  correctionCodexHome?: string
}) {
  const json = await input.runner(
    input.packageRunner.command,
    input.packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['codex', 'daily', '--json', ...input.rangeArgs]),
    packageCommandOptions({
      env: input.env,
      timeoutMs: readDailyTimeoutMs(),
      stderr: input.options.stderr
    })
  )
  const sessions = await collectSessionCounts({
    runner: input.runner,
    command: input.packageRunner.command,
    args: input.packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['codex', 'session', '--json', ...input.rangeArgs]),
    options: packageCommandOptions({
      env: input.env,
      timeoutMs: readSessionTimeoutMs(),
      stderr: input.options.stderr
    }),
    stderr: input.options.stderr
  })

  const snapshots = normalizeCcusageDailyJson(json, {
    source: 'codex',
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: input.collectedAt,
    sessions
  })
  return applyCodexSubagentUsageCorrections({
    snapshots,
    sessions,
    codexHome: input.correctionCodexHome ?? input.env.CODEX_HOME ?? resolveCodexHome(input.options.codexHome),
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    stderr: input.options.stderr
  })
}

async function collectScopedBatch(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  scope: CodexSessionScope
  options: CollectCodexUsageOptions
  collectedAt: string
}) {
  try {
    const env = { ...process.env, CODEX_HOME: input.scope.codexHome }
    return await collectCodexCcusageRange({
      runner: input.runner,
      packageRunner: input.packageRunner,
      rangeArgs: input.rangeArgs,
      options: input.options,
      collectedAt: input.collectedAt,
      env,
      correctionCodexHome: input.scope.codexHome
    })
  } finally {
    await input.scope.cleanup()
  }
}

async function collectSessionCounts({
  runner,
  command,
  args,
  options,
  stderr = console.error
}: {
  runner: CommandRunner
  command: string
  args: string[]
  options: Parameters<CommandRunner>[2]
  stderr?: (line: string) => void
}) {
  try {
    return await runner(
      command,
      args,
      options
    )
  } catch (error) {
    stderr(`Codex daily tokens collected, but session counts are unavailable; continuing with sessionCount=0: ${errorMessage(error)}`)
    return { data: [] }
  }
}

function buildRangeArgs(options: { since?: string; until?: string }) {
  const args: string[] = []
  if (options.since && options.since !== 'all') {
    args.push('--since', options.since)
  }
  if (options.until) {
    args.push('--until', options.until)
  }
  return args
}

function withTimezoneArgs(args: string[], timezone: string) {
  return [...args, '--timezone', timezone]
}

function readSince() {
  const since = process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || ''
  return since || ''
}

function resolveCodexHome(value?: string) {
  return value || process.env.CODEX_HOME || join(homedir(), '.codex')
}

function readBatchSize() {
  const value = Number(process.env.TOKENBOARD_CODEX_BATCH_SIZE || DEFAULT_CODEX_BATCH_SIZE)
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_CODEX_BATCH_SIZE
  }
  return Math.min(Math.floor(value), MAX_CODEX_BATCH_SIZE)
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
