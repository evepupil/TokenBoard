import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'

export type CollectCodexUsageOptions = {
  timezone?: string
  collectedAt?: string
  runner?: CommandRunner
}

export async function collectCodexUsage(
  options: CollectCodexUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const json = await runner('npx', ['@ccusage/codex@latest', 'daily', '--json'])

  return normalizeCcusageDailyJson(json, {
    source: 'codex',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: options.collectedAt
  })
}
