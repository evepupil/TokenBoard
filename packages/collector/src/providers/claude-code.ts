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
  const [json, sessions] = await Promise.all([
    runner('npx', ['ccusage@latest', 'daily', '--json', '--breakdown']),
    runner('npx', ['ccusage@latest', 'session', '--json'])
  ])

  return normalizeCcusageDailyJson(json, {
    source: 'claude-code',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: options.collectedAt,
    sessions
  })
}
