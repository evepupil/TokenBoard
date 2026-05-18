import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { resolvePackageRunner, type PackageRunner } from '../package-runner'
import { createCodexSessionScopeBatches, type CodexSessionScope } from './codex-session-scope'

const DEFAULT_CODEX_BATCH_SIZE = 200
const MAX_CODEX_BATCH_SIZE = 1000
const DEFAULT_DAILY_TIMEOUT_MS = 900_000
const DEFAULT_SESSION_TIMEOUT_MS = 900_000
const DEFAULT_PACKAGE_COMMAND_RETRIES = 2

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
  const since = readSince()
  const until = process.env.TOKENBOARD_UNTIL
  const rangeArgs = buildRangeArgs({ since, until })
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const snapshots: UsageSnapshot[] = []
  const usesScopedScan = since === 'all' || Boolean(since) || Boolean(until)

  if (usesScopedScan) {
    for await (const scope of createCodexSessionScopeBatches({
      codexHome: options.codexHome,
      since,
      until,
      batchSize: readBatchSize()
    })) {
      snapshots.push(...(await collectScopedBatch({
        runner,
        packageRunner,
        rangeArgs,
        scope,
        options,
        collectedAt
      })))
    }

    return mergeSnapshots(snapshots)
  }

  const json = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['codex', 'daily', '--json', ...rangeArgs]),
    packageCommandOptions({
      env: process.env,
      timeoutMs: readDailyTimeoutMs(),
      stderr: options.stderr
    })
  )
  const sessions = await collectSessionCounts({
    runner,
    command: packageRunner.command,
    args: packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['codex', 'session', '--json', ...rangeArgs]),
    options: packageCommandOptions({
      env: process.env,
      timeoutMs: readSessionTimeoutMs(),
      stderr: options.stderr
    }),
    stderr: options.stderr
  })

  return normalizeCcusageDailyJson(json, {
    source: 'codex',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt,
    sessions
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
    const json = await input.runner(
      input.packageRunner.command,
      input.packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['codex', 'daily', '--json', ...input.rangeArgs]),
      packageCommandOptions({
        env,
        timeoutMs: readDailyTimeoutMs(),
        stderr: input.options.stderr
      })
    )
    const sessions = await collectSessionCounts({
      runner: input.runner,
      command: input.packageRunner.command,
      args: input.packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['codex', 'session', '--json', ...input.rangeArgs]),
      options: packageCommandOptions({
        env,
        timeoutMs: readSessionTimeoutMs(),
        stderr: input.options.stderr
      }),
      stderr: input.options.stderr
    })

    return normalizeCcusageDailyJson(json, {
      source: 'codex',
      timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      collectedAt: input.collectedAt,
      sessions
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

function readDailyTimeoutMs() {
  const value = Number.parseInt(process.env.TOKENBOARD_CODEX_DAILY_TIMEOUT_MS || '', 10)
  if (Number.isFinite(value) && value > 0) {
    return value
  }
  return DEFAULT_DAILY_TIMEOUT_MS
}

function readSessionTimeoutMs() {
  const value = Number.parseInt(process.env.TOKENBOARD_CODEX_SESSION_TIMEOUT_MS || '', 10)
  if (Number.isFinite(value) && value > 0) {
    return value
  }
  return DEFAULT_SESSION_TIMEOUT_MS
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

function readSince() {
  const since = process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || ''
  return since || ''
}

function readBatchSize() {
  const value = Number(process.env.TOKENBOARD_CODEX_BATCH_SIZE || DEFAULT_CODEX_BATCH_SIZE)
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_CODEX_BATCH_SIZE
  }
  return Math.min(Math.floor(value), MAX_CODEX_BATCH_SIZE)
}

function mergeSnapshots(snapshots: UsageSnapshot[]) {
  const rows = new Map<string, UsageSnapshot>()
  for (const snapshot of snapshots) {
    const key = [
      snapshot.source,
      snapshot.usageDate,
      snapshot.timezone,
      snapshot.model
    ].join('\0')
    const current = rows.get(key)
    if (!current) {
      rows.set(key, { ...snapshot })
      continue
    }

    current.inputTokens += snapshot.inputTokens
    current.outputTokens += snapshot.outputTokens
    current.cacheCreationTokens += snapshot.cacheCreationTokens
    current.cacheReadTokens += snapshot.cacheReadTokens
    current.totalTokens += snapshot.totalTokens
    current.costUsd += snapshot.costUsd
    current.sessionCount += snapshot.sessionCount
  }

  return [...rows.values()].sort((left, right) =>
    left.usageDate.localeCompare(right.usageDate) ||
    left.model.localeCompare(right.model)
  )
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
