import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import type { UsageSnapshot, UsageSource } from '@tokenboard/usage-core'
import {
  cursorFileName,
  readCursor,
  stripCollectedAt,
  writeCursor,
  type CursorEntry,
  type CursorState
} from './session-cursor-store'
import { walkJsonlFiles } from './session-file-walk'

export type ChangedSessionFile = {
  absolutePath: string
  relativePath: string
  size: number
  mtimeMs: number
  sha256: string
  pendingUpload: boolean
  readLines: () => AsyncIterable<string>
}

type CollectInput = {
  source: UsageSource
  sessionsDir: string
  cursorPath: string
  scanSinceMs?: number
  scanSafetyMs?: number
}

export async function collectChangedSessionFiles(input: CollectInput) {
  const current = await readCursor(input.cursorPath, input.source)
  const scanSinceMs = readEffectiveScanSinceMs(current, input)
  const next: CursorState = {
    version: 1,
    source: input.source,
    files: {}
  }
  const scan = await scanSessionTree(input, current, next, scanSinceMs)
  const missing = preserveMissingCursorEntries(current, next, scan.seen)
  next.lastScanHighWaterMs = scan.highWaterMs
  const hasPendingUpload = Object.values(next.files).some((entry) => entry.pendingUpload)

  return {
    files: scan.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    cursor: next,
    hasCursorCleanup: missing.hasCursorCleanup,
    hasPendingUpload,
    hasUnreadableChangedFile: scan.hasUnreadableChangedFile,
    hasUnreadablePendingUpload: scan.hasUnreadablePendingUpload || missing.hasUnreadablePendingUpload,
    markPendingUpload: (relativePaths?: Iterable<string>) => {
      const allowed = relativePaths ? new Set(relativePaths) : null
      for (const file of scan.files) {
        if (allowed && !allowed.has(file.relativePath)) continue
        next.files[file.relativePath].pendingUpload = true
      }
    },
    commit: () => writeCursor(input.cursorPath, next)
  }
}

async function scanSessionTree(
  input: CollectInput,
  current: CursorState,
  next: CursorState,
  scanSinceMs: number | undefined
) {
  const result = emptyScanResult(current)
  for await (const file of walkJsonlFiles(input.sessionsDir)) {
    await collectSessionFile(input, current, next, scanSinceMs, result, file)
  }
  return result
}

function emptyScanResult(current: CursorState) {
  return {
    files: [] as ChangedSessionFile[],
    seen: new Set<string>(),
    highWaterMs: current.lastScanHighWaterMs ?? 0,
    hasUnreadableChangedFile: false,
    hasUnreadablePendingUpload: false
  }
}

async function collectSessionFile(input: CollectInput, current: CursorState, next: CursorState, scanSinceMs: number | undefined, result: ReturnType<typeof emptyScanResult>, file: string) {
  const absolutePath = isAbsolute(file) ? file : join(input.sessionsDir, file)
  const relativePath = normalizeRelativePath(relative(input.sessionsDir, absolutePath))
  const fileStat = await stat(absolutePath).catch(() => null)
  if (!fileStat?.isFile()) return
  result.highWaterMs = Math.max(result.highWaterMs, fileStat.mtimeMs)
  result.seen.add(relativePath)

  const entry = { size: fileStat.size, mtimeMs: fileStat.mtimeMs, sha256: '' }
  const prior = current.files[relativePath]
  if (skipByMetadata({ prior, entry, scanSinceMs, next, relativePath })) return

  const sha256 = await hashFile(absolutePath).catch(() => null)
  if (sha256 === null) {
    recordUnreadableFile({ prior, next, relativePath, result })
    return
  }
  entry.sha256 = sha256
  if (prior && sameFile(prior, entry) && !prior.pendingUpload) {
    next.files[relativePath] = prior
    return
  }
  next.files[relativePath] = newCursorEntry(entry, prior?.pendingUpload)
  result.files.push({
    absolutePath,
    relativePath,
    ...entry,
    pendingUpload: Boolean(prior?.pendingUpload),
    readLines: () => readLines(absolutePath)
  })
}

function skipByMetadata({ prior, entry, scanSinceMs, next, relativePath }: {
  prior?: CursorEntry
  entry: { size: number; mtimeMs: number }
  scanSinceMs?: number
  next: CursorState
  relativePath: string
}) {
  if (!prior?.pendingUpload && scanSinceMs !== undefined && entry.mtimeMs < scanSinceMs) {
    if (prior) next.files[relativePath] = prior
    return true
  }
  if (prior && sameMetadata(prior, entry) && !prior.pendingUpload) {
    next.files[relativePath] = prior
    return true
  }
  return false
}

function recordUnreadableFile({ prior, next, relativePath, result }: {
  prior?: CursorEntry
  next: CursorState
  relativePath: string
  result: ReturnType<typeof emptyScanResult>
}) {
  result.hasUnreadableChangedFile = true
  result.hasUnreadablePendingUpload ||= Boolean(prior?.pendingUpload)
  if (prior) next.files[relativePath] = prior
}

function newCursorEntry(entry: { size: number; mtimeMs: number; sha256: string }, pendingUpload = false): CursorEntry {
  return {
    ...entry,
    snapshots: [],
    missingCost: false,
    pendingUpload: pendingUpload || undefined,
    updatedAt: new Date().toISOString()
  }
}

function preserveMissingCursorEntries(current: CursorState, next: CursorState, seen: Set<string>) {
  let hasUnreadablePendingUpload = false
  let hasCursorCleanup = false
  for (const [relativePath, entry] of Object.entries(current.files)) {
    if (seen.has(relativePath)) continue
    if (entry.pendingUpload && entry.snapshots.length === 0) {
      hasCursorCleanup = true
      continue
    }
    next.files[relativePath] ??= entry
    hasUnreadablePendingUpload ||= Boolean(entry.pendingUpload)
  }
  return { hasCursorCleanup, hasUnreadablePendingUpload }
}

export function updateCursorFile(
  cursor: CursorState,
  file: Pick<ChangedSessionFile, 'relativePath' | 'size' | 'mtimeMs' | 'sha256'>,
  parsed: { snapshots: UsageSnapshot[]; missingCost: boolean; ignoredUploadSafeRows?: number },
  updatedAt = new Date().toISOString()
) {
  const prior = cursor.files[file.relativePath]
  const safeIgnoredPending = Boolean(prior?.pendingUpload && parsed.snapshots.length === 0 && parsed.ignoredUploadSafeRows)
  cursor.files[file.relativePath] = {
    size: file.size,
    mtimeMs: file.mtimeMs,
    sha256: file.sha256,
    snapshots: parsed.snapshots.map((snapshot) => stripCollectedAt(snapshot)),
    missingCost: parsed.missingCost,
    pendingUpload: safeIgnoredPending ? undefined : prior?.pendingUpload || undefined,
    updatedAt
  }
}

export async function clearPendingUploadCursors(input: { stateDir: string; source: UsageSource }) {
  const cursorPath = join(input.stateDir, cursorFileName(input.source))
  const cursor = await readCursor(cursorPath, input.source)
  let changed = false
  for (const entry of Object.values(cursor.files)) {
    if (!entry.pendingUpload) continue
    entry.pendingUpload = false
    changed = true
  }
  if (changed) {
    await writeCursor(cursorPath, cursor)
  }
}

export async function warmHookCursorHighWater(input: {
  stateDir: string
  source: UsageSource
  sessionsDir?: string
  highWaterMs: number
}) {
  const cursorPath = join(input.stateDir, cursorFileName(input.source))
  const cursor = await readCursor(cursorPath, input.source)
  const highWaterMs = Math.max(cursor.lastScanHighWaterMs ?? 0, input.highWaterMs)

  if (highWaterMs !== cursor.lastScanHighWaterMs) {
    cursor.lastScanHighWaterMs = highWaterMs
    await writeCursor(cursorPath, cursor)
  }
}

export function mergeSnapshots(snapshots: UsageSnapshot[]) {
  const rows = new Map<string, UsageSnapshot>()
  for (const snapshot of snapshots) {
    const key = [
      snapshot.source,
      snapshot.usageDate,
      snapshot.timezone,
      snapshot.model
    ].join('\0')
    const current = rows.get(key)
    if (!current) {
      rows.set(key, { ...snapshot })
      continue
    }

    current.inputTokens += snapshot.inputTokens
    current.outputTokens += snapshot.outputTokens
    current.cacheCreationTokens += snapshot.cacheCreationTokens
    current.cacheReadTokens += snapshot.cacheReadTokens
    current.totalTokens += snapshot.totalTokens
    current.costUsd += snapshot.costUsd
    current.sessionCount += snapshot.sessionCount
  }

  return [...rows.values()].sort((left, right) =>
    left.usageDate.localeCompare(right.usageDate) ||
    left.model.localeCompare(right.model)
  )
}

function readEffectiveScanSinceMs(current: CursorState, input: CollectInput) {
  const safetyMs = input.scanSafetyMs ?? 60_000
  const previousScanMs = typeof current.lastScanHighWaterMs === 'number'
    ? Math.max(0, current.lastScanHighWaterMs - safetyMs)
    : undefined
  if (previousScanMs === undefined) return input.scanSinceMs
  if (input.scanSinceMs === undefined) return previousScanMs
  return Math.max(input.scanSinceMs, previousScanMs)
}

function sameFile(left: CursorEntry, right: { size: number; mtimeMs: number; sha256: string }) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.sha256 === right.sha256
}

function sameMetadata(left: CursorEntry, right: { size: number; mtimeMs: number }) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs
}

async function hashFile(filePath: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function* readLines(filePath: string) {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  for await (const line of lines) {
    yield line
  }
}

function normalizeRelativePath(value: string) {
  return value.split('\\').join('/')
}
