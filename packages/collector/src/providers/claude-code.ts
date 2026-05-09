import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { resolvePackageRunner } from '../package-runner'

export type CollectUsageOptions = {
  timezone?: string
  collectedAt?: string
  runner?: CommandRunner
}

export async function collectClaudeCodeUsage(
  options: CollectUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const packageRunner = resolvePackageRunner()
  const sinceArgs = process.env.TOKENBOARD_SINCE ? ['--since', process.env.TOKENBOARD_SINCE] : []
  const json = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['daily', '--json', '--breakdown', ...sinceArgs])
  )
  const sessions = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['session', '--json', ...sinceArgs])
  )

  return normalizeCcusageDailyJson(json, {
    source: 'claude-code',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: options.collectedAt,
    sessions
  })
}
