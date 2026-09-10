import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { getSystemErrorName } from 'node:util'

const COPY_ON_WRITE_CLONE_UNAVAILABLE_CODES = new Set([
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'ERR_MACOS_CLONE_HELPER_UNAVAILABLE'
])
export const CODEX_SESSION_COPY_FALLBACK_MESSAGE =
  'Codex copy-on-write clone is unavailable; using a bounded standard file copy'
const MACOS_CLONE_RESPONSE_MAX_BYTES = 8 * 1024
const MACOS_CLONE_REQUEST_TIMEOUT_MS = 30_000
const MACOS_CLONE_SHUTDOWN_TIMEOUT_MS = 1_000
const MACOS_CLONEFILE_SERVER_SCRIPT = [
  "require 'fiddle'",
  "require 'json'",
  "clonefile = Fiddle::Function.new(Fiddle::Handle::DEFAULT['clonefile'], [Fiddle::TYPE_VOIDP, Fiddle::TYPE_VOIDP, Fiddle::TYPE_INT], Fiddle::TYPE_INT)",
  'STDIN.each_line do |line|',
  '  request = JSON.parse(line)',
  '  result = clonefile.call(request.fetch(\'source\').b + "\\0", request.fetch(\'target\').b + "\\0", 0)',
  '  response = result == 0 ? { ok: true } : { ok: false, errno: Fiddle.last_error }',
  '  STDOUT.write(JSON.generate(response) + "\\n")',
  '  STDOUT.flush',
  'end'
].join('\n')

type SessionCopyFile = typeof copyFile
type SpawnProcess = typeof spawn

export type CodexSessionCloner = {
  copy: (source: string, target: string) => Promise<void>
  close: () => Promise<void>
}

type CodexSessionClonerOptions = {
  onFallback?: () => void
  platform?: NodeJS.Platform
  copyFile?: SessionCopyFile
  spawnProcess?: SpawnProcess
}

export function createCodexSessionCloner(options: CodexSessionClonerOptions = {}): CodexSessionCloner {
  const input = {
    onFallback: options.onFallback,
    copyFile: options.copyFile ?? copyFile
  }
  if ((options.platform ?? process.platform) === 'darwin') {
    return new MacOsCodexSessionCloner({ ...input, spawnProcess: options.spawnProcess ?? spawn })
  }
  return new NodeCodexSessionCloner(input)
}

class NodeCodexSessionCloner implements CodexSessionCloner {
  private cloneUnavailable = false

  constructor(
    private readonly input: {
      copyFile: SessionCopyFile
      onFallback?: () => void
    }
  ) {}

  async copy(source: string, target: string) {
    if (this.cloneUnavailable) {
      await copyFileExclusive(this.input.copyFile, source, target)
      return
    }

    try {
      await this.input.copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE)
    } catch (error) {
      if (!isCopyOnWriteCloneUnavailable(error)) throw error
      if (readErrorCode(error) !== 'EXDEV') this.cloneUnavailable = true
      this.input.onFallback?.()
      await copyFileExclusive(this.input.copyFile, source, target)
    }
  }

  async close() {}
}

class MacOsCodexSessionCloner implements CodexSessionCloner {
  private cloneUnavailable = false
  private client: MacOsCloneClient | null = null

  constructor(
    private readonly input: {
      copyFile: SessionCopyFile
      onFallback?: () => void
      spawnProcess: SpawnProcess
    }
  ) {}

  async copy(source: string, target: string) {
    if (this.cloneUnavailable) {
      await copyFileExclusive(this.input.copyFile, source, target)
      return
    }

    try {
      const client = this.client ?? this.createClient()
      this.client = client
      await client.clone(source, target)
    } catch (error) {
      if (!isCopyOnWriteCloneUnavailable(error)) throw error
      if (readErrorCode(error) !== 'EXDEV') {
        this.cloneUnavailable = true
        await this.closeClient({ ignoreUnavailableFailure: true })
      }
      this.input.onFallback?.()
      await copyFileExclusive(this.input.copyFile, source, target)
    }
  }

  async close() {
    await this.closeClient()
  }

  private createClient() {
    try {
      return new MacOsCloneClient(
        this.input.spawnProcess('/usr/bin/ruby', ['-e', MACOS_CLONEFILE_SERVER_SCRIPT], {
          stdio: ['pipe', 'pipe', 'pipe']
        })
      )
    } catch (error) {
      if (readErrorCode(error) === 'ENOENT') {
        throw withErrorCode('macOS clonefile helper is unavailable', 'ERR_MACOS_CLONE_HELPER_UNAVAILABLE')
      }
      throw error
    }
  }

  private async closeClient(options: { ignoreUnavailableFailure?: boolean } = {}) {
    const client = this.client
    this.client = null
    try {
      await client?.close()
    } catch (error) {
      if (options.ignoreUnavailableFailure && isCopyOnWriteCloneUnavailable(error)) return
      throw error
    }
  }
}

class MacOsCloneClient {
  private pending: PendingCloneRequest | null = null
  private failure: Error | null = null
  private closed = false
  private closing = false
  private responseBytes = 0
  private responseText = ''
  private readonly decoder = new StringDecoder('utf8')
  private resolveClosed: (() => void) | null = null
  private readonly closedPromise = new Promise<void>((resolve) => {
    this.resolveClosed = resolve
  })

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => this.readResponseChunk(chunk))
    child.stdout.once('error', (error) => this.fail(error))
    child.stdin.once('error', (error) => this.fail(error))
    child.stderr.once('error', (error) => this.fail(error))
    child.stderr.resume()
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        this.fail(withErrorCode('macOS clonefile helper is unavailable', 'ERR_MACOS_CLONE_HELPER_UNAVAILABLE'))
        return
      }
      this.fail(withErrorCode('macOS clonefile helper failed to start', 'ERR_MACOS_CLONE_PROCESS_FAILED'))
    })
    child.once('close', () => {
      this.closed = true
      if (!this.closing)
        this.fail(withErrorCode('macOS clonefile helper exited unexpectedly', 'ERR_MACOS_CLONE_PROCESS_FAILED'))
      this.resolveClosed?.()
      this.resolveClosed = null
    })
  }

  async clone(source: string, target: string) {
    if (this.failure) throw this.failure
    if (this.closed) throw withErrorCode('macOS clonefile helper is unavailable', 'ERR_MACOS_CLONE_HELPER_UNAVAILABLE')
    if (this.pending) throw new Error('Codex macOS clonefile helper received concurrent copy requests')

    await new Promise<void>((resolve, reject) => {
      const pending: PendingCloneRequest = { resolve, reject }
      pending.timeout = setTimeout(() => {
        this.fail(withErrorCode('macOS clonefile helper request timed out', 'ERR_MACOS_CLONE_PROCESS_FAILED'))
        this.child.kill()
      }, MACOS_CLONE_REQUEST_TIMEOUT_MS)
      this.pending = pending
      const request = `${JSON.stringify({ source, target })}\n`
      this.child.stdin.write(request, 'utf8', (error) => {
        if (error) this.fail(error)
      })
    })
  }

  async close() {
    if (this.closed) {
      if (this.failure) throw this.failure
      return
    }
    this.closing = true
    this.child.stdin.end()
    if (await waitFor(this.closedPromise, MACOS_CLONE_SHUTDOWN_TIMEOUT_MS)) {
      if (this.failure) throw this.failure
      return
    }
    this.child.kill()
    if (await waitFor(this.closedPromise, MACOS_CLONE_SHUTDOWN_TIMEOUT_MS)) {
      if (this.failure) throw this.failure
      return
    }
    throw withErrorCode('macOS clonefile helper did not exit after shutdown', 'ERR_MACOS_CLONE_PROCESS_FAILED')
  }

  private readResponseChunk(chunk: Buffer) {
    if (this.failure) return
    this.responseBytes += chunk.length
    if (this.responseBytes > MACOS_CLONE_RESPONSE_MAX_BYTES) {
      this.fail(
        withErrorCode('macOS clonefile helper returned an oversized response', 'ERR_MACOS_CLONE_PROCESS_FAILED')
      )
      return
    }
    this.responseText += this.decoder.write(chunk)
    for (;;) {
      const lineEnd = this.responseText.indexOf('\n')
      if (lineEnd < 0) return
      const line = this.responseText.slice(0, lineEnd)
      this.responseText = this.responseText.slice(lineEnd + 1)
      this.responseBytes = Buffer.byteLength(this.responseText)
      this.readResponseLine(line)
      if (this.failure) return
    }
  }

  private readResponseLine(line: string) {
    const pending = this.pending
    if (!pending) {
      this.fail(
        withErrorCode('macOS clonefile helper returned an unexpected response', 'ERR_MACOS_CLONE_PROCESS_FAILED')
      )
      return
    }
    let response: unknown
    try {
      response = JSON.parse(line)
    } catch (_) {
      this.fail(withErrorCode('macOS clonefile helper returned invalid JSON', 'ERR_MACOS_CLONE_PROCESS_FAILED'))
      return
    }
    if (isCloneSuccess(response)) {
      this.pending = null
      clearPendingCloneTimeout(pending)
      pending.resolve()
      return
    }
    const errno = readCloneErrno(response)
    if (errno !== null) {
      this.pending = null
      clearPendingCloneTimeout(pending)
      pending.reject(withErrorCode(`macOS clonefile failed: ${systemErrorName(errno)}`, systemErrorName(errno)))
      return
    }
    this.fail(withErrorCode('macOS clonefile helper returned an invalid response', 'ERR_MACOS_CLONE_PROCESS_FAILED'))
  }

  private fail(error: unknown) {
    if (this.failure) return
    this.failure =
      error instanceof Error
        ? error
        : withErrorCode('macOS clonefile helper failed unexpectedly', 'ERR_MACOS_CLONE_PROCESS_FAILED')
    const pending = this.pending
    this.pending = null
    if (pending) clearPendingCloneTimeout(pending)
    pending?.reject(this.failure)
  }
}

type PendingCloneRequest = {
  resolve: () => void
  reject: (error: Error) => void
  timeout?: ReturnType<typeof setTimeout>
}

function clearPendingCloneTimeout(pending: PendingCloneRequest) {
  if (pending.timeout) clearTimeout(pending.timeout)
  pending.timeout = undefined
}

function copyFileExclusive(copy: SessionCopyFile, source: string, target: string) {
  return copy(source, target, constants.COPYFILE_EXCL)
}

function isCloneSuccess(value: unknown) {
  return Boolean(value && typeof value === 'object' && 'ok' in value && value.ok === true)
}

function readCloneErrno(value: unknown) {
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== false || !('errno' in value)) {
    return null
  }
  return typeof value.errno === 'number' && Number.isSafeInteger(value.errno) && value.errno > 0 ? value.errno : null
}

function isCopyOnWriteCloneUnavailable(error: unknown) {
  const code = readErrorCode(error)
  return code !== null && COPY_ON_WRITE_CLONE_UNAVAILABLE_CODES.has(code)
}

function readErrorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') {
    return null
  }
  return error.code
}

function systemErrorName(errno: number) {
  const darwinName = DARWIN_ERRNO_NAMES[errno]
  if (darwinName) return darwinName
  try {
    return getSystemErrorName(-errno)
  } catch (_) {
    return 'ERR_MACOS_CLONE_FAILED'
  }
}

// The helper reports Darwin errno values even when tests or diagnostics run
// under a non-Darwin Node runtime, whose native errno table differs.
const DARWIN_ERRNO_NAMES: Record<number, string> = {
  1: 'EPERM',
  18: 'EXDEV',
  45: 'ENOTSUP',
  78: 'ENOSYS'
}

function withErrorCode(message: string, code: string) {
  return Object.assign(new Error(message), { code })
}

async function waitFor(promise: Promise<void>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([promise.then(() => true), timedOut])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
