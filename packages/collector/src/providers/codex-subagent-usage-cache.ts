import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertCursorWriteOwnership, withCursorLock } from './session-cursor-store'
import {
  fingerprintCodexSessionFile,
  sameCodexSessionFileFingerprint,
  type CodexSessionFileFingerprint
} from './codex-session-attribution-cache'
import { readChildLastUsageEvents, type ChildUsageEvent, type DatedUsage } from './codex-subagent-usage-child'

const cacheFileName = 'codex-subagent-usage-cache.json'
const cacheVersion = 1
const tailBytes = 64 * 1024
const cacheRetentionMs = 90 * 24 * 60 * 60 * 1000
const maxCacheEntries = 2_000
const maxCacheBytes = 8 * 1024 * 1024
const stableReadAttempts = 2

export type ReadChildUsageByDate = (
  filePath: string,
  timestamp: string,
  timezone: string,
  stderr?: (line: string) => void,
  sourceFilePath?: string
) => Promise<DatedUsage[]>

export type ReadChildUsageEvents = (
  filePath: string,
  timestamp: string,
  timezone: string,
  stderr?: (line: string) => void,
  sourceFilePath?: string
) => Promise<ChildUsageEvent[]>

type FileFingerprint = {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  tailSha256: string
}

type CacheEntry = Omit<FileFingerprint, 'dev' | 'ino' | 'ctimeMs'> & {
  // Entries written before file identity tracking are safely recomputed on first use.
  dev?: number
  ino?: number
  ctimeMs?: number
  updatedAt?: string
  usages: DatedUsage[]
}

type SerializedDatedUsage = Omit<DatedUsage, 'cacheCreationTokens'> & {
  cacheCreationTokens?: number
}

type SerializedCacheEntry = Omit<CacheEntry, 'usages'> & {
  usages: SerializedDatedUsage[]
}

type ComparableFingerprint = Pick<FileFingerprint, 'size' | 'mtimeMs' | 'tailSha256'> & {
  dev?: number
  ino?: number
  ctimeMs?: number
}

type CacheState = {
  version: typeof cacheVersion
  timezone: string
  entries: Record<string, CacheEntry>
}

type SerializedCacheState = Omit<CacheState, 'entries'> & {
  entries: Record<string, SerializedCacheEntry>
}

type CacheReader = {
  read: ReadChildUsageByDate
  readEvents: ReadChildUsageEvents
}

export type CodexSubagentUsageCacheFile = {
  sourceFile: string
  sourceFingerprint: CodexSessionFileFingerprint
}

export async function withCodexSubagentUsageCache<T>(input: {
  stateDir?: string
  timezone: string
  readChildUsageByDate: ReadChildUsageByDate
  readChildUsageEvents?: ReadChildUsageEvents
  cacheFiles?: ReadonlyMap<string, CodexSubagentUsageCacheFile>
  callback: (reader: CacheReader) => Promise<T>
}): Promise<T> {
  const readChildUsageEvents = input.readChildUsageEvents ?? readChildLastUsageEvents
  if (!input.stateDir) {
    return input.callback({
      read: input.readChildUsageByDate,
      readEvents: readChildUsageEvents
    })
  }

  const cachePath = join(input.stateDir, cacheFileName)
  return withCursorLock(cachePath, async () => {
    const updatedAt = new Date().toISOString()
    const cache = await readCache(cachePath, input.timezone, updatedAt)
    const usedKeys = new Set<string>()
    const reader: CacheReader = {
      read: async (filePath, timestamp, timezone, stderr, sourceFilePath) => {
        const cacheFile =
          input.cacheFiles?.get(filePath) ?? (sourceFilePath ? input.cacheFiles?.get(sourceFilePath) : undefined)
        const key = cacheKey(cacheFile?.sourceFile ?? sourceFilePath ?? filePath)
        usedKeys.add(key)
        const before = await fingerprintFile(filePath)
        if (cacheFile) assertFrozenCacheFile(before, cacheFile.sourceFingerprint)
        const cacheFingerprint = cacheFile?.sourceFingerprint ?? before
        const cached = cache.entries[key]
        if (cached && sameFingerprint(cached, cacheFingerprint)) {
          cached.updatedAt = updatedAt
          return cached.usages.map(copyUsage)
        }

        const stable = await readStableChildUsage({
          filePath,
          timestamp,
          timezone,
          stderr,
          read: input.readChildUsageByDate,
          firstFingerprint: before
        })
        if (cacheFile) {
          assertFrozenCacheFile(stable.fingerprint, cacheFile.sourceFingerprint)
          if (await sourceStillMatches(cacheFile)) {
            cache.entries[key] = {
              ...cacheFile.sourceFingerprint,
              usages: stable.usages.map(copyUsage),
              updatedAt
            }
          } else {
            stderr?.('Skipping stale Codex subagent usage cache write for a session that changed after copy')
          }
        } else {
          cache.entries[key] = { ...stable.fingerprint, usages: stable.usages.map(copyUsage), updatedAt }
        }
        return stable.usages
      },
      readEvents: async (filePath, timestamp, timezone, stderr, sourceFilePath) => {
        const cacheFile =
          input.cacheFiles?.get(filePath) ?? (sourceFilePath ? input.cacheFiles?.get(sourceFilePath) : undefined)
        const before = await fingerprintFile(filePath)
        if (cacheFile) assertFrozenCacheFile(before, cacheFile.sourceFingerprint)
        const stable = await readStableChildUsage({
          filePath,
          timestamp,
          timezone,
          stderr,
          read: readChildUsageEvents,
          firstFingerprint: before
        })
        if (cacheFile) assertFrozenCacheFile(stable.fingerprint, cacheFile.sourceFingerprint)
        return stable.usages.map(copyChildUsageEvent)
      }
    }
    const result = await input.callback(reader)
    cache.entries = retainCacheEntries(cache.entries, usedKeys, Date.parse(updatedAt))
    await writeCache(cachePath, cache)
    return result
  })
}

function assertFrozenCacheFile(frozen: FileFingerprint, source: CodexSessionFileFingerprint) {
  if (frozen.size !== source.size || frozen.tailSha256 !== source.tailSha256) {
    throw new Error('Codex frozen child session does not match its copy-time fingerprint')
  }
}

async function sourceStillMatches(cacheFile: CodexSubagentUsageCacheFile) {
  try {
    const current = await fingerprintCodexSessionFile(cacheFile.sourceFile)
    return sameCodexSessionFileFingerprint(cacheFile.sourceFingerprint, current)
  } catch (error) {
    if (isMissingSourceFileError(error)) return false
    throw error
  }
}

async function readStableChildUsage<T>(input: {
  filePath: string
  timestamp: string
  timezone: string
  stderr?: (line: string) => void
  read: (filePath: string, timestamp: string, timezone: string, stderr?: (line: string) => void) => Promise<T>
  firstFingerprint: FileFingerprint
}) {
  let before = input.firstFingerprint
  for (let attempt = 0; attempt < stableReadAttempts; attempt += 1) {
    const usages = await input.read(input.filePath, input.timestamp, input.timezone, input.stderr)
    const after = await fingerprintFile(input.filePath)
    if (sameFingerprint(before, after)) {
      return { fingerprint: after, usages }
    }
    before = after
  }
  throw new Error('Codex child session changed while correcting; retry the sync')
}

async function readCache(cachePath: string, timezone: string, fallbackUpdatedAt: string): Promise<CacheState> {
  try {
    const parsed = JSON.parse(await readBoundedCacheFile(cachePath)) as unknown
    if (!isSerializedCacheState(parsed)) {
      throw new Error('Invalid Codex subagent usage cache')
    }
    const cache = normalizeCacheState(parsed)
    if (cache.timezone !== timezone) return emptyCache(timezone)
    return {
      ...cache,
      entries: Object.fromEntries(
        Object.entries(cache.entries).map(([key, entry]) => [
          key,
          entry.updatedAt ? entry : { ...entry, updatedAt: fallbackUpdatedAt }
        ])
      )
    }
  } catch (error) {
    if (isMissingFileError(error)) return emptyCache(timezone)
    if (error instanceof SyntaxError) throw new Error('Invalid Codex subagent usage cache JSON')
    throw error
  }
}

async function readBoundedCacheFile(cachePath: string) {
  const handle = await open(cachePath, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('Invalid Codex subagent usage cache')
    if (before.size > maxCacheBytes) {
      throw new Error(`Codex subagent usage cache exceeds the ${maxCacheBytes}-byte limit`)
    }

    const buffer = Buffer.alloc(before.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) throw new Error('Codex subagent usage cache changed while reading; retry the sync')
      offset += bytesRead
    }

    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('Codex subagent usage cache changed while reading; retry the sync')
    }
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function writeCache(cachePath: string, cache: CacheState) {
  const serialized = `${JSON.stringify(cache, null, 2)}\n`
  if (Buffer.byteLength(serialized) > maxCacheBytes) {
    throw new Error(`Codex subagent usage cache exceeds the ${maxCacheBytes}-byte limit`)
  }
  await mkdir(dirname(cachePath), { recursive: true })
  const tempPath = `${cachePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    await writeFile(tempPath, serialized, { mode: 0o600 })
    await assertCursorWriteOwnership(cachePath)
    await rename(tempPath, cachePath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

async function fingerprintFile(filePath: string): Promise<FileFingerprint> {
  try {
    const pathBefore = await lstat(filePath)
    assertFingerprintableChildSession(pathBefore)
    const handle = await open(filePath, 'r')
    try {
      const [opened, pathAfterOpen] = await Promise.all([handle.stat(), lstat(filePath)])
      assertFingerprintableChildSession(pathAfterOpen)
      if (!sameChildSessionIdentity(pathBefore, opened) || !sameChildSessionIdentity(pathAfterOpen, opened)) {
        throw new Error('Codex child session changed while fingerprinting; retry the sync')
      }

      const tailSha256 = await hashOpenFileTail(handle, opened.size)
      const [after, pathAfterRead] = await Promise.all([handle.stat(), lstat(filePath)])
      assertFingerprintableChildSession(pathAfterRead)
      if (!sameChildSessionIdentity(opened, after) || !sameChildSessionIdentity(pathAfterRead, opened)) {
        throw new Error('Codex child session changed while fingerprinting; retry the sync')
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
      (error.message.startsWith('Unable to fingerprint Codex child session:') ||
        error.message.startsWith('Codex child session changed while fingerprinting;'))
    ) {
      throw error
    }
    throw new Error('Unable to fingerprint Codex child session', { cause: error })
  }
}

function assertFingerprintableChildSession(details: {
  dev: number
  ino: number
  isFile: () => boolean
  isSymbolicLink: () => boolean
}) {
  if (details.isSymbolicLink()) {
    throw new Error('Unable to fingerprint Codex child session: symbolic links are not supported')
  }
  if (!details.isFile()) {
    throw new Error('Unable to fingerprint Codex child session: path is not a file')
  }
}

function sameChildSessionIdentity(
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
  const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, size - length))
  return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
}

function emptyCache(timezone: string): CacheState {
  return { version: cacheVersion, timezone, entries: {} }
}

function cacheKey(filePath: string) {
  return createHash('sha256').update(filePath).digest('hex')
}

function sameFingerprint(left: ComparableFingerprint, right: FileFingerprint) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.tailSha256 === right.tailSha256
  )
}

export function retainCacheEntries(entries: Record<string, CacheEntry>, usedKeys: ReadonlySet<string>, nowMs: number) {
  const cutoffMs = nowMs - cacheRetentionMs
  const used: Array<[string, CacheEntry]> = []
  const recent: Array<[string, CacheEntry]> = []
  for (const item of Object.entries(entries)) {
    const [key, entry] = item
    if (usedKeys.has(key)) {
      used.push(item)
      continue
    }
    const updatedMs = Date.parse(entry.updatedAt || '')
    if (Number.isFinite(updatedMs) && updatedMs >= cutoffMs) {
      recent.push(item)
    }
  }
  const newestFirst = (left: [string, CacheEntry], right: [string, CacheEntry]) =>
    Date.parse(right[1].updatedAt || '') - Date.parse(left[1].updatedAt || '') || left[0].localeCompare(right[0])
  used.sort(newestFirst)
  recent.sort(newestFirst)
  return Object.fromEntries([
    ...used.slice(0, maxCacheEntries),
    ...recent.slice(0, Math.max(0, maxCacheEntries - used.length))
  ])
}

function copyUsage(usage: DatedUsage): DatedUsage {
  return { ...usage }
}

function copyChildUsageEvent(event: ChildUsageEvent): ChildUsageEvent {
  return { ...event }
}

function normalizeCacheState(state: SerializedCacheState): CacheState {
  return {
    ...state,
    entries: Object.fromEntries(
      Object.entries(state.entries).map(([key, entry]) => [
        key,
        { ...entry, usages: entry.usages.map(normalizeDatedUsage) }
      ])
    )
  }
}

function normalizeDatedUsage(usage: SerializedDatedUsage): DatedUsage {
  return { ...usage, cacheCreationTokens: usage.cacheCreationTokens ?? 0 }
}

function isSerializedCacheState(value: unknown): value is SerializedCacheState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<SerializedCacheState>
  return (
    candidate.version === cacheVersion &&
    typeof candidate.timezone === 'string' &&
    Boolean(candidate.entries) &&
    typeof candidate.entries === 'object' &&
    !Array.isArray(candidate.entries) &&
    Object.values(candidate.entries).every(isSerializedCacheEntry)
  )
}

function isSerializedCacheEntry(value: unknown): value is SerializedCacheEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<SerializedCacheEntry>
  return (
    isFiniteNumber(candidate.size) &&
    (candidate.dev === undefined || isFiniteNumber(candidate.dev)) &&
    (candidate.ino === undefined || isFiniteNumber(candidate.ino)) &&
    isFiniteNumber(candidate.mtimeMs) &&
    (candidate.ctimeMs === undefined || isFiniteNumber(candidate.ctimeMs)) &&
    typeof candidate.tailSha256 === 'string' &&
    (candidate.updatedAt === undefined || typeof candidate.updatedAt === 'string') &&
    Array.isArray(candidate.usages) &&
    candidate.usages.every(isSerializedDatedUsage)
  )
}

function isSerializedDatedUsage(value: unknown): value is SerializedDatedUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<SerializedDatedUsage>
  return (
    typeof candidate.usageDate === 'string' &&
    isFiniteNumber(candidate.inputTokens) &&
    isFiniteNumber(candidate.outputTokens) &&
    (candidate.cacheCreationTokens === undefined || isFiniteNumber(candidate.cacheCreationTokens)) &&
    isFiniteNumber(candidate.cacheReadTokens) &&
    isFiniteNumber(candidate.totalTokens)
  )
}

function isFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isMissingSourceFileError(error: unknown): boolean {
  if (isMissingFileError(error)) return true
  return error instanceof Error && error.cause !== undefined && isMissingSourceFileError(error.cause)
}
