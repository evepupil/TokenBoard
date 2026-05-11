import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'

export type CollectUsageOptions = {
  timezone?: string
  collectedAt?: string
  runner?: CommandRunner
}

export async function collectClaudeCodeUsage(
  options: CollectUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const since = process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || ''
  const sinceArgs = since && since !== 'all' ? ['--since', since] : []
  const json = await runner('npx', ['ccusage@latest', 'daily', '--json', '--breakdown', ...sinceArgs])
  const sessions = await runner('npx', ['ccusage@latest', 'session', '--json', ...sinceArgs])

  return normalizeCcusageDailyJson(json, {
    source: 'claude-code',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: options.collectedAt,
    sessions
  })
}
