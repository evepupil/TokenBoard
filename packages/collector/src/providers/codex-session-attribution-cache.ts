import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertValidIsoCalendarDate } from '../iso-calendar-date'
import { assertCursorWriteOwnership, withCursorLock } from './session-cursor-store'

const cacheFileName = 'codex-session-attribution-cache.json'
const cacheVersion = 1
const tailBytes = 64 * 1024
const cacheRetentionMs = 180 * 24 * 60 * 60 * 1000
const maxCacheEntries = 20_000
const maxCacheBytes = 8 * 1024 * 1024
const maxModelLength = 512

export type CodexSessionAttribution = {
  usageDate: string
  model: string
}

export type CodexSessionFileMetadata = {
  size: number
  mtimeMs: number
  ctimeMs: number
}

export type CodexSessionFileFingerprint = CodexSessionFileMetadata & {
  dev: number
  ino: number
  tailSha256: string
}

type ComparableCodexSessionFileFingerprint = CodexSessionFileMetadata & {
  dev?: number
  ino?: number
  tailSha256: string
}

type CacheEntry = ComparableCodexSessionFileFingerprint &
  CodexSessionAttribution & {
    updatedAt: string
  }

type CacheState = {
  version: typeof cacheVersion
  timezone: string
  entries: Record<string, CacheEntry>
}

export type CodexSessionAttributionCache = {
  isEmpty: () => boolean
  lookup: (filePath: string) => Promise<{
    fingerprint: CodexSessionFileFingerprint
    attribution: CodexSessionAttribution | null
  }>
  lookupByFingerprint: (input: {
    filePath: string
    fingerprint: CodexSessionFileFingerprint
  }) => CodexSessionAttribution | null
  store: (input: {
    filePath: string
    fingerprint: CodexSessionFileFingerprint
    attribution: CodexSessionAttribution
  }) => Promise<void>
  storeIfUnchanged: (input: {
    filePath: string
    fingerprint: CodexSessionFileFingerprint
    attribution: CodexSessionAttribution
  }) => Promise<boolean>
}

export async function withCodexSessionAttributionCache<T>(input: {
  stateDir: string
  timezone: string
  callback: (cache: CodexSessionAttributionCache) => Promise<T>
}): Promise<T> {
  const cachePath = join(input.stateDir, cacheFileName)
  return withCursorLock(cachePath, async () => {
    const updatedAt = new Date().toISOString()
    const cache = await readCache(cachePath, input.timezone)
    const usedKeys = new Set<string>()
    const observedFiles = new Map<string, { filePath: string; fingerprint: CodexSessionFileFingerprint }>()
    const api: CodexSessionAttributionCache = {
      isEmpty: () => Object.keys(cache.entries).length === 0,
      lookup: async (filePath) => {
        const key = cacheKey(filePath)
        usedKeys.add(key)
        const fingerprint = await fingerprintCodexSessionFile(filePath)
        observedFiles.set(key, { filePath, fingerprint })
        const entry = cache.entries[key]
        if (!entry || !sameCodexSessionFileFingerprint(entry, fingerprint)) {
          return { fingerprint, attribution: null }
        }
        entry.updatedAt = updatedAt
        return {
          fingerprint,
          attribution: { usageDate: entry.usageDate, model: entry.model }
        }
      },
      lookupByFingerprint: ({ filePath, fingerprint }) => {
        const key = cacheKey(filePath)
        usedKeys.add(key)
        const entry = cache.entries[key]
        if (!entry || !sameCodexSessionFileFingerprint(entry, fingerprint)) return null
        entry.updatedAt = updatedAt
        return { usageDate: entry.usageDate, model: entry.model }
      },
      store: async ({ filePath, fingerprint, attribution }) => {
        assertAttribution(attribution)
        const current = await fingerprintObservedCodexSessionFile(filePath)
        if (!sameCodexSessionFileFingerprint(fingerprint, current)) {
          throw new Error('Codex session changed while resolving canonical attribution; retry the sync')
        }
        const key = cacheKey(filePath)
        usedKeys.add(key)
        observedFiles.set(key, { filePath, fingerprint: current })
        cache.entries[key] = { ...current, ...attribution, updatedAt }
      },
      storeIfUnchanged: async ({ filePath, fingerprint, attribution }) => {
        assertAttribution(attribution)
        const current = await fingerprintCodexSessionFile(filePath).catch((error) => {
          if (isMissingCodexSessionFileError(error) || isCodexSessionFingerprintRaceError(error)) {
            return null
          }
          throw error
        })
        if (!current) return false
        if (!sameCodexSessionFileFingerprint(fingerprint, current)) return false
        const key = cacheKey(filePath)
        usedKeys.add(key)
        cache.entries[key] = { ...current, ...attribution, updatedAt }
        return true
      }
    }
    const result = await input.callback(api)
    await assertObservedFilesUnchanged(observedFiles)
    cache.entries = retainCacheEntries(cache.entries, usedKeys, Date.parse(updatedAt), cache.timezone)
    await writeCache(cachePath, cache)
    return result
  })
}

async function assertObservedFilesUnchanged(
  observedFiles: ReadonlyMap<string, { filePath: string; fingerprint: CodexSessionFileFingerprint }>
) {
  for (const { filePath, fingerprint } of observedFiles.values()) {
    const current = await fingerprintObservedCodexSessionFile(filePath)
    if (!sameCodexSessionFileFingerprint(fingerprint, current)) {
      throw new Error('Codex session changed while resolving canonical attribution; retry the sync')
    }
  }
}

async function fingerprintObservedCodexSessionFile(filePath: string) {
  try {
    return await fingerprintCodexSessionFile(filePath)
  } catch (error) {
    if (isMissingCodexSessionFileError(error)) {
      throw new Error('Codex session changed while resolving canonical attribution; retry the sync', {
        cause: error
      })
    }
    throw error
  }
}

export async function readCodexSessionFileMetadata(filePath: string): Promise<CodexSessionFileMetadata> {
  try {
    const details = await lstat(filePath)
    assertCodexSessionFileAtPath(details)
    return {
      size: details.size,
      mtimeMs: details.mtimeMs,
      ctimeMs: details.ctimeMs
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unable to inspect Codex session file:')) {
      throw error
    }
    throw new Error('Unable to inspect Codex session file', { cause: error })
  }
}

export async function fingerprintCodexSessionFile(filePath: string): Promise<CodexSessionFileFingerprint> {
  try {
    const pathBefore = await lstat(filePath)
    assertCodexSessionFileAtPath(pathBefore)
    const handle = await open(filePath, 'r')
    try {
      const [opened, pathAfterOpen] = await Promise.all([handle.stat(), lstat(filePath)])
      assertCodexSessionFileAtPath(pathAfterOpen)
      if (!sameCodexSessionFileIdentity(pathBefore, opened) || !sameCodexSessionFileIdentity(pathAfterOpen, opened)) {
        throw new Error('Codex session changed while fingerprinting; retry the sync')
      }

      const tailSha256 = await hashOpenFileTail(handle, opened.size)
      const [after, pathAfterRead] = await Promise.all([handle.stat(), lstat(filePath)])
      assertCodexSessionFileAtPath(pathAfterRead)
      if (!sameCodexSessionFileIdentity(opened, after) || !sameCodexSessionFileIdentity(pathAfterRead, opened)) {
        throw new Error('Codex session changed while fingerprinting; retry the sync')
      }
      return {
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        ctimeMs: opened.ctimeMs,
        tailSha256
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('Unable to inspect Codex session file:') ||
        error.message.startsWith('Codex session changed while fingerprinting;'))
    ) {
      throw error
    }
    throw new Error('Unable to inspect Codex session file', { cause: error })
  }
}

export function sameCodexSessionFileMetadata(left: CodexSessionFileMetadata, right: CodexSessionFileMetadata) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

export function sameCodexSessionFileFingerprint(
  left: ComparableCodexSessionFileFingerprint,
  right: CodexSessionFileFingerprint
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    sameCodexSessionFileMetadata(left, right) &&
    left.tailSha256 === right.tailSha256
  )
}

function assertCodexSessionFileAtPath(details: { isFile: () => boolean; isSymbolicLink: () => boolean }) {
  if (details.isSymbolicLink()) {
    throw new Error('Unable to inspect Codex session file: symbolic links are not supported')
  }
  if (!details.isFile()) {
    throw new Error('Unable to inspect Codex session file: path is not a file')
  }
}

function sameCodexSessionFileIdentity(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function hashOpenFileTail(handle: Awaited<ReturnType<typeof open>>, size: number) {
  const length = Math.min(size, tailBytes)
  const buffer = Buffer.alloc(length)
  const start = Math.max(0, size - length)
  let offset = 0
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, start + offset)
    if (result.bytesRead === 0) {
      throw new Error('Codex session changed while fingerprinting; retry the sync')
    }
    offset += result.bytesRead
  }
  return createHash('sha256').update(buffer).digest('hex')
}

async function readCache(cachePath: string, timezone: string): Promise<CacheState> {
  try {
    const parsed = JSON.parse(await readBoundedCacheFile(cachePath)) as unknown
    if (!isCacheState(parsed)) throw new Error('Invalid Codex session attribution cache')
    if (parsed.timezone !== timezone) return emptyCache(timezone)
    return parsed
  } catch (error) {
    if (isMissingFileError(error)) return emptyCache(timezone)
    if (error instanceof SyntaxError) throw new Error('Invalid Codex session attribution cache JSON')
    throw error
  }
}

async function readBoundedCacheFile(cachePath: string) {
  const handle = await open(cachePath, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('Invalid Codex session attribution cache')
    if (before.size > maxCacheBytes) {
      throw new Error('Codex session attribution cache exceeds the ' + maxCacheBytes + '-byte limit')
    }
    const buffer = Buffer.alloc(before.size)
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (result.bytesRead === 0) {
        throw new Error('Codex session attribution cache changed while reading; retry the sync')
      }
      offset += result.bytesRead
    }
    const after = await handle.stat()
    if (!sameCodexSessionFileMetadata(before, after)) {
      throw new Error('Codex session attribution cache changed while reading; retry the sync')
    }
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function writeCache(cachePath: string, cache: CacheState) {
  const serialized = JSON.stringify(cache) + '\n'
  if (Buffer.byteLength(serialized) > maxCacheBytes) {
    throw new Error('Codex session attribution cache exceeds the ' + maxCacheBytes + '-byte limit')
  }
  await mkdir(dirname(cachePath), { recursive: true })
  const tempPath = cachePath + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex')
  try {
    await writeFile(tempPath, serialized, { mode: 0o600 })
    await assertCursorWriteOwnership(cachePath)
    await rename(tempPath, cachePath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

function emptyCache(timezone: string): CacheState {
  return { version: cacheVersion, timezone, entries: {} }
}

export function retainCacheEntries(
  entries: Record<string, CacheEntry>,
  usedKeys: ReadonlySet<string>,
  nowMs: number,
  timezone: string
) {
  const cutoffMs = nowMs - cacheRetentionMs
  const used: Array<[string, CacheEntry]> = []
  const recent: Array<[string, CacheEntry]> = []
  for (const entry of Object.entries(entries)) {
    const [key, value] = entry
    if (usedKeys.has(key)) {
      used.push(entry)
      continue
    }
    const updatedAtMs = Date.parse(value.updatedAt)
    if (Number.isFinite(updatedAtMs) && updatedAtMs >= cutoffMs) {
      recent.push(entry)
    }
  }
  const newestFirst = (left: [string, CacheEntry], right: [string, CacheEntry]) =>
    Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt) || left[0].localeCompare(right[0])
  used.sort(newestFirst)
  recent.sort(newestFirst)
  const selected = [
    ...used.slice(0, maxCacheEntries),
    ...recent.slice(0, Math.max(0, maxCacheEntries - Math.min(used.length, maxCacheEntries)))
  ]
  return Object.fromEntries(trimCacheEntriesToSerializedSize(selected, timezone))
}

function trimCacheEntriesToSerializedSize(entries: Array<[string, CacheEntry]>, timezone: string) {
  const serializedEntries = entries.map(([key, entry]) => ({
    entry: [key, entry] as [string, CacheEntry],
    bytes: Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(entry)}`)
  }))
  let serializedBytes = Buffer.byteLength(
    `{"version":${cacheVersion},"timezone":${JSON.stringify(timezone)},"entries":{` + '}}\n'
  )
  serializedBytes += serializedEntries.reduce((total, item) => total + item.bytes, 0)
  serializedBytes += Math.max(0, serializedEntries.length - 1)

  while (serializedBytes > maxCacheBytes && serializedEntries.length > 0) {
    const removed = serializedEntries.pop()!
    serializedBytes -= removed.bytes
    if (serializedEntries.length > 0) serializedBytes -= 1
  }
  return serializedEntries.map((item) => item.entry)
}

function cacheKey(filePath: string) {
  return createHash('sha256').update(filePath).digest('hex')
}

function assertAttribution(attribution: CodexSessionAttribution) {
  assertValidIsoCalendarDate(attribution.usageDate, 'Invalid Codex canonical session date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(attribution.usageDate)) {
    throw new Error('Invalid Codex canonical session date')
  }
  if (!attribution.model || attribution.model.length > maxModelLength) {
    throw new Error('Invalid Codex canonical session model')
  }
}

function isCacheState(value: unknown): value is CacheState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<CacheState>
  return (
    candidate.version === cacheVersion &&
    typeof candidate.timezone === 'string' &&
    Boolean(candidate.entries) &&
    typeof candidate.entries === 'object' &&
    !Array.isArray(candidate.entries) &&
    Object.entries(candidate.entries).every(([key, entry]) => isCacheKey(key) && isCacheEntry(entry))
  )
}

function isCacheKey(value: string) {
  return /^[a-f0-9]{64}$/.test(value)
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<CacheEntry>
  if (
    !isFiniteNumber(candidate.size) ||
    (candidate.dev !== undefined && !isFiniteNumber(candidate.dev)) ||
    (candidate.ino !== undefined && !isFiniteNumber(candidate.ino)) ||
    !isFiniteNumber(candidate.mtimeMs) ||
    !isFiniteNumber(candidate.ctimeMs) ||
    !isSha256(candidate.tailSha256) ||
    typeof candidate.updatedAt !== 'string' ||
    typeof candidate.usageDate !== 'string' ||
    typeof candidate.model !== 'string'
  ) {
    return false
  }
  try {
    assertAttribution({ usageDate: candidate.usageDate, model: candidate.model })
    return Number.isFinite(Date.parse(candidate.updatedAt))
  } catch {
    return false
  }
}

function isFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isSha256(value: unknown) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isMissingCodexSessionFileError(error: unknown) {
  return isMissingFileError(error) || (error instanceof Error && isMissingFileError(error.cause))
}

function isCodexSessionFingerprintRaceError(error: unknown) {
  return error instanceof Error && error.message.startsWith('Codex session changed while fingerprinting;')
}
