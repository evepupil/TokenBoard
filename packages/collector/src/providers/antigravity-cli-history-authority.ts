import { createHash } from 'node:crypto'
import {
  cliHistorySessionKeysForEntry,
  cliHistorySnapshotGroupKey,
  isCliHistorySessionKey,
  isCliHistoryStateKey
} from './antigravity-cli-cursor'
import type { CursorEntry, CursorSnapshot, CursorState } from './session-cursor-store'

export const antigravityCliHistoryMeteringVersion = 3
export const antigravityCliHistoryCorrectionPrefix = 'history-authority-correction\0'

type PrepareHistoryAuthorityMigrationInput = {
  cursor: CursorState
  fullHistory: boolean
}

type HistoryAuthorityMigrationPlan = {
  required: boolean
  requiresFullHistory: boolean
  corrections: CursorSnapshot[]
  reset: boolean
}

export function planAntigravityCliHistoryAuthorityMigration(
  input: PrepareHistoryAuthorityMigrationInput
): HistoryAuthorityMigrationPlan {
  if (input.cursor.source !== 'antigravity-cli') {
    return { required: false, requiresFullHistory: false, corrections: [], reset: false }
  }
  if (input.cursor.antigravityCliMeteringVersion === antigravityCliHistoryMeteringVersion) {
    return { required: false, requiresFullHistory: false, corrections: [], reset: false }
  }

  const reset = hasLegacyCliMeteringState(input.cursor)
  const requiresFullHistory = reset
  if (requiresFullHistory && !input.fullHistory) {
    throw new Error('Antigravity CLI usage state requires --since all to migrate statusline-derived totals')
  }

  return {
    required: true,
    requiresFullHistory,
    corrections: requiresFullHistory ? correctionSnapshots(input.cursor) : [],
    reset
  }
}

export function applyAntigravityCliHistoryAuthorityMigration(input: {
  cursor: CursorState
  collectedAt: string
  corrections: CursorSnapshot[]
  reset: boolean
}) {
  if (input.reset) resetLegacyCliMeteringState(input.cursor)
  for (const snapshot of input.corrections) {
    const key = correctionKey(snapshot)
    input.cursor.files[key] = newCorrectionEntry(snapshot, input.collectedAt)
  }
  input.cursor.antigravityCliMeteringVersion = antigravityCliHistoryMeteringVersion
}

export function isAntigravityCliHistoryCorrectionKey(key: string) {
  return key.startsWith(antigravityCliHistoryCorrectionPrefix)
}

export function shouldRebuildCliHistoryFromFullScan(input: { cursor: CursorState; fullHistory: boolean }) {
  return input.fullHistory
}

export function prepareCliHistoryFullRebuild(cursor: CursorState) {
  const retainedEntries: Array<[string, CursorEntry]> = []
  for (const [key, entry] of Object.entries(cursor.files)) {
    if (
      (isCliHistoryStateKey(key) || isAntigravityCliHistoryCorrectionKey(key)) &&
      (entry.snapshots.length > 0 || isCliHistorySessionKey(key))
    ) {
      retainedEntries.push([key, structuredClone(entry)])
    }
    if (
      isCliHistoryStateKey(key) ||
      isAntigravityCliHistoryCorrectionKey(key) ||
      key.startsWith('db-row\0antigravity-cli\0')
    ) {
      delete cursor.files[key]
    }
  }
  cursor.antigravityDbFileScan = { nextSequence: 0, files: {} }
  delete cursor.antigravityCliHistoryCompacted
  delete cursor.antigravityCliHistoryCompactedThroughDate
  delete cursor.antigravityCliHistoryComplete
  return retainedEntries
}

export function restoreCliHistoryEntriesOutsideFullRebuild(input: {
  cursor: CursorState
  retainedEntries: Array<[string, CursorEntry]>
  rebuiltSnapshotGroups: ReadonlySet<string>
  collectedAt?: string
}) {
  const collectedAt = input.collectedAt ?? new Date().toISOString()
  const retainedCorrectionGroups = new Set<string>()
  const missingGroups = new Map<
    string,
    {
      hasPending: boolean
      acknowledgedSnapshot?: CursorSnapshot
    }
  >()
  for (const [key, entry] of input.retainedEntries) {
    if (isAntigravityCliHistoryCorrectionKey(key)) {
      for (const snapshot of entry.snapshots) {
        retainedCorrectionGroups.add(cliHistorySnapshotGroupKey(snapshot))
      }
      continue
    }
    if (isCliHistorySessionKey(key)) continue
    for (const snapshot of entry.snapshots) {
      const groupKey = cliHistorySnapshotGroupKey(snapshot)
      if (input.rebuiltSnapshotGroups.has(groupKey)) continue
      const group = missingGroups.get(groupKey) ?? { hasPending: false }
      if (entry.pendingUpload) {
        group.hasPending = true
      } else {
        group.acknowledgedSnapshot ??= snapshot
      }
      missingGroups.set(groupKey, group)
    }
  }
  const missingAcknowledgedSnapshots = new Map<string, CursorSnapshot>()
  for (const [groupKey, group] of missingGroups) {
    if (!group.hasPending && group.acknowledgedSnapshot) {
      missingAcknowledgedSnapshots.set(groupKey, group.acknowledgedSnapshot)
    }
  }

  const retainedSessionKeys = new Set<string>()
  for (const [key, entry] of input.retainedEntries) {
    if (isAntigravityCliHistoryCorrectionKey(key)) {
      input.cursor.files[key] = entry
      continue
    }
    if (isCliHistorySessionKey(key)) continue
    const snapshots = entry.snapshots.filter(
      (snapshot) =>
        !input.rebuiltSnapshotGroups.has(cliHistorySnapshotGroupKey(snapshot)) &&
        !missingAcknowledgedSnapshots.has(cliHistorySnapshotGroupKey(snapshot))
    )
    if (snapshots.length === 0) continue
    const restoredEntry = { ...entry, snapshots }
    input.cursor.files[key] = restoredEntry
    for (const sessionKey of cliHistorySessionKeysForEntry(key, restoredEntry)) {
      retainedSessionKeys.add(sessionKey)
    }
  }
  for (const [key, entry] of input.retainedEntries) {
    if (!isCliHistorySessionKey(key) || !retainedSessionKeys.has(key)) continue
    input.cursor.files[key] = entry
  }

  for (const [groupKey, snapshot] of missingAcknowledgedSnapshots) {
    if (retainedCorrectionGroups.has(groupKey)) continue
    const key = correctionKey(snapshot)
    if (input.cursor.files[key]) continue
    input.cursor.files[key] = newCorrectionEntry(zeroCorrectionSnapshot(snapshot), collectedAt)
  }
}

export function markCliHistoryFullScanComplete(cursor: CursorState) {
  cursor.antigravityCliHistoryComplete = true
}

function hasLegacyCliMeteringState(cursor: CursorState) {
  return (
    cursor.antigravityHistoryAliasMtimes !== undefined ||
    cursor.antigravityHistoryReplayReady !== undefined ||
    cursor.antigravityStatuslineReplayReady !== undefined ||
    cursor.antigravityHistoryReplayCompacted !== undefined ||
    cursor.antigravityStatuslineReplayCompacted !== undefined ||
    cursor.lastScanOffsetBytes !== undefined ||
    cursor.lastScanGeneration !== undefined ||
    cursor.lastScanPrefixSha256 !== undefined ||
    Object.keys(cursor.files).some((key) => !key.startsWith('db-row\0antigravity-cli\0'))
  )
}

function correctionSnapshots(cursor: CursorState) {
  const snapshots = new Map<string, CursorSnapshot>()
  for (const entry of Object.values(cursor.files)) {
    for (const snapshot of entry.snapshots) {
      if (snapshot.source !== 'antigravity-cli') continue
      const key = snapshotGroupKey(snapshot)
      snapshots.set(key, {
        source: snapshot.source,
        usageDate: snapshot.usageDate,
        timezone: snapshot.timezone,
        model: snapshot.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        sessionCount: 0
      })
    }
  }
  return [...snapshots.values()]
}

function resetLegacyCliMeteringState(cursor: CursorState) {
  cursor.files = {}
  cursor.antigravityDbFileScan = { nextSequence: 0, files: {} }
  delete cursor.lastScanOffsetBytes
  delete cursor.lastScanGeneration
  delete cursor.lastScanPrefixSha256
  delete cursor.antigravityHistoryAliasMtimes
  delete cursor.antigravityHistoryReplayReady
  delete cursor.antigravityStatuslineReplayReady
  delete cursor.antigravityHistoryReplayCompacted
  delete cursor.antigravityStatuslineReplayCompacted
  delete cursor.antigravityCliHistoryCompacted
  delete cursor.antigravityCliHistoryCompactedThroughDate
  delete cursor.antigravityCliHistoryComplete
}

function correctionKey(snapshot: CursorSnapshot) {
  return `${antigravityCliHistoryCorrectionPrefix}${hash(snapshotGroupKey(snapshot))}`
}

function newCorrectionEntry(snapshot: CursorSnapshot, collectedAt: string): CursorEntry {
  const key = correctionKey(snapshot)
  return {
    size: 0,
    mtimeMs: Date.parse(collectedAt),
    sha256: hash(key),
    snapshots: [snapshot],
    missingCost: true,
    pendingUpload: true,
    updatedAt: collectedAt
  }
}

function zeroCorrectionSnapshot(snapshot: CursorSnapshot): CursorSnapshot {
  return {
    source: snapshot.source,
    usageDate: snapshot.usageDate,
    timezone: snapshot.timezone,
    model: snapshot.model,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    sessionCount: 0
  }
}

function snapshotGroupKey(snapshot: CursorSnapshot) {
  return cliHistorySnapshotGroupKey(snapshot)
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
