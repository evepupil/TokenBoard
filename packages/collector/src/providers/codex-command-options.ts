import type { CommandRunner } from '../command'

const DEFAULT_DAILY_TIMEOUT_MS = 900_000
const DEFAULT_SESSION_TIMEOUT_MS = 900_000
const DEFAULT_PACKAGE_COMMAND_RETRIES = 2

export function packageCommandOptions({
  env,
  timeoutMs,
  stderr = console.error
}: {
  env: NodeJS.ProcessEnv
  timeoutMs: number
  stderr?: (line: string) => void
}): Parameters<CommandRunner>[2] {
  return {
    env,
    timeoutMs,
    retries: readPackageCommandRetries(),
    onRetry: stderr
  }
}

export function readDailyTimeoutMs() {
  const value = Number.parseInt(process.env.TOKENBOARD_CODEX_DAILY_TIMEOUT_MS || '', 10)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DAILY_TIMEOUT_MS
}

export function readSessionTimeoutMs() {
  const value = Number.parseInt(process.env.TOKENBOARD_CODEX_SESSION_TIMEOUT_MS || '', 10)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SESSION_TIMEOUT_MS
}

function readPackageCommandRetries() {
  const value = Number.parseInt(process.env.TOKENBOARD_PACKAGE_COMMAND_RETRIES || '', 10)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PACKAGE_COMMAND_RETRIES
}
