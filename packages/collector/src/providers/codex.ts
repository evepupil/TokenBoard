import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { createCodexSessionScopeBatches, type CodexSessionScope } from './codex-session-scope'

const DEFAULT_CODEX_BATCH_SIZE = 200
const MAX_CODEX_BATCH_SIZE = 1000

export type CollectCodexUsageOptions = {
  timezone?: string
  collectedAt?: string
  codexHome?: string
  runner?: CommandRunner
}

export async function collectCodexUsage(
  options: CollectCodexUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
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
        rangeArgs,
        scope,
        options,
        collectedAt
      })))
    }

    return mergeSnapshots(snapshots)
  }

  const json = await runner('npx', ['@ccusage/codex@latest', 'daily', '--json', ...rangeArgs], { env: process.env })
  const sessions = await runner('npx', ['@ccusage/codex@latest', 'session', '--json', ...rangeArgs], { env: process.env })

  return normalizeCcusageDailyJson(json, {
    source: 'codex',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt,
    sessions
  })
}

async function collectScopedBatch(input: {
  runner: CommandRunner
  rangeArgs: string[]
  scope: CodexSessionScope
  options: CollectCodexUsageOptions
  collectedAt: string
}) {
  try {
    const env = { ...process.env, CODEX_HOME: input.scope.codexHome }
    const json = await input.runner('npx', ['@ccusage/codex@latest', 'daily', '--json', ...input.rangeArgs], { env })
    const sessions = await input.runner('npx', ['@ccusage/codex@latest', 'session', '--json', ...input.rangeArgs], { env })

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
