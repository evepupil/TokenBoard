import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { resolvePackageRunner } from '../package-runner'

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
  const rangeArgs = buildRangeArgs({
    since: process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || '',
    until: process.env.TOKENBOARD_UNTIL || ''
  })
  const json = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['claude', 'daily', '--json', '--breakdown', ...rangeArgs]),
    packageCommandOptions({
      env: process.env,
      stderr: options.stderr
    })
  )
  const sessions = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['claude', 'session', '--json', ...rangeArgs]),
    packageCommandOptions({
      env: process.env,
      stderr: options.stderr
    })
  )

  return normalizeCcusageDailyJson(json, {
    source: 'claude-code',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: options.collectedAt,
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
