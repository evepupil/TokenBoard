import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { resolvePackageRunner, type PackageRunner } from '../package-runner'
import {
  assertHookReconciliationSnapshots,
  collectHookIncremental,
  isHookMode
} from './hook-incremental'
import { mergeSnapshots } from './session-cursor'

export type CollectUsageOptions = {
  timezone?: string
  collectedAt?: string
  runner?: CommandRunner
  stderr?: (line: string) => void
}

const DEFAULT_PACKAGE_COMMAND_RETRIES = 2

export async function collectClaudeCodeUsage(
  options: CollectUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const packageRunner = resolvePackageRunner()
  const collectedAt = options.collectedAt ?? new Date().toISOString()

  if (isHookMode()) {
    return collectClaudeHookUsage({
      runner,
      packageRunner,
      options,
      collectedAt
    })
  }

  const rangeArgs = buildRangeArgs({
    since: process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || '',
    until: process.env.TOKENBOARD_UNTIL || ''
  })

  return collectClaudeCcusageRange({
    runner,
    packageRunner,
    rangeArgs,
    options,
    collectedAt,
    env: process.env
  })
}

async function collectClaudeHookUsage(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectUsageOptions
  collectedAt: string
}) {
  const claudeHome = readClaudeHome()
  const timezone = input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const incremental = await collectHookIncremental({
    source: 'claude-code',
    sessionsDir: join(claudeHome, 'projects'),
    cursorName: 'claude-code-cursor.json',
    timezone,
    collectedAt: input.collectedAt
  })

  if (!incremental.changed) {
    return []
  }

  const snapshots = incremental.rangeArgs.length > 0
    ? await collectClaudeCcusageRange({
        runner: input.runner,
        packageRunner: input.packageRunner,
        rangeArgs: withTimezoneArgs(incremental.rangeArgs, timezone),
        options: input.options,
        collectedAt: input.collectedAt,
        env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HOME: claudeHome }
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
  const json = await input.runner(
    input.packageRunner.command,
    input.packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['claude', 'daily', '--json', '--breakdown', ...input.rangeArgs]),
    packageCommandOptions({
      env: input.env,
      stderr: input.options.stderr
    })
  )
  const sessions = await input.runner(
    input.packageRunner.command,
    input.packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['claude', 'session', '--json', ...input.rangeArgs]),
    packageCommandOptions({
      env: input.env,
      stderr: input.options.stderr
    })
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
  stderr = console.error
}: {
  env: NodeJS.ProcessEnv
  stderr?: (line: string) => void
}) {
  return {
    env,
    retries: readPackageCommandRetries(),
    onRetry: stderr
  }
}

function readPackageCommandRetries() {
  const value = Number.parseInt(process.env.TOKENBOARD_PACKAGE_COMMAND_RETRIES || '', 10)
  if (Number.isFinite(value) && value >= 0) {
    return value
  }
  return DEFAULT_PACKAGE_COMMAND_RETRIES
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

function readClaudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_HOME || join(homedir(), '.claude')
}
