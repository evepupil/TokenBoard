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
  const json = await runner('npx', ['ccusage@latest', 'daily', '--json', '--breakdown'])

  return normalizeCcusageDailyJson(json, {
    source: 'claude-code',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: options.collectedAt
  })
}
