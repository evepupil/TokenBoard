import { homedir } from 'node:os'
import { join } from 'node:path'
import { usageSnapshotSchema, type UsageSnapshot } from '@tokenboard/usage-core'
import { cursorFileName, readCursor, withCursorLock, writeCursor } from './session-cursor-store'
import { mergeSnapshots, selectPendingCursorSnapshotGroups, shouldIncludeCursorSnapshot } from './session-cursor'
import { readAntigravityDbUsageEvents, type AntigravityDbUsageResult } from './antigravity-history-db'
import type { AntigravityUsageEvent } from './antigravity-gui-parser'
import {
  lastSeenCliDbRowIndexByCascadeHash,
  markCliDbRowsProcessed,
  unanchoredCliDbRowCursorHashes
} from './antigravity-cli-db-cursor'
import { resolveAntigravityCollectionRange, type AntigravityCollectionRange } from './antigravity-since'
import {
  assertCliHistoryEventsCanApplyIncrementally,
  cliHistorySnapshotGroupFromEvent,
  pushCliHistoryUsageEvent,
  pushCompleteCliCursorSnapshots
} from './antigravity-cli-cursor'
import {
  applyAntigravityCliHistoryAuthorityMigration,
  markCliHistoryFullScanComplete,
  planAntigravityCliHistoryAuthorityMigration,
  prepareCliHistoryFullRebuild,
  restoreCliHistoryEntriesOutsideFullRebuild,
  shouldRebuildCliHistoryFromFullScan
} from './antigravity-cli-history-authority'

const source = 'antigravity-cli'

export type CollectAntigravityCliUsageOptions = {
  timezone?: string
  collectedAt?: string
  stateDir?: string
  conversationDir?: string
  cursorScope?: string
  since?: string
  maxDbFiles?: number | null
  readDbUsageEvents?: (input: {
    lastSeenRowIndexByCascadeHash: Map<string, number>
    maxDbFiles?: number | null
    sinceDate?: string
    timezone?: string
    detectRowCursorReset?: boolean
    requireCompleteDirectoryScan?: boolean
    forceFullScanCascadeHashes?: ReadonlySet<string>
  }) => Promise<AntigravityDbUsageResult>
}

export async function collectAntigravityCliUsage(
  options: CollectAntigravityCliUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const stateDir = options.stateDir ?? readStateDir()
  const cursorPath = join(stateDir, cursorFileName(source, options.cursorScope))
  return withCursorLock(cursorPath, () =>
    collectAntigravityCliUsageLocked({
      options,
      timezone,
      collectedAt,
      cursorPath
    })
  )
}

async function collectAntigravityCliUsageLocked(input: {
  options: CollectAntigravityCliUsageOptions
  timezone: string
  collectedAt: string
  cursorPath: string
}) {
  const { options, timezone, collectedAt, cursorPath } = input
  const cursor = await readCursor(cursorPath, source)
  const range = resolveAntigravityCollectionRange({ since: options.since, timezone })
  assertFullHistoryCanReadEveryDatabase(range, options.maxDbFiles)
  const migration = planAntigravityCliHistoryAuthorityMigration({
    cursor,
    fullHistory: range.fullHistory
  })
  // A legacy cursor must be rebuilt from SQLite before it becomes authoritative.
  // Keep the persisted cursor untouched until that read completes successfully.
  const rebuildFullHistory = shouldRebuildCliHistoryFromFullScan({
    cursor,
    fullHistory: range.fullHistory
  })
  const nextCursor = migration.required || rebuildFullHistory ? structuredClone(cursor) : cursor
  if (migration.required) {
    applyAntigravityCliHistoryAuthorityMigration({
      cursor: nextCursor,
      collectedAt,
      corrections: migration.corrections,
      reset: migration.reset
    })
  }
  const retainedEntries = rebuildFullHistory ? prepareCliHistoryFullRebuild(nextCursor) : []
  const pendingSnapshotGroups = selectPendingCursorSnapshotGroups({
    cursor: nextCursor,
    sinceDate: range.sinceDate
  })
  nextCursor.antigravityDbFileScan ??= { nextSequence: 0, files: {} }
  const emittedKeys = new Set<string>()
  const snapshots: UsageSnapshot[] = []
  const localDbUsage = await readLocalDbUsage(options, nextCursor, range, timezone)
  assertFullHistoryDirectoryScanComplete(range, localDbUsage)
  const historyEvents = localDbUsage.events.filter((item) => range.includesTimestamp(item.createdAt))
  assertBoundedCliHistoryScanComplete({
    cursor: nextCursor,
    localDbUsage,
    range
  })
  if (!rebuildFullHistory) {
    assertCliHistoryEventsCanApplyIncrementally({
      cursor: nextCursor,
      events: historyEvents,
      timezone
    })
  }
  for (const event of historyEvents) {
    pushCliHistoryUsageEvent({
      event,
      cursor: nextCursor,
      snapshots,
      emittedKeys,
      timezone,
      collectedAt
    })
  }
  markCliDbRowsProcessed({
    cursor: nextCursor,
    knownCascadeIds: localDbUsage.knownCascadeIds,
    lastReadRowIndexByCascade: localDbUsage.lastReadRowIndexByCascade,
    historyScope: range.historyScope
  })
  if (rebuildFullHistory) {
    restoreCliHistoryEntriesOutsideFullRebuild({
      cursor: nextCursor,
      retainedEntries,
      rebuiltSnapshotGroups: new Set(historyEvents.map((event) => cliHistorySnapshotGroupFromEvent(event, timezone))),
      collectedAt
    })
    markCliHistoryFullScanComplete(nextCursor)
  }
  pushCompleteCliCursorSnapshots(snapshots, nextCursor, collectedAt, emittedKeys, (snapshot) =>
    shouldIncludeCursorSnapshot(snapshot, range.sinceDate, pendingSnapshotGroups)
  )
  const merged = mergeSnapshots(snapshots).map((snapshot) => usageSnapshotSchema.parse(snapshot))
  await writeCursor(cursorPath, nextCursor)
  return merged
}

async function readLocalDbUsage(
  options: CollectAntigravityCliUsageOptions,
  cursor: Awaited<ReturnType<typeof readCursor>>,
  range: AntigravityCollectionRange,
  timezone: string
) {
  const lastSeenRowIndexByCascadeHash = lastSeenCliDbRowIndexByCascadeHash({
    cursor,
    historyScope: range.historyScope
  })
  if (options.readDbUsageEvents) {
    const maxDbFiles = resolveMaxDbFiles(options.maxDbFiles, range)
    const unanchoredCascadeHashes = unanchoredCliDbRowCursorHashes({
      cursor,
      historyScope: range.historyScope
    })
    const readOptions = {
      lastSeenRowIndexByCascadeHash,
      maxDbFiles,
      sinceDate: range.sinceDate,
      timezone,
      detectRowCursorReset: lastSeenRowIndexByCascadeHash.size > 0,
      requireCompleteDirectoryScan: range.fullHistory || maxDbFiles === null,
      ...(unanchoredCascadeHashes.size > 0 ? { forceFullScanCascadeHashes: unanchoredCascadeHashes } : {})
    }
    return options.readDbUsageEvents(readOptions)
  }
  const maxDbFiles = resolveMaxDbFiles(options.maxDbFiles, range)
  const unanchoredCascadeHashes = unanchoredCliDbRowCursorHashes({
    cursor,
    historyScope: range.historyScope
  })
  return readAntigravityDbUsageEvents({
    conversationDir: options.conversationDir ?? defaultConversationDir(),
    lastSeenRowIndexByCascadeHash,
    maxDbFiles,
    scanState: cursor.antigravityDbFileScan,
    sinceDate: range.sinceDate,
    timezone,
    detectRowCursorReset: lastSeenRowIndexByCascadeHash.size > 0,
    requireCompleteDirectoryScan: range.fullHistory || maxDbFiles === null,
    forceFullScanCascadeHashes: unanchoredCascadeHashes.size > 0 ? unanchoredCascadeHashes : undefined
  })
}

function assertBoundedCliHistoryScanComplete(input: {
  cursor: Awaited<ReturnType<typeof readCursor>>
  localDbUsage: AntigravityDbUsageResult
  range: AntigravityCollectionRange
}) {
  if (
    input.range.fullHistory ||
    input.cursor.antigravityCliHistoryComplete === true ||
    input.localDbUsage.completeDirectoryScan !== false
  ) {
    return
  }
  throw new Error(
    'Antigravity CLI requires --since all before a bounded scan can complete an incomplete SQLite directory scan'
  )
}

function assertFullHistoryDirectoryScanComplete(
  range: AntigravityCollectionRange,
  localDbUsage: AntigravityDbUsageResult
) {
  if (range.fullHistory && localDbUsage.completeDirectoryScan === false) {
    throw new Error('Antigravity CLI --since all requires a complete SQLite directory scan')
  }
}

function resolveMaxDbFiles(value: number | null | undefined, range: AntigravityCollectionRange) {
  return value === undefined ? defaultMaxDbFilesForCurrentRun(range) : value
}

function assertFullHistoryCanReadEveryDatabase(
  range: AntigravityCollectionRange,
  maxDbFiles: number | null | undefined
) {
  if (range.fullHistory && maxDbFiles !== undefined && maxDbFiles !== null) {
    throw new Error('Antigravity CLI --since all requires an unbounded SQLite database scan')
  }
}

function defaultMaxDbFilesForCurrentRun(range: AntigravityCollectionRange) {
  return range.fullHistory ? null : undefined
}

function readStateDir() {
  return process.env.TOKENBOARD_STATE_DIR || process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

function defaultConversationDir() {
  return join(homedir(), '.gemini', source, 'conversations')
}
