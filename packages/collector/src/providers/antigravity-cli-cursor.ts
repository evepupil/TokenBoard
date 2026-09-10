import { createHash } from 'node:crypto'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import type { AntigravityUsageEvent } from './antigravity-gui-parser'
import { formatDate } from './session-jsonl-parser-utils'
import {
  readCursor,
  stripCollectedAt,
  type CursorEntry,
  type CursorState,
  type CursorSnapshot
} from './session-cursor-store'

const source = 'antigravity-cli'
const historyEventPrefix = 'history-event\0'
const sessionPrefix = `session\0${source}\0`
const aggregatePrefix = 'aggregate\0'

type AntigravityCliCursor = Awaited<ReturnType<typeof readCursor>>

export function pushCliHistoryUsageEvent(input: {
  event: AntigravityUsageEvent
  cursor: AntigravityCliCursor
  snapshots: UsageSnapshot[]
  emittedKeys: Set<string>
  timezone: string
  collectedAt: string
}) {
  const eventKey = cliHistoryEventKey(input.event)
  const existing = input.cursor.files[eventKey]
  if (existing) {
    if (existing.pendingUpload) {
      pushCachedSnapshots(input.snapshots, existing, input.collectedAt, input.emittedKeys, eventKey)
    }
    return
  }

  const snapshot = buildSnapshot(input)
  input.cursor.files[eventKey] = newCursorEntry({
    snapshots: [stripCollectedAt(snapshot)],
    marker: eventKey,
    mtimeMs: Date.parse(input.event.createdAt),
    pendingUpload: true,
    collectedAt: input.collectedAt
  })
  input.snapshots.push(snapshot)
  input.emittedKeys.add(eventKey)
}

export function pushCompleteCliCursorSnapshots(
  snapshots: UsageSnapshot[],
  cursor: AntigravityCliCursor,
  collectedAt: string,
  emittedKeys: Set<string>,
  includeSnapshot: (snapshot: CursorSnapshot) => boolean = () => true
) {
  const dirtyGroups = new Set<string>()
  for (const entry of Object.values(cursor.files)) {
    if (!entry.pendingUpload || entry.snapshots.length === 0) continue
    for (const snapshot of entry.snapshots.filter(includeSnapshot)) {
      dirtyGroups.add(cliHistorySnapshotGroupKey(snapshot))
    }
  }

  for (const snapshot of snapshots) {
    dirtyGroups.add(cliHistorySnapshotGroupKey(snapshot))
  }

  for (const [eventKey, entry] of Object.entries(cursor.files)) {
    if (entry.snapshots.length === 0) continue
    if (!entry.snapshots.some((snapshot) => dirtyGroups.has(cliHistorySnapshotGroupKey(snapshot)))) continue
    pushCachedSnapshots(snapshots, entry, collectedAt, emittedKeys, eventKey, includeSnapshot)
  }
}

export function cliHistoryEventKey(event: AntigravityUsageEvent) {
  return `${historyEventPrefix}${event.cascadeHash}\0${event.eventHash}`
}

export function cliHistorySessionKey(input: { cascadeHash: string; usageDate: string; model: string }) {
  return `${sessionPrefix}${input.usageDate}\0${input.model}\0${input.cascadeHash}`
}

export function cliHistorySnapshotGroupKey(
  snapshot: Pick<CursorSnapshot, 'source' | 'usageDate' | 'timezone' | 'model'>
) {
  return [snapshot.source, snapshot.usageDate, snapshot.timezone, snapshot.model].join('\0')
}

export function cliHistorySnapshotGroupFromEvent(event: AntigravityUsageEvent, timezone: string) {
  return [source, formatDate(new Date(event.createdAt), timezone), timezone, event.model].join('\0')
}

export function cliHistoryAggregateKey(groupKey: string) {
  return `${aggregatePrefix}${hash(groupKey)}`
}

export function isCliHistoryEventKey(key: string) {
  return key.startsWith(historyEventPrefix)
}

export function isCliHistorySessionKey(key: string) {
  return key.startsWith(sessionPrefix)
}

export function isCliHistoryAggregateKey(key: string) {
  return key.startsWith(aggregatePrefix)
}

export function isCliHistoryStateKey(key: string) {
  return isCliHistoryEventKey(key) || isCliHistorySessionKey(key) || isCliHistoryAggregateKey(key)
}

export function cliHistorySessionKeysForEntry(key: string, entry: CursorEntry) {
  const cascadeHash = cliHistoryCascadeHash(key)
  if (!cascadeHash) return []
  return entry.snapshots.map((snapshot) =>
    cliHistorySessionKey({
      cascadeHash,
      usageDate: snapshot.usageDate,
      model: snapshot.model
    })
  )
}

export function assertCliHistoryEventsCanApplyIncrementally(input: {
  cursor: CursorState
  events: readonly AntigravityUsageEvent[]
  timezone: string
}) {
  for (const event of input.events) {
    const eventKey = cliHistoryEventKey(event)
    if (input.cursor.files[eventKey]) continue
    if (!isWithinCliHistoryCompactedFrontier(input.cursor, event, input.timezone)) continue
    throw new Error(
      'Antigravity CLI history contains an event whose compacted session identity cannot be reconciled incrementally; rerun with --since all'
    )
  }
}

function isWithinCliHistoryCompactedFrontier(cursor: CursorState, event: AntigravityUsageEvent, timezone: string) {
  const compactedThroughDate = cursor.antigravityCliHistoryCompactedThroughDate
  if (!compactedThroughDate) return false
  return formatDate(new Date(event.createdAt), timezone) <= compactedThroughDate
}

function buildSnapshot(input: {
  event: AntigravityUsageEvent
  cursor: AntigravityCliCursor
  timezone: string
  collectedAt: string
}) {
  const usageDate = formatDate(new Date(input.event.createdAt), input.timezone)
  const sessionKey = cliHistorySessionKey({
    cascadeHash: input.event.cascadeHash,
    usageDate,
    model: input.event.model
  })
  const sessionEntry = input.cursor.files[sessionKey]
  const capturedAtMs = Date.parse(input.event.createdAt)
  if (!sessionEntry) {
    input.cursor.files[sessionKey] = newCursorEntry({
      snapshots: [],
      marker: sessionKey,
      mtimeMs: capturedAtMs,
      pendingUpload: true,
      collectedAt: input.collectedAt
    })
  } else if (capturedAtMs > sessionEntry.mtimeMs) {
    sessionEntry.mtimeMs = capturedAtMs
    sessionEntry.updatedAt = input.collectedAt
  }

  return {
    source,
    usageDate,
    timezone: input.timezone,
    model: input.event.model,
    inputTokens: input.event.inputTokens,
    outputTokens: input.event.outputTokens,
    cacheCreationTokens: input.event.cacheCreationTokens,
    cacheReadTokens: input.event.cacheReadTokens,
    totalTokens:
      input.event.inputTokens +
      input.event.outputTokens +
      input.event.cacheCreationTokens +
      input.event.cacheReadTokens,
    costUsd: 0,
    sessionCount: sessionEntry ? 0 : 1,
    collectedAt: input.collectedAt
  } satisfies UsageSnapshot
}

function pushCachedSnapshots(
  snapshots: UsageSnapshot[],
  entry: CursorEntry,
  collectedAt: string,
  emittedKeys: Set<string>,
  eventKey: string,
  includeSnapshot: (snapshot: CursorSnapshot) => boolean = () => true
) {
  if (emittedKeys.has(eventKey)) return
  snapshots.push(...entry.snapshots.filter(includeSnapshot).map((snapshot) => ({ ...snapshot, collectedAt })))
  emittedKeys.add(eventKey)
}

function newCursorEntry(input: {
  snapshots: Array<Omit<UsageSnapshot, 'collectedAt'>>
  marker: string
  mtimeMs: number
  pendingUpload: boolean
  collectedAt: string
}): CursorEntry {
  return {
    size: 0,
    mtimeMs: Number.isFinite(input.mtimeMs) ? input.mtimeMs : 0,
    sha256: hash(input.marker),
    snapshots: input.snapshots,
    missingCost: true,
    pendingUpload: input.pendingUpload,
    updatedAt: input.collectedAt
  }
}

function cliHistoryCascadeHash(key: string) {
  if (!isCliHistoryEventKey(key)) return undefined
  const [cascadeHash, eventHash] = key.slice(historyEventPrefix.length).split('\0')
  return /^[a-f0-9]{64}$/.test(cascadeHash) && /^[a-f0-9]{64}$/.test(eventHash) ? cascadeHash : undefined
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
