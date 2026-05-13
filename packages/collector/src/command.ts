import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_DELAY_MS = 5_000

const RETRYABLE_ERROR_PATTERNS = [
  'fetch failed',
  'unknown_certificate_verification_error',
  'cert_',
  'econnreset',
  'econnrefused',
  'etimedout',
  'eai_again',
  'enotfound',
  'network',
  'socket hang up',
  'tls'
]

export type CommandRunnerOptions = {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
  onRetry?: (line: string) => void
}

export type CommandRunner = (command: string, args: string[], options?: CommandRunnerOptions) => Promise<unknown>

export const runJsonCommand: CommandRunner = async (command, args, options = {}) => {
  const retries = readRetryCount(options.retries)
  const maxAttempts = retries + 1

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(command, args, {
        shell: false,
        maxBuffer: 128 * 1024 * 1024,
        timeout: options.timeoutMs ?? readCommandTimeoutMs(),
        env: options.env
      })

      return JSON.parse(stdout)
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableCommandError(error)) {
        throw error
      }

      options.onRetry?.(
        `Retrying command after transient failure (${attempt}/${retries}): ${errorMessage(error)}`
      )
      await wait(options.retryDelayMs ?? readRetryDelayMs())
    }
  }

  throw new Error(`Command failed without a result: ${command}`)
}

function readCommandTimeoutMs() {
  const value = Number.parseInt(process.env.TOKENBOARD_COMMAND_TIMEOUT_MS || '', 10)
  if (Number.isFinite(value) && value > 0) {
    return value
  }
  return DEFAULT_COMMAND_TIMEOUT_MS
}

function readRetryCount(value?: number) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }

  const envValue = Number.parseInt(process.env.TOKENBOARD_COMMAND_RETRIES || '', 10)
  if (Number.isFinite(envValue) && envValue >= 0) {
    return envValue
  }

  return 0
}

function readRetryDelayMs() {
  const value = Number.parseInt(process.env.TOKENBOARD_COMMAND_RETRY_DELAY_MS || '', 10)
  if (Number.isFinite(value) && value >= 0) {
    return value
  }
  return DEFAULT_RETRY_DELAY_MS
}

function isRetryableCommandError(error: unknown) {
  const message = errorMessage(error).toLowerCase()
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function wait(delayMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}
