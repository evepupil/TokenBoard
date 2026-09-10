import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { UsageSnapshot, UsageSource } from '@tokenboard/usage-core'
import {
  antigravityGuiDbResetCorrectionPrefix,
  cursorFileName,
  readCursor,
  stripCollectedAt,
  withCursorLock,
  writeCursor,
  type CursorEntry,
  type CursorSnapshot,
  type CursorState
} from './session-cursor-store'
import { normalizeSessionRelativePath, resolveSessionJsonlFiles } from './session-file-walk'
import { resolveAntigravityCollectionRange } from './antigravity-since'
import {
  cliHistoryAggregateKey,
  isCliHistoryAggregateKey,
  isCliHistoryEventKey,
  isCliHistorySessionKey
} from './antigravity-cli-cursor'
import {
  readSessionJsonlLines,
  type SessionJsonlFileFingerprint,
  type SessionJsonlLine
} from './session-jsonl-line-reader'
import { formatDate } from './session-jsonl-parser-utils'
import { isUnresolvedCodexContextPricingSnapshot } from './codex-context-pricing'

export type ChangedSessionFile = {
  absolutePath: string
  relativePath: string
  size: number
  mtimeMs: number
  sha256: string
  endsWithNewline: boolean
  pendingUpload: boolean
  appendOnly: boolean
  readOffsetBytes: number
  readLines: () => AsyncIterable<SessionJsonlLine>
}

type CollectInput = {
  source: UsageSource
  sessionsDir: string
  sessionDirs?: readonly string[]
  cursorPath: string
  cursorProfileHash?: string
  scanSinceMs?: number
  scanSafetyMs?: number
  maxLineBytes?: number
  allowedRootSymlinks?: readonly string[]
}

const defaultSessionLineBytes = 1024 * 1024

export async function collectChangedSessionFiles(input: CollectInput) {
  const maxLineBytes = readSessionLineBytes(input.maxLineBytes)
  const current = await readCursor(input.cursorPath, input.source)
  const scanSinceMs = readEffectiveScanSinceMs(current, input)
  const next: CursorState = {
    version: 1,
    source: input.source,
    ...(input.cursorProfileHash
      ? { codexHookProfileHash: input.cursorProfileHash }
      : current.codexHookProfileHash
        ? { codexHookProfileHash: current.codexHookProfileHash }
        : {}),
    files: {}
  }
  const scan = await scanSessionTree(input, current, next, scanSinceMs, maxLineBytes)
  const missing = preserveMissingCursorEntries(current, next, scan.seen)
  next.lastScanHighWaterMs = scan.highWaterMs
  const hasPendingUpload = Object.values(next.files).some((entry) => entry.pendingUpload)

  return {
    files: scan.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    cursor: next,
    hasCursorCleanup: missing.hasCursorCleanup,
    hasCursorMetadataUpdate: scan.hasCursorMetadataUpdate,
    hasCursorProfileUpdate:
      input.cursorProfileHash !== undefined && current.codexHookProfileHash !== input.cursorProfileHash,
    hasPendingUpload,
    hasUnreadableChangedFile: scan.hasUnreadableChangedFile,
    hasUnreadablePendingUpload: scan.hasUnreadablePendingUpload || missing.hasUnreadablePendingUpload,
    missingPendingSnapshots: missing.missingPendingSnapshots,
    missingPendingSnapshotEntries: missing.missingPendingSnapshotEntries,
    markPendingUpload: (relativePaths?: Iterable<string>) => {
      const allowed = relativePaths ? new Set(relativePaths) : null
      for (const file of scan.files) {
        if (allowed && !allowed.has(file.relativePath)) continue
        next.files[file.relativePath].pendingUpload = true
      }
    },
    commit: () => {
      if (scan.hasReadFailure) {
        throw new Error(`${input.source} session cursor cannot commit after a changed file read failure`)
      }
      if (scan.unreadChangedFiles.size > 0) {
        throw new Error(`${input.source} session cursor cannot commit before all changed files are read`)
      }
      return writeCursor(input.cursorPath, next)
    }
  }
}

async function scanSessionTree(
  input: CollectInput,
  current: CursorState,
  next: CursorState,
  scanSinceMs: number | undefined,
  maxLineBytes: number
) {
  const result = emptyScanResult(current)
  const sessionDirs = input.sessionDirs?.length ? input.sessionDirs : [input.sessionsDir]
  for (const sessionsDir of sessionDirs) {
    const sessionFiles = await resolveSessionJsonlFiles(
      sessionsDir,
      input.source === 'codex'
        ? {
            rejectRootSymlink: true,
            rootBoundary: dirname(sessionsDir),
            allowedRootSymlinks: input.allowedRootSymlinks
          }
        : undefined
    )
    if (!sessionFiles) continue
    const resolvedInput = { ...input, sessionsDir: sessionFiles.rootDir }
    for await (const file of sessionFiles.files) {
      const logicalRelativePath = normalizeRelativePath(file)
      if (result.seen.has(logicalRelativePath)) continue
      await collectSessionFile(resolvedInput, current, next, scanSinceMs, maxLineBytes, result, file)
    }
  }
  return result
}

function emptyScanResult(current: CursorState) {
  return {
    files: [] as ChangedSessionFile[],
    seen: new Set<string>(),
    highWaterMs: current.lastScanHighWaterMs ?? 0,
    hasUnreadableChangedFile: false,
    hasUnreadablePendingUpload: false,
    hasCursorMetadataUpdate: false,
    hasReadFailure: false,
    unreadChangedFiles: new Set<string>()
  }
}

async function collectSessionFile(
  input: CollectInput,
  current: CursorState,
  next: CursorState,
  scanSinceMs: number | undefined,
  maxLineBytes: number,
  result: ReturnType<typeof emptyScanResult>,
  file: string
) {
  const absolutePath = isAbsolute(file) ? file : join(input.sessionsDir, file)
  const relativePath = normalizeRelativePath(relative(input.sessionsDir, absolutePath))
  const fileStat = await lstat(absolutePath).catch(() => null)
  if (fileStat?.isSymbolicLink()) {
    throw new Error(`Unable to read ${input.source} session file ${absolutePath}: symbolic links are not supported`)
  }
  if (!fileStat?.isFile()) return
  result.highWaterMs = Math.max(result.highWaterMs, fileStat.mtimeMs)
  result.seen.add(relativePath)

  const fingerprint = sessionJsonlFingerprint(fileStat)
  const entry = {
    size: fingerprint.size,
    mtimeMs: fileStat.mtimeMs,
    sha256: ''
  }
  const prior = current.files[relativePath]
  if (prior && sameMetadata(prior, entry) && !prior.pendingUpload && prior.endsWithNewline === undefined) {
    const endsWithNewline = await readFileEndsWithNewline(absolutePath, entry.size).catch(() => null)
    if (endsWithNewline !== null) {
      next.files[relativePath] = { ...prior, endsWithNewline }
      result.hasCursorMetadataUpdate = true
      return
    }
  }
  if (skipByMetadata({ prior, entry, scanSinceMs, next, relativePath })) return

  if (prior && isAppendOnlyUpdate(prior, entry)) {
    const [fingerprints, endsWithNewline] = await Promise.all([
      hashFileAndPrefix(absolutePath, prior.size, entry.size).catch(() => null),
      readFileEndsWithNewline(absolutePath, entry.size).catch(() => null)
    ])
    if (fingerprints === null || endsWithNewline === null) {
      recordUnreadableFile({ prior, next, relativePath, result })
      return
    }
    entry.sha256 = fingerprints.sha256
    if (fingerprints.prefixSha256 === prior.sha256) {
      next.files[relativePath] = prior
      result.files.push({
        absolutePath,
        relativePath,
        ...entry,
        endsWithNewline,
        pendingUpload: false,
        appendOnly: true,
        readOffsetBytes: prior.size,
        readLines: () =>
          readChangedSessionJsonlLines(result, relativePath, {
            filePath: absolutePath,
            startOffsetBytes: prior.size,
            endOffsetBytes: entry.size,
            maxLineBytes,
            source: input.source,
            expectedFingerprint: { ...fingerprint, sha256: entry.sha256 }
          })
      })
      result.unreadChangedFiles.add(relativePath)
      return
    }
    next.files[relativePath] = newCursorEntry(entry, prior.pendingUpload, endsWithNewline)
    result.files.push({
      absolutePath,
      relativePath,
      ...entry,
      endsWithNewline,
      pendingUpload: Boolean(prior.pendingUpload),
      appendOnly: false,
      readOffsetBytes: 0,
      readLines: () =>
        readChangedSessionJsonlLines(result, relativePath, {
          filePath: absolutePath,
          startOffsetBytes: 0,
          endOffsetBytes: entry.size,
          maxLineBytes,
          source: input.source,
          expectedFingerprint: { ...fingerprint, sha256: entry.sha256 }
        })
    })
    result.unreadChangedFiles.add(relativePath)
    return
  }

  const [sha256, endsWithNewline] = await Promise.all([
    hashFile(absolutePath, entry.size).catch(() => null),
    readFileEndsWithNewline(absolutePath, entry.size).catch(() => null)
  ])
  if (sha256 === null || endsWithNewline === null) {
    recordUnreadableFile({ prior, next, relativePath, result })
    return
  }
  entry.sha256 = sha256
  if (prior && sameFile(prior, entry) && !prior.pendingUpload) {
    next.files[relativePath] = prior
    return
  }
  next.files[relativePath] = newCursorEntry(entry, prior?.pendingUpload, endsWithNewline)
  result.files.push({
    absolutePath,
    relativePath,
    ...entry,
    endsWithNewline,
    pendingUpload: Boolean(prior?.pendingUpload),
    appendOnly: false,
    readOffsetBytes: 0,
    readLines: () =>
      readChangedSessionJsonlLines(result, relativePath, {
        filePath: absolutePath,
        startOffsetBytes: 0,
        endOffsetBytes: entry.size,
        maxLineBytes,
        source: input.source,
        expectedFingerprint: { ...fingerprint, sha256: entry.sha256 }
      })
  })
  result.unreadChangedFiles.add(relativePath)
}

function skipByMetadata({
  prior,
  entry,
  scanSinceMs,
  next,
  relativePath
}: {
  prior?: CursorEntry
  entry: CursorFileMetadata
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

function recordUnreadableFile({
  prior,
  next,
  relativePath,
  result
}: {
  prior?: CursorEntry
  next: CursorState
  relativePath: string
  result: ReturnType<typeof emptyScanResult>
}) {
  result.hasUnreadableChangedFile = true
  result.hasUnreadablePendingUpload ||= Boolean(prior?.pendingUpload)
  if (prior) next.files[relativePath] = prior
}

function newCursorEntry(
  entry: CursorFileMetadata & { sha256: string },
  pendingUpload = false,
  endsWithNewline?: boolean
): CursorEntry {
  return {
    ...entry,
    ...(endsWithNewline !== undefined ? { endsWithNewline } : {}),
    snapshots: [],
    missingCost: false,
    pendingUpload: pendingUpload || undefined,
    updatedAt: new Date().toISOString()
  }
}

function preserveMissingCursorEntries(current: CursorState, next: CursorState, seen: Set<string>) {
  let hasCursorCleanup = false
  const missingPendingSnapshots: Array<{ relativePath: string; snapshots: CursorSnapshot[] }> = []
  const missingPendingSnapshotEntries: Array<{ relativePath: string; sha256: string; snapshots: CursorSnapshot[] }> = []
  for (const [relativePath, entry] of Object.entries(current.files)) {
    if (seen.has(relativePath)) continue
    if (entry.pendingUpload && entry.snapshots.length === 0) {
      hasCursorCleanup = true
      continue
    }
    if (entry.pendingUpload) {
      missingPendingSnapshots.push({
        relativePath,
        snapshots: entry.snapshots
      })
      missingPendingSnapshotEntries.push({
        relativePath,
        sha256: entry.sha256,
        snapshots: entry.snapshots
      })
    }
    next.files[relativePath] ??= entry
  }
  return {
    hasCursorCleanup,
    hasUnreadablePendingUpload: false,
    missingPendingSnapshots,
    missingPendingSnapshotEntries
  }
}

export function updateCursorFile(
  cursor: CursorState,
  file: Pick<ChangedSessionFile, 'relativePath' | 'size' | 'mtimeMs' | 'sha256' | 'endsWithNewline' | 'appendOnly'>,
  parsed: {
    snapshots: UsageSnapshot[]
    missingCost: boolean
    ignoredUploadSafeRows?: number
  },
  updatedAt = new Date().toISOString()
) {
  const prior = cursor.files[file.relativePath]
  const hasSafeIgnoredRows = Boolean(parsed.ignoredUploadSafeRows && parsed.ignoredUploadSafeRows > 0)
  const preservePendingSnapshots = Boolean(
    prior?.pendingUpload &&
    parsed.snapshots.length === 0 &&
    hasSafeIgnoredRows &&
    prior.snapshots.length > 0 &&
    !prior.snapshots.every(isSyntheticZeroUsageSnapshot)
  )
  const safeIgnoredPending = Boolean(
    prior?.pendingUpload && parsed.snapshots.length === 0 && hasSafeIgnoredRows && !preservePendingSnapshots
  )
  const snapshots =
    file.appendOnly && prior
      ? mergeCursorSnapshots([...prior.snapshots, ...parsed.snapshots.map((snapshot) => stripCollectedAt(snapshot))])
      : preservePendingSnapshots
        ? prior.snapshots
        : parsed.snapshots.map((snapshot) => stripCollectedAt(snapshot))
  cursor.files[file.relativePath] = {
    size: file.size,
    mtimeMs: file.mtimeMs,
    sha256: file.sha256,
    endsWithNewline: file.endsWithNewline,
    snapshots:
      cursor.source === 'codex'
        ? snapshots.map((snapshot) =>
            isUnresolvedCodexContextPricingSnapshot(snapshot)
              ? { ...snapshot, codexContextPricingPending: true as const }
              : snapshot
          )
        : snapshots,
    missingCost: file.appendOnly && prior ? prior.missingCost || parsed.missingCost : parsed.missingCost,
    pendingUpload: safeIgnoredPending ? undefined : prior?.pendingUpload || undefined,
    updatedAt
  }
}

function isSyntheticZeroUsageSnapshot(snapshot: CursorSnapshot) {
  return (
    snapshot.source === 'claude-code' &&
    snapshot.model === '<synthetic>' &&
    snapshot.inputTokens === 0 &&
    snapshot.outputTokens === 0 &&
    snapshot.cacheCreationTokens === 0 &&
    snapshot.cacheReadTokens === 0 &&
    snapshot.totalTokens === 0 &&
    snapshot.costUsd === 0
  )
}

export async function clearPendingUploadCursors(input: {
  stateDir: string
  source: UsageSource
  cursorScope?: string
  since?: string
  timezone?: string
  acknowledgedSnapshotGroups?: string[]
  acknowledgedSnapshotFiles?: ReadonlyArray<{ relativePath: string; sha256: string }>
}) {
  const isAntigravity = input.source.startsWith('antigravity')
  if (isAntigravity && !input.timezone) {
    throw new Error('Antigravity cursor acknowledgement requires an explicit timezone')
  }
  const timezone = input.timezone
  const cursorPath = join(input.stateDir, cursorFileName(input.source, input.cursorScope))
  await withCursorLock(cursorPath, async () => {
    const cursor = await readCursor(cursorPath, input.source)
    const range = isAntigravity
      ? resolveAntigravityCollectionRange({
          since: input.since ?? 'all',
          timezone: timezone!,
          env: {}
        })
      : null
    const acknowledgedSnapshotGroups =
      input.acknowledgedSnapshotGroups === undefined ? undefined : new Set(input.acknowledgedSnapshotGroups)
    const acknowledgedSnapshotFiles =
      input.acknowledgedSnapshotFiles === undefined
        ? undefined
        : new Set(input.acknowledgedSnapshotFiles.map((file) => `${file.relativePath}\0${file.sha256}`))
    let changed = false
    for (const [key, entry] of Object.entries(cursor.files)) {
      if (!entry.pendingUpload) continue
      const acknowledged =
        acknowledgedSnapshotFiles !== undefined
          ? cursorEntryHasAcknowledgedSnapshotFile({ key, entry, acknowledgedSnapshotFiles })
          : acknowledgedSnapshotGroups !== undefined &&
            cursorEntryHasAcknowledgedSnapshotGroup({
              key,
              entry,
              source: input.source,
              timezone,
              acknowledgedSnapshotGroups
            })
      if (
        (acknowledgedSnapshotFiles !== undefined || acknowledgedSnapshotGroups !== undefined) &&
        (acknowledgedSnapshotFiles !== undefined
          ? input.source === 'codex'
          : cursorEntryRequiresAcknowledgedSnapshotGroup({
              key,
              entry,
              source: input.source,
              timezone
            })) &&
        !acknowledged
      )
        continue
      if (range && !acknowledged && !cursorEntryIsInRange(entry, range.sinceDate, range.includesTimestamp)) continue
      entry.pendingUpload = false
      if (input.source === 'codex') {
        entry.snapshots = entry.snapshots.map(({ codexContextPricingPending: _pending, ...snapshot }) => snapshot)
      }
      entry.updatedAt = new Date().toISOString()
      changed = true
    }
    if (isAntigravity) {
      changed = compactAcknowledgedAntigravityUsage(cursor, timezone) || changed
    }
    if (changed) await writeCursor(cursorPath, cursor)
  })
}

function cursorEntryHasAcknowledgedSnapshotFile(input: {
  key: string
  entry: CursorEntry
  acknowledgedSnapshotFiles: ReadonlySet<string>
}) {
  return input.acknowledgedSnapshotFiles.has(`${input.key}\0${input.entry.sha256}`)
}

function cursorEntryHasAcknowledgedSnapshotGroup(input: {
  key: string
  entry: CursorEntry
  source: UsageSource
  timezone?: string
  acknowledgedSnapshotGroups: ReadonlySet<string>
}) {
  if (input.entry.snapshots.length > 0) {
    return input.entry.snapshots.every((snapshot) =>
      input.acknowledgedSnapshotGroups.has(cursorSnapshotGroupKey(snapshot))
    )
  }
  const sessionGroup = sessionMarkerSnapshotGroup(input.key, input.source, input.timezone)
  return sessionGroup !== undefined && input.acknowledgedSnapshotGroups.has(sessionGroup)
}

function cursorEntryRequiresAcknowledgedSnapshotGroup(input: {
  key: string
  entry: CursorEntry
  source: UsageSource
  timezone?: string
}) {
  return (
    input.entry.snapshots.length > 0 ||
    sessionMarkerSnapshotGroup(input.key, input.source, input.timezone) !== undefined
  )
}

function sessionMarkerSnapshotGroup(key: string, source: UsageSource, timezone?: string) {
  const parts = key.split('\0')
  if (parts[0] !== 'session' || parts[1] !== source) return undefined
  const [usageDate, model] = [parts[2], parts[3]]
  if (!source.startsWith('antigravity') || !timezone || !isUsageDate(usageDate) || !model) return undefined
  return [source, usageDate, timezone, model].join('\0')
}

function isUsageDate(value: string | undefined) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function cursorEntryIsInRange(
  entry: CursorEntry,
  sinceDate: string | undefined,
  includesTimestamp: (value: string) => boolean
) {
  if (!sinceDate) return true
  if (entry.snapshots.length > 0) {
    return entry.snapshots.some((snapshot) => snapshot.usageDate >= sinceDate)
  }
  if (entry.mtimeMs <= 0) return true
  return includesTimestamp(new Date(entry.mtimeMs).toISOString())
}

function compactAcknowledgedAntigravityUsage(cursor: CursorState, timezone?: string) {
  if (cursor.source === 'antigravity-cli') {
    if (!timezone) throw new Error('Antigravity CLI cursor compaction requires an explicit timezone')
    return compactAcknowledgedCliHistory(cursor, timezone)
  }
  const aggregateInputs = new Map<
    string,
    {
      mtimeMs: number
      snapshots: CursorSnapshot[]
      origin?: CursorEntry['antigravityOrigin']
    }
  >()
  const compactedAt = new Date().toISOString()
  let changed = false

  for (const [key, entry] of Object.entries(cursor.files)) {
    if (isAntigravityGuiDbResetCorrectionKey(key)) {
      if (!entry.pendingUpload) {
        delete cursor.files[key]
        changed = true
      }
      continue
    }
    if (
      entry.compactedIdentity &&
      entry.snapshots.length === 0 &&
      !entry.pendingUpload &&
      isAntigravityReplayIdentityKey(key)
    ) {
      if (canDiscardAntigravityReplayIdentity(cursor, key)) {
        recordDiscardedAntigravityReplayIdentity(cursor, key)
        delete cursor.files[key]
        changed = true
      }
      continue
    }
    const retainedAtMs = Date.parse(entry.updatedAt)
    if (entry.pendingUpload || !Number.isFinite(retainedAtMs) || !isAntigravityUsageStateKey(key)) continue
    if (entry.snapshots.length === 0) {
      if (canDiscardAntigravityReplayIdentity(cursor, key)) {
        recordDiscardedAntigravityReplayIdentity(cursor, key)
        delete cursor.files[key]
        changed = true
      } else {
        entry.compactedIdentity = true
        entry.updatedAt = compactedAt
        changed = true
      }
      continue
    }
    changed = true
    for (const snapshot of entry.snapshots) {
      const groupKey = cursorSnapshotGroupKey(snapshot)
      const aggregateKey = antigravityAggregateInputKey(groupKey, entry.antigravityOrigin)
      const group = aggregateInputs.get(aggregateKey) ?? {
        mtimeMs: 0,
        snapshots: [],
        origin: entry.antigravityOrigin
      }
      group.mtimeMs = Math.max(group.mtimeMs, entry.mtimeMs)
      group.snapshots.push(snapshot)
      aggregateInputs.set(aggregateKey, group)
    }
    if (isAntigravityReplayIdentityKey(key) && !canDiscardAntigravityReplayIdentity(cursor, key)) {
      entry.size = 0
      entry.snapshots = []
      entry.missingCost = true
      entry.pendingUpload = false
      entry.compactedIdentity = true
      entry.updatedAt = compactedAt
    } else {
      if (isAntigravityReplayIdentityKey(key)) {
        recordDiscardedAntigravityReplayIdentity(cursor, key)
      }
      delete cursor.files[key]
    }
  }

  for (const [groupKey, input] of aggregateInputs) {
    // Ingest replaces daily model totals, so late events still need one compact baseline.
    const key = antigravityAggregateCursorKey(groupKey, input.origin)
    const existing = cursor.files[key]
    const snapshots = [...(existing?.snapshots ?? []), ...input.snapshots]
    cursor.files[key] = {
      size: 0,
      mtimeMs: Math.max(existing?.mtimeMs ?? 0, input.mtimeMs),
      sha256: hashValue(key),
      snapshots: [mergeCursorSnapshotGroup(snapshots)],
      missingCost: true,
      pendingUpload: false,
      ...(input.origin ? { antigravityOrigin: input.origin } : {}),
      updatedAt: new Date().toISOString()
    }
  }

  return changed
}

function antigravityAggregateInputKey(groupKey: string, origin: CursorEntry['antigravityOrigin']) {
  return origin ? `${origin}\0${groupKey}` : groupKey
}

function antigravityAggregateCursorKey(groupKey: string, origin: CursorEntry['antigravityOrigin']) {
  return origin ? `aggregate\0${origin}\0${hashValue(groupKey)}` : `aggregate\0${hashValue(groupKey)}`
}

function compactAcknowledgedCliHistory(cursor: CursorState, timezone: string) {
  if (cursor.antigravityCliMeteringVersion !== 3) return false
  const cutoffMs = Date.now() - antigravityUsageCursorRetentionMs
  const cutoffDate = formatDate(new Date(cutoffMs), timezone)
  const compactedThroughDate = nextCalendarDate(cutoffDate)
  const compactedAt = new Date().toISOString()
  const aggregateInputs = new Map<string, { mtimeMs: number; snapshots: CursorSnapshot[] }>()
  let changed = false
  let prunedHistoryIdentity = false

  for (const [key, entry] of Object.entries(cursor.files)) {
    if (entry.pendingUpload) continue
    if (isAntigravityCliHistoryCorrectionKey(key)) {
      delete cursor.files[key]
      changed = true
      continue
    }
    if (!isCliHistoryAggregateKey(key)) continue
    const snapshots = entry.snapshots.filter((snapshot) => snapshot.usageDate >= cutoffDate)
    if (snapshots.length === 0) {
      // Keep one compact baseline for groups outside the retention window.
      // A later full rebuild may need it to emit a zero correction if the
      // corresponding SQLite history group has disappeared.
      if (entry.snapshots.length > 1) {
        entry.snapshots = [mergeCursorSnapshotGroup(entry.snapshots)]
        entry.updatedAt = compactedAt
        changed = true
      }
      continue
    }
    if (snapshots.length !== entry.snapshots.length || snapshots.length > 1) {
      entry.snapshots = [mergeCursorSnapshotGroup(snapshots)]
      entry.updatedAt = compactedAt
      changed = true
    }
  }

  for (const [key, entry] of Object.entries(cursor.files)) {
    if (entry.pendingUpload || !isCliHistoryEventKey(key)) continue
    if (entry.snapshots.length === 0) {
      if (entry.mtimeMs < cutoffMs) {
        delete cursor.files[key]
        changed = true
        prunedHistoryIdentity = true
      }
      continue
    }
    const retainedSnapshots = entry.snapshots.filter((snapshot) => snapshot.usageDate >= cutoffDate)
    for (const snapshot of entry.snapshots) {
      const groupKey = cursorSnapshotGroupKey(snapshot)
      const group = aggregateInputs.get(groupKey) ?? { mtimeMs: 0, snapshots: [] }
      group.mtimeMs = Math.max(group.mtimeMs, entry.mtimeMs)
      group.snapshots.push(snapshot)
      aggregateInputs.set(groupKey, group)
    }
    if (retainedSnapshots.length === 0 || entry.mtimeMs < cutoffMs) {
      delete cursor.files[key]
      prunedHistoryIdentity = true
    } else {
      entry.snapshots = []
      entry.pendingUpload = false
      entry.compactedIdentity = true
      entry.updatedAt = compactedAt
    }
    changed = true
  }

  for (const [key, entry] of Object.entries(cursor.files)) {
    if (entry.pendingUpload || !isCliHistorySessionKey(key) || entry.mtimeMs >= cutoffMs) continue
    delete cursor.files[key]
    changed = true
    prunedHistoryIdentity = true
  }

  for (const [groupKey, input] of aggregateInputs) {
    const key = cliHistoryAggregateKey(groupKey)
    const existing = cursor.files[key]
    cursor.files[key] = {
      size: 0,
      mtimeMs: Math.max(existing?.mtimeMs ?? 0, input.mtimeMs),
      sha256: hashValue(key),
      snapshots: [mergeCursorSnapshotGroup([...(existing?.snapshots ?? []), ...input.snapshots])],
      missingCost: true,
      pendingUpload: false,
      updatedAt: compactedAt
    }
    changed = true
  }

  if (prunedHistoryIdentity) {
    cursor.antigravityCliHistoryCompacted = true
    cursor.antigravityCliHistoryCompactedThroughDate = maxUsageDate(
      cursor.antigravityCliHistoryCompactedThroughDate,
      compactedThroughDate
    )
  }
  return changed
}

function maxUsageDate(previous: string | undefined, next: string) {
  return previous && previous > next ? previous : next
}

function nextCalendarDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

function isAntigravityCliHistoryCorrectionKey(key: string) {
  return key.startsWith('history-authority-correction\0')
}

function isAntigravityGuiDbResetCorrectionKey(key: string) {
  return key.startsWith(antigravityGuiDbResetCorrectionPrefix)
}

function isAntigravityUsageStateKey(key: string) {
  return antigravityUsageStatePrefixes.some((prefix) => key.startsWith(prefix))
}

function isAntigravityReplayIdentityKey(key: string) {
  return isAntigravityUsageStateKey(key)
}

function canDiscardAntigravityReplayIdentity(cursor: CursorState, key: string) {
  const protection = antigravityReplayIdentityProtection(key)
  if (protection === 'history') return cursor.antigravityHistoryReplayReady === true
  if (protection === 'statusline') return cursor.antigravityStatuslineReplayReady === true
  return cursor.antigravityHistoryReplayReady === true && cursor.antigravityStatuslineReplayReady === true
}

function recordDiscardedAntigravityReplayIdentity(cursor: CursorState, key: string) {
  const protection = antigravityReplayIdentityProtection(key)
  if (protection === 'history' || protection === 'both') {
    cursor.antigravityHistoryReplayCompacted = true
  }
  if (protection === 'statusline' || protection === 'both') {
    cursor.antigravityStatuslineReplayCompacted = true
  }
}

function antigravityReplayIdentityProtection(key: string): 'history' | 'statusline' | 'both' {
  if (key.startsWith('history-event\0')) return 'history'
  if (key.startsWith('statusline-event\0') || key.startsWith('statusline-occurrence\0')) {
    return 'statusline'
  }
  return 'both'
}

function mergeCursorSnapshotGroup(snapshots: CursorSnapshot[]) {
  const [first, ...rest] = snapshots
  if (!first) throw new Error('Cannot compact an empty Antigravity cursor snapshot group')
  const merged = { ...first }
  for (const snapshot of rest) {
    merged.inputTokens += snapshot.inputTokens
    merged.outputTokens += snapshot.outputTokens
    merged.cacheCreationTokens += snapshot.cacheCreationTokens
    merged.cacheReadTokens += snapshot.cacheReadTokens
    merged.totalTokens += snapshot.totalTokens
    merged.costUsd += snapshot.costUsd
    merged.sessionCount += snapshot.sessionCount
  }
  return merged
}

export function cursorSnapshotGroupKey(snapshot: CursorSnapshot) {
  return [snapshot.source, snapshot.usageDate, snapshot.timezone, snapshot.model].join('\0')
}

export function selectPendingCursorSnapshotGroups(input: { cursor: CursorState; sinceDate?: string; limit?: number }) {
  if (!input.sinceDate) {
    delete input.cursor.pendingSnapshotRetryCursor
    return new Set<string>()
  }
  const groups = new Set<string>()
  for (const entry of Object.values(input.cursor.files)) {
    if (!entry.pendingUpload) continue
    for (const snapshot of entry.snapshots) {
      if (snapshot.usageDate >= input.sinceDate) continue
      groups.add(cursorSnapshotGroupKey(snapshot))
    }
  }
  const sortedGroups = [...groups].sort()
  if (sortedGroups.length === 0) {
    delete input.cursor.pendingSnapshotRetryCursor
    return new Set<string>()
  }
  const limit = Math.max(0, Math.trunc(input.limit ?? defaultPendingCursorRetryGroupLimit))
  if (limit === 0) {
    delete input.cursor.pendingSnapshotRetryCursor
    return new Set<string>()
  }
  if (sortedGroups.length <= limit) {
    delete input.cursor.pendingSnapshotRetryCursor
    return new Set(sortedGroups)
  }

  const previous = input.cursor.pendingSnapshotRetryCursor
  const afterIndex = previous === undefined ? -1 : sortedGroups.findIndex((group) => group > previous)
  const start = afterIndex === -1 ? 0 : afterIndex
  const selected = sortedGroups.slice(start, start + limit)
  if (selected.length < limit) selected.push(...sortedGroups.slice(0, limit - selected.length))
  input.cursor.pendingSnapshotRetryCursor = selected[selected.length - 1]
  return new Set(selected)
}

export function shouldIncludeCursorSnapshot(
  snapshot: CursorSnapshot,
  sinceDate: string | undefined,
  pendingSnapshotGroups: ReadonlySet<string>
) {
  return !sinceDate || snapshot.usageDate >= sinceDate || pendingSnapshotGroups.has(cursorSnapshotGroupKey(snapshot))
}

function hashValue(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

const antigravityUsageCursorRetentionMs = 90 * 24 * 60 * 60 * 1000
const defaultPendingCursorRetryGroupLimit = 30
const antigravityUsageStatePrefixes = ['event\0', 'session\0']

export async function warmHookCursorHighWater(input: {
  stateDir: string
  source: UsageSource
  cursorScope?: string
  sessionsDir?: string
  highWaterMs: number
}) {
  const cursorPath = join(input.stateDir, cursorFileName(input.source, input.cursorScope))
  await withCursorLock(cursorPath, async () => {
    const cursor = await readCursor(cursorPath, input.source)
    const highWaterMs = Math.max(cursor.lastScanHighWaterMs ?? 0, input.highWaterMs)
    if (highWaterMs === cursor.lastScanHighWaterMs) return
    cursor.lastScanHighWaterMs = highWaterMs
    await writeCursor(cursorPath, cursor)
  })
}

export function mergeSnapshots(snapshots: UsageSnapshot[]) {
  const rows = new Map<string, UsageSnapshot>()
  for (const snapshot of snapshots) {
    const key = [snapshot.source, snapshot.usageDate, snapshot.timezone, snapshot.model].join('\0')
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

  return [...rows.values()].sort(
    (left, right) => left.usageDate.localeCompare(right.usageDate) || left.model.localeCompare(right.model)
  )
}

function readEffectiveScanSinceMs(current: CursorState, input: CollectInput) {
  const safetyMs = input.scanSafetyMs ?? 60_000
  const previousScanMs =
    typeof current.lastScanHighWaterMs === 'number' ? Math.max(0, current.lastScanHighWaterMs - safetyMs) : undefined
  if (previousScanMs === undefined) return input.scanSinceMs
  if (input.scanSinceMs === undefined) return previousScanMs
  return Math.max(input.scanSinceMs, previousScanMs)
}

function sameFile(left: CursorEntry, right: CursorFileMetadata & { sha256: string }) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.sha256 === right.sha256
}

function sameMetadata(left: CursorEntry, right: CursorFileMetadata) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs
}

async function hashFile(filePath: string, endOffsetBytes?: number) {
  const hash = createHash('sha256')
  if (endOffsetBytes !== undefined && endOffsetBytes <= 0) return hash.digest('hex')
  let bytesRead = 0
  for await (const chunk of createReadStream(filePath, {
    ...(endOffsetBytes === undefined ? {} : { end: endOffsetBytes - 1 })
  })) {
    hash.update(chunk)
    bytesRead += chunk.length
  }
  if (endOffsetBytes !== undefined && bytesRead !== endOffsetBytes) {
    throw new Error(`Session file changed while hashing: ${filePath}`)
  }
  return hash.digest('hex')
}

async function hashFileAndPrefix(filePath: string, prefixEndOffsetBytes: number, endOffsetBytes: number) {
  if (prefixEndOffsetBytes < 0 || prefixEndOffsetBytes > endOffsetBytes) {
    throw new Error(`Invalid session hash range: ${filePath}`)
  }
  const prefixHash = createHash('sha256')
  const hash = createHash('sha256')
  let bytesRead = 0
  for await (const chunk of createReadStream(filePath, {
    end: endOffsetBytes - 1
  })) {
    const prefixLength = Math.max(0, Math.min(chunk.length, prefixEndOffsetBytes - bytesRead))
    if (prefixLength > 0) prefixHash.update(chunk.subarray(0, prefixLength))
    hash.update(chunk)
    bytesRead += chunk.length
  }
  if (bytesRead !== endOffsetBytes) {
    throw new Error(`Session file changed while hashing: ${filePath}`)
  }
  return { prefixSha256: prefixHash.digest('hex'), sha256: hash.digest('hex') }
}

function isAppendOnlyUpdate(prior: CursorEntry, entry: CursorFileMetadata) {
  return (
    !prior.pendingUpload &&
    typeof prior.sha256 === 'string' &&
    prior.sha256.length > 0 &&
    Number.isSafeInteger(prior.size) &&
    prior.size >= 0 &&
    entry.size > prior.size &&
    (prior.size === 0 || prior.endsWithNewline === true)
  )
}

async function readFileEndsWithNewline(filePath: string, size: number) {
  if (size === 0) return false
  for await (const chunk of createReadStream(filePath, { start: size - 1, end: size - 1 })) {
    const lastByte = chunk[chunk.length - 1]
    return lastByte === 0x0a || lastByte === 0x0d
  }
  throw new Error(`Could not read the final byte of session file: ${filePath}`)
}

function mergeCursorSnapshots(snapshots: CursorSnapshot[]) {
  const rows = new Map<string, CursorSnapshot>()
  for (const snapshot of snapshots) {
    const key = [snapshot.source, snapshot.usageDate, snapshot.timezone, snapshot.model].join('\0')
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
    current.sessionCount = Math.max(current.sessionCount, snapshot.sessionCount)
  }
  return [...rows.values()].sort(
    (left, right) => left.usageDate.localeCompare(right.usageDate) || left.model.localeCompare(right.model)
  )
}

function readSessionLineBytes(value: number | undefined) {
  if (value === undefined) return defaultSessionLineBytes
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid session line byte limit')
  }
  return value
}

function normalizeRelativePath(value: string) {
  return normalizeSessionRelativePath(value)
}

async function* readChangedSessionJsonlLines(
  result: ReturnType<typeof emptyScanResult>,
  relativePath: string,
  input: Parameters<typeof readSessionJsonlLines>[0]
) {
  let completed = false
  try {
    yield* readSessionJsonlLines(input)
    completed = true
    result.unreadChangedFiles.delete(relativePath)
  } catch (error) {
    result.hasReadFailure = true
    throw error
  } finally {
    if (!completed) result.hasReadFailure = true
  }
}

function sessionJsonlFingerprint(fileStat: import('node:fs').Stats): Omit<SessionJsonlFileFingerprint, 'sha256'> {
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size
  }
}

type CursorFileMetadata = {
  mtimeMs: number
  size: number
}
