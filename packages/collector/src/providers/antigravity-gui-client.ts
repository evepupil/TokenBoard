import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { opendir, stat } from 'node:fs/promises'
import { request } from 'node:https'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { connect as connectTls, type TLSSocket } from 'node:tls'
import { errorMessage } from '../error-message'
import {
  beginAntigravityFileScan,
  listAntigravityDirectoryFileNames,
  markAntigravityFileScanned,
  pruneAntigravityFileScanState,
  readAntigravityFileScanEntry,
  removeAntigravityFileScanEntry,
  selectAntigravityFileScanIds,
  type AntigravityFileScanState
} from './antigravity-file-scan'
import type { AntigravityGuiSource } from './antigravity-gui'

const defaultLanguageServerPath = '/Applications/Antigravity.app/Contents/Resources/bin/language_server'
const apiServerUrl = 'https://generativelanguage.googleapis.com'
const cloudCodeEndpoint = 'https://daily-cloudcode-pa.googleapis.com'
const defaultReadyTimeoutMs = 30_000
const requestTimeoutMs = 60_000
// Real Antigravity metadata responses can include a large but bounded local trajectory.
const maxMetadataResponseBytes = 32 * 1024 * 1024
const readyProbeIntervalMs = 100
const readyProbeTimeoutMs = 1_000
const cascadeIdPattern = /^[0-9a-fA-F-]{8,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{12,}$/
type LanguageServerProcess = ChildProcessByStdio<null, Readable, Readable>

export type AntigravityGeneratorMetadataRequest = {
  source: AntigravityGuiSource
  cascadeId: string
}

export type AntigravityLanguageServerClient = {
  requestGeneratorMetadata: (input: AntigravityGeneratorMetadataRequest) => Promise<unknown>
  close: () => Promise<void>
}

export type AntigravityCascadeRef = {
  id: string
  mtimeMs: number
  size: number
  hasDatabaseFile?: boolean
}

export type AntigravityCascadeFileSystem = {
  listFiles: (path: string) => AsyncIterable<{
    name: string
    isFile: () => boolean
  }>
  stat: (path: string) => Promise<{
    mtimeMs: number
    size: number
  }>
}

const nodeCascadeFileSystem: AntigravityCascadeFileSystem = {
  listFiles: async function* (path: string) {
    const dir = await opendir(path)
    try {
      while (true) {
        const entry = await dir.read()
        if (!entry) break
        yield entry
      }
    } finally {
      await dir.close()
    }
  },
  stat
}

export async function listAntigravityCascadeIds(input: { source: AntigravityGuiSource; conversationDir?: string }) {
  return (await listAntigravityCascades(input)).map((cascade) => cascade.id)
}

export async function listAntigravityCascades(input: {
  source: AntigravityGuiSource
  conversationDir?: string
  limit?: number
  requiredCascadeIds?: Iterable<string>
  includeCascade?: (cascade: AntigravityCascadeRef) => boolean
  compareCascades?: (left: AntigravityCascadeRef, right: AntigravityCascadeRef) => number
  fileSystem?: AntigravityCascadeFileSystem
  scanState?: AntigravityFileScanState
}) {
  const dir = input.conversationDir ?? defaultConversationDir(input.source)
  const fileSystem = input.fileSystem ?? nodeCascadeFileSystem
  const limit = normalizeCascadeLimit(input.limit)
  if (limit === 0) return []
  const compareCascades = input.compareCascades ?? compareRecentCascades
  const scanState = input.scanState ?? { nextSequence: 0, files: {} }
  const checkedSequence = beginAntigravityFileScan(scanState)

  let entries
  try {
    entries = fileSystem.listFiles(dir)
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Antigravity conversations directory not found: ${dir}`)
    }
    throw error
  }

  const cascades: AntigravityCascadeRef[] = []
  const seenIds = new Set<string>()
  const requiredCascades = new Map<string, AntigravityCascadeRef>()
  try {
    for (const id of input.requiredCascadeIds ?? []) {
      if (!cascadeIdPattern.test(id) || seenIds.has(id)) continue
      seenIds.add(id)
      const cascade = await cascadeRef(fileSystem, dir, id)
      if (!cascade) continue
      requiredCascades.set(id, cascade)
      markScanEntry(scanState, cascade, checkedSequence)
    }
    const candidateLimit = directoryCandidateLimit(limit)
    const directoryIds = await listDirectoryCascadeIds(entries, seenIds)
    pruneAntigravityFileScanState(scanState, [...directoryIds, ...requiredCascades.keys()])
    const scanIds = selectAntigravityFileScanIds(directoryIds, scanState, candidateLimit)
    for (const id of scanIds) {
      const cascade = await cascadeRef(fileSystem, dir, id)
      if (cascade) markScanEntry(scanState, cascade, checkedSequence)
      else removeAntigravityFileScanEntry(scanState, id)
    }
    for (const id of directoryIds) {
      const cascade = cachedCascadeRef(scanState, id)
      if (!cascade || (input.includeCascade && !input.includeCascade(cascade))) continue
      pushPreferredCascade(cascades, cascade, limit, compareCascades)
    }
    for (const [id, cascade] of requiredCascades) {
      if (directoryIds.includes(id)) continue
      if (input.includeCascade && !input.includeCascade(cascade)) continue
      pushPreferredCascade(cascades, cascade, limit, compareCascades)
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Antigravity conversations directory not found: ${dir}`)
    }
    throw error
  }
  cascades.sort(compareCascades)

  if (cascades.length === 0 && Object.keys(scanState.files).length === 0) {
    throw new Error(`No Antigravity conversations found in ${dir}`)
  }
  return cascades
}

async function listDirectoryCascadeIds(
  entries: AsyncIterable<{ name: string; isFile: () => boolean }>,
  excludedIds: ReadonlySet<string>
) {
  const ids: string[] = []
  const listedIds = new Set<string>()
  for (const name of await listAntigravityDirectoryFileNames(entries)) {
    const id = cascadeIdFromFile(name)
    if (!id || excludedIds.has(id) || listedIds.has(id)) continue
    listedIds.add(id)
    ids.push(id)
  }
  return ids
}

function directoryCandidateLimit(limit: number) {
  if (limit === Number.POSITIVE_INFINITY) return limit
  return Math.max(64, limit * 20)
}

function markScanEntry(state: AntigravityFileScanState, cascade: AntigravityCascadeRef, checkedSequence: number) {
  markAntigravityFileScanned(
    state,
    cascade.id,
    {
      mtimeMs: cascade.mtimeMs,
      size: cascade.size,
      hasDatabaseFile: cascade.hasDatabaseFile === true
    },
    checkedSequence
  )
}

function cachedCascadeRef(state: AntigravityFileScanState, id: string): AntigravityCascadeRef | null {
  const entry = readAntigravityFileScanEntry(state, id)
  if (!entry) return null
  return {
    id,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    hasDatabaseFile: entry.hasDatabaseFile
  }
}

function compareRecentCascades(left: AntigravityCascadeRef, right: AntigravityCascadeRef) {
  if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs
  return left.id.localeCompare(right.id)
}

function pushPreferredCascade(
  cascades: AntigravityCascadeRef[],
  cascade: AntigravityCascadeRef,
  limit: number,
  compareCascades: (left: AntigravityCascadeRef, right: AntigravityCascadeRef) => number
) {
  if (limit === Number.POSITIVE_INFINITY || cascades.length < limit) {
    cascades.push(cascade)
    return
  }
  const lowestPriorityIndex = cascades.reduce((selected, current, index) => {
    const lowestPriority = cascades[selected]
    return compareCascades(current, lowestPriority) > 0 ? index : selected
  }, 0)
  if (compareCascades(cascade, cascades[lowestPriorityIndex]) < 0) {
    cascades[lowestPriorityIndex] = cascade
  }
}

export async function createAntigravityLanguageServerClient(input: {
  source: AntigravityGuiSource
  languageServerPath?: string
  overrideIdeVersion?: string
  port?: number
}): Promise<AntigravityLanguageServerClient> {
  const port = input.port ?? (await allocatePort())
  const csrfToken = randomBytes(16).toString('hex')
  const server = spawnLanguageServer({ ...input, port, csrfToken })
  try {
    await waitForReady(server, port)
  } catch (error) {
    await closeLanguageServer(server)
    throw error
  }
  return {
    requestGeneratorMetadata: (requestInput) => requestGeneratorMetadata({ ...requestInput, port, csrfToken }),
    close: () => closeLanguageServer(server)
  }
}

function spawnLanguageServer(input: {
  source: AntigravityGuiSource
  languageServerPath?: string
  overrideIdeVersion?: string
  port: number
  csrfToken: string
}) {
  const languageServerPath =
    input.languageServerPath ?? process.env.TOKENBOARD_ANTIGRAVITY_LANGUAGE_SERVER ?? defaultLanguageServerPath
  const args = [
    '--standalone',
    '--override_ide_name',
    input.source,
    '--subclient_type',
    input.source === 'antigravity-ide' ? 'ide' : 'hub',
    '--override_ide_version',
    input.overrideIdeVersion ?? '0.0.0',
    '--override_user_agent_name',
    input.source,
    '--https_server_port',
    String(input.port),
    '--csrf_token',
    input.csrfToken,
    '--app_data_dir',
    input.source,
    '--api_server_url',
    apiServerUrl,
    '--cloud_code_endpoint',
    cloudCodeEndpoint,
    '--enable_sidecars',
    '--headless'
  ]
  return spawn(languageServerPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
}

export function waitForReady(
  server: LanguageServerProcess,
  port: number,
  probe: (port: number) => Promise<void> = probeLanguageServerEndpoint
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let probing = false
    let probeTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(
      () => rejectStartup(`Timed out starting Antigravity language server on port ${port}`),
      readReadyTimeoutMs()
    )
    const onError = (error: Error) => {
      finish(() => reject(error))
    }
    const onExit = () => rejectStartup('Antigravity language server exited before it was ready')
    const rejectStartup = (message: string) => {
      finish(() => reject(new Error(message)))
    }
    const probeEndpoint = () => {
      if (settled || probing) return
      if (server.exitCode !== null || server.signalCode !== null) {
        rejectStartup('Antigravity language server exited before it was ready')
        return
      }
      probing = true
      probe(port).then(
        () => {
          probing = false
          if (server.exitCode !== null || server.signalCode !== null) {
            rejectStartup('Antigravity language server exited before it was ready')
            return
          }
          finish(resolve)
        },
        () => {
          probing = false
          if (!settled) probeTimer = setTimeout(probeEndpoint, readyProbeIntervalMs)
        }
      )
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const cleanup = () => {
      clearTimeout(timer)
      if (probeTimer) clearTimeout(probeTimer)
      server.off('error', onError)
      server.off('exit', onExit)
      drainOutput(server)
    }
    server.once('error', onError)
    server.once('exit', onExit)
    drainOutput(server)
    probeEndpoint()
  })
}

function probeLanguageServerEndpoint(port: number) {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let socket: TLSSocket | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.off('secureConnect', onSecureConnect)
      socket?.off('error', onError)
      socket?.off('timeout', onTimeout)
      socket?.destroy()
      if (error) reject(error)
      else resolve()
    }
    const onSecureConnect = () => finish()
    const onError = (error: Error) => finish(error)
    const onTimeout = () => finish(new Error('Antigravity language server readiness probe timed out'))
    const timer = setTimeout(onTimeout, readyProbeTimeoutMs)
    try {
      socket = connectTls({
        host: '127.0.0.1',
        port,
        rejectUnauthorized: false
      })
      socket.once('secureConnect', onSecureConnect)
      socket.once('error', onError)
      socket.once('timeout', onTimeout)
      socket.setTimeout(readyProbeTimeoutMs)
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Antigravity language server readiness probe failed'))
    }
  })
}

function readReadyTimeoutMs() {
  const value = Number.parseInt(process.env.TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS || '', 10)
  return Number.isFinite(value) && value > 0 ? value : defaultReadyTimeoutMs
}

function drainOutput(server: LanguageServerProcess) {
  server.stdout.resume()
  server.stderr.resume()
}

export function requestGeneratorMetadata(
  input: AntigravityGeneratorMetadataRequest & { port: number; csrfToken: string }
) {
  const body = JSON.stringify({ cascadeId: input.cascadeId })
  return new Promise<unknown>((resolve, reject) => {
    let settled = false
    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const resolveOnce = (value: unknown) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = request(
      {
        hostname: '127.0.0.1',
        port: input.port,
        path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata',
        method: 'POST',
        rejectUnauthorized: false,
        timeout: requestTimeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': input.csrfToken
        }
      },
      (res) => {
        const responseError = (error: unknown) => {
          rejectOnce(new Error(formatMetadataRequestTransportError(input.source, error)))
        }
        res.once('error', responseError)
        res.once('aborted', () => responseError(new Error('response aborted')))
        if (res.statusCode !== 200) {
          rejectOnce(new Error(formatMetadataRequestHttpError(input.source, res.statusCode)))
          res.destroy()
          return
        }
        const chunks: Buffer[] = []
        let receivedBytes = 0
        res.on('data', (chunk) => {
          if (settled) return
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          receivedBytes += buffer.byteLength
          if (receivedBytes > maxMetadataResponseBytes) {
            chunks.length = 0
            rejectOnce(new Error(formatMetadataResponseLimitError(input.source)))
            res.destroy()
            return
          }
          chunks.push(buffer)
        })
        res.on('end', () => {
          if (settled) return
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolveOnce(JSON.parse(text))
          } catch {
            rejectOnce(new Error(`Antigravity metadata request returned invalid JSON for ${input.source}`))
          }
        })
      }
    )
    req.on('timeout', () => {
      rejectOnce(new Error(`Antigravity metadata request timed out for ${input.source}`))
      req.destroy()
    })
    req.on('error', (error) => rejectOnce(new Error(formatMetadataRequestTransportError(input.source, error))))
    req.end(body)
  })
}

function formatMetadataResponseLimitError(source: AntigravityGuiSource) {
  return `Antigravity metadata response exceeded the ${maxMetadataResponseBytes}-byte limit for ${source}`
}

export function formatMetadataRequestHttpError(source: AntigravityGuiSource, statusCode?: number) {
  return `Antigravity metadata request failed for ${source}: HTTP ${statusCode ?? 'unknown'}`
}

export function formatMetadataRequestTransportError(source: AntigravityGuiSource, error: unknown) {
  return `Antigravity metadata request transport failed for ${source}: ${errorMessage(error)}`
}

async function closeLanguageServer(server: LanguageServerProcess) {
  if (server.exitCode !== null || server.killed) return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.off('error', finish)
      server.off('exit', finish)
      resolve()
    }
    const timer = setTimeout(() => {
      server.kill('SIGKILL')
      finish()
    }, 2_000)
    server.once('error', finish)
    server.once('exit', finish)
    if (!server.kill('SIGTERM')) finish()
  })
}

function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address) resolve(address.port)
        else reject(new Error('Failed to allocate local Antigravity language server port'))
      })
    })
  })
}

function defaultConversationDir(source: AntigravityGuiSource) {
  return join(homedir(), '.gemini', source, 'conversations')
}

function cascadeIdFromFile(name: string) {
  const ext = extname(name)
  if (ext !== '.pb' && ext !== '.db') return null
  const id = basename(name, ext)
  return cascadeIdPattern.test(id) ? id : null
}

function normalizeCascadeLimit(value: number | undefined) {
  if (value === undefined) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(value) || value < 0) return Number.POSITIVE_INFINITY
  return Math.floor(value)
}

async function cascadeRef(
  fileSystem: AntigravityCascadeFileSystem,
  dir: string,
  id: string
): Promise<AntigravityCascadeRef | null> {
  const refs = await Promise.all([
    fileRef(fileSystem, id, join(dir, `${id}.pb`)),
    fileRef(fileSystem, id, join(dir, `${id}.db`))
  ])
  const existingRefs = refs.filter((ref): ref is AntigravityCascadeRef => Boolean(ref))
  if (existingRefs.length === 0) return null
  const latest = existingRefs.reduce((selected, ref) => (ref.mtimeMs > selected.mtimeMs ? ref : selected))
  return { ...latest, hasDatabaseFile: Boolean(refs[1]) }
}

async function fileRef(
  fileSystem: AntigravityCascadeFileSystem,
  id: string,
  filePath: string
): Promise<AntigravityCascadeRef | null> {
  try {
    const info = await fileSystem.stat(filePath)
    return { id, mtimeMs: info.mtimeMs, size: info.size }
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
