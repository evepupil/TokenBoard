import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { errorMessage } from './error-message'

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
  const shell = commandShellOption(command)
  assertWindowsShellSafeInvocation(command, args, shell)
  const invocation = buildShellInvocation(command, args, shell)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(invocation.command, invocation.args, {
        shell: invocation.shell,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        maxBuffer: 128 * 1024 * 1024,
        timeout: options.timeoutMs ?? readCommandTimeoutMs(),
        env: options.env
      })

      return JSON.parse(stdout)
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableCommandError(error)) {
        throw error
      }

      options.onRetry?.(`Retrying command after transient failure (${attempt}/${retries}): ${errorMessage(error)}`)
      await wait(options.retryDelayMs ?? readRetryDelayMs())
    }
  }

  throw new Error(`Command failed without a result: ${command}`)
}

export function commandShellOption(command: string, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command)
}

export function assertWindowsShellSafeInvocation(command: string, args: string[], shell: boolean) {
  if (!shell) return
  if (windowsShellCommandMetacharacters.test(command)) {
    throw new Error('Refusing to pass shell metacharacters in a Windows command shim path')
  }
  const unsafeIndex = args.findIndex((arg) => windowsShellMetacharacters.test(arg))
  if (unsafeIndex >= 0) {
    throw new Error(`Refusing to pass shell metacharacters in Windows command argument ${unsafeIndex}`)
  }
}

export function buildShellInvocation(command: string, args: string[], shell: boolean) {
  if (!shell) return { command, args, shell: false, windowsVerbatimArguments: false }
  assertWindowsShellSafeInvocation(command, args, true)
  const commandLine = [command, ...args].map(quoteWindowsShellArgument).join(' ')
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine.startsWith('"') ? `"${commandLine}"` : commandLine],
    shell: false,
    windowsVerbatimArguments: true
  }
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

function wait(delayMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

// Parentheses are valid inside the command string passed to cmd.exe and in
// normal Windows paths such as "Program Files (x86)". Keep rejecting control
// and expansion operators that can still alter shell evaluation.
const windowsShellMetacharacters = /[&|<>^%!"\r\n]/
const windowsShellCommandMetacharacters = /[&|<>^%!"\r\n]/

function quoteWindowsShellArgument(value: string) {
  const text = String(value)
  const needsQuotes = text.length === 0 || /[\s()]/.test(text) || /\\$/.test(text)
  if (!needsQuotes) return text

  const trailingBackslashes = text.match(/\\+$/)?.[0].length ?? 0
  return `"${text}${'\\'.repeat(trailingBackslashes)}"`
}
