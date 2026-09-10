import { usageSnapshotSchema, type UsageSnapshot } from '@tokenboard/usage-core'
import { formatDate } from './session-jsonl-parser-utils'
import {
  antigravityGuiDbResetCorrectionPrefix,
  readCursor,
  stripCollectedAt,
  type AntigravityUsageOrigin,
  type CursorEntry,
  type CursorSnapshot
} from './session-cursor-store'
import { hash, type AntigravityUsageEvent } from './antigravity-gui-parser'
import type { AntigravityCascadeRef } from './antigravity-gui-client'
import type { AntigravityGuiSource } from './antigravity-gui'
import { isReusableAntigravityHistoryScope } from './antigravity-since'

type AntigravityGuiCursor = Awaited<ReturnType<typeof readCursor>>

export type EmptyCascadeFrontier = {
  mtimeMs: number
  cascadeHash: string
}

export function prepareGuiHistoryScope(input: {
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
  historyScope: string
}) {
  if (input.historyScope === 'all') return
  const candidates = Object.entries(input.cursor.files)
    .map(([key, entry]) => ({ key, entry, parsed: parseBoundedGuiCursorKey(key, input.source) }))
    .filter(
      (
        candidate
      ): candidate is {
        key: string
        entry: CursorEntry
        parsed: { scope: string; parts: string[] }
      } => candidate.parsed !== null
    )
  const migrated = new Map<string, { entry: CursorEntry; kind: string }>()

  for (const candidate of candidates) {
    delete input.cursor.files[candidate.key]
    if (!isReusableAntigravityHistoryScope(candidate.parsed.scope, input.historyScope)) continue
    candidate.parsed.parts[2] = `since:${input.historyScope}`
    const nextKey = candidate.parsed.parts.join('\0')
    const current = migrated.get(nextKey)
    const next = current
      ? mergeBoundedGuiCursorEntry(current, { entry: candidate.entry, kind: candidate.parsed.parts[0] })
      : { entry: candidate.entry, kind: candidate.parsed.parts[0] }
    migrated.set(nextKey, next)
  }
  for (const [key, value] of migrated) {
    input.cursor.files[key] = value.entry
  }
}

function mergeBoundedGuiCursorEntry(
  left: { entry: CursorEntry; kind: string },
  right: { entry: CursorEntry; kind: string }
) {
  if (left.kind === 'cascade-empty-frontier') {
    if (right.entry.mtimeMs < left.entry.mtimeMs) return right
    if (right.entry.mtimeMs === left.entry.mtimeMs && right.entry.sha256 > left.entry.sha256) return right
    return left
  }
  if (right.entry.mtimeMs > left.entry.mtimeMs) return right
  if (right.entry.mtimeMs === left.entry.mtimeMs && right.entry.size > left.entry.size) return right
  return left
}

export function pushGuiUsageEvent(input: {
  event: AntigravityUsageEvent
  origin: AntigravityUsageOrigin
  cursor: AntigravityGuiCursor
  snapshots: UsageSnapshot[]
  emittedKeys: Set<string>
  timezone: string
  collectedAt: string
  source: AntigravityGuiSource
}) {
  const eventKey = usageEventKey(input.event)
  const existing = input.cursor.files[eventKey]
  if (existing) {
    if (existing.pendingUpload)
      pushCachedSnapshots(input.snapshots, existing, input.collectedAt, input.emittedKeys, eventKey)
    return
  }
  const snapshot = buildSnapshot(input)
  input.cursor.files[eventKey] = newCursorEntry({
    snapshots: [stripCollectedAt(snapshot)],
    marker: eventKey,
    mtimeMs: Date.parse(input.event.createdAt),
    pendingUpload: true,
    antigravityOrigin: input.origin
  })
  input.snapshots.push(snapshot)
  input.emittedKeys.add(eventKey)
}

export function pushCompleteGuiCursorSnapshots(
  snapshots: UsageSnapshot[],
  cursor: AntigravityGuiCursor,
  collectedAt: string,
  emittedKeys: Set<string>,
  includeSnapshot: (snapshot: CursorSnapshot) => boolean = () => true
) {
  const dirtyGroups = new Set<string>()
  for (const entry of Object.values(cursor.files)) {
    if (!entry.pendingUpload || entry.snapshots.length === 0) continue
    for (const snapshot of entry.snapshots.filter(includeSnapshot)) {
      dirtyGroups.add(snapshotGroupKey(snapshot))
    }
  }

  for (const snapshot of snapshots) {
    dirtyGroups.add(snapshotGroupKey(snapshot))
  }

  for (const [eventKey, entry] of Object.entries(cursor.files)) {
    if (entry.snapshots.length === 0) continue
    if (!entry.snapshots.some((snapshot) => dirtyGroups.has(snapshotGroupKey(snapshot)))) continue
    pushCachedSnapshots(snapshots, entry, collectedAt, emittedKeys, eventKey, includeSnapshot)
  }
}

export function shouldRequestCascade(input: {
  cascade: AntigravityCascadeRef
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
  historyScope?: string
}) {
  const entry = input.cursor.files[cascadeCursorKey(input.source, input.cascade.id, input.historyScope ?? 'all')]
  return !entry || entry.mtimeMs !== input.cascade.mtimeMs || entry.size !== input.cascade.size
}

export function readEmptyCascadeFrontier(input: {
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
  historyScope?: string
}): EmptyCascadeFrontier | null {
  const entry = input.cursor.files[emptyCascadeFrontierCursorKey(input.source, input.historyScope ?? 'all')]
  return entry ? { mtimeMs: entry.mtimeMs, cascadeHash: entry.sha256 } : null
}

export function markEmptyCascadeAttempted(input: {
  cascade: AntigravityCascadeRef
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
  historyScope?: string
}) {
  const key = emptyCascadeFrontierCursorKey(input.source, input.historyScope ?? 'all')
  input.cursor.files[key] = newCursorEntry({
    snapshots: [],
    marker: input.cascade.id,
    mtimeMs: input.cascade.mtimeMs,
    pendingUpload: false,
    size: input.cascade.size
  })
}

export function markCascadeProcessed(input: {
  cascade: AntigravityCascadeRef
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
  historyScope?: string
}) {
  const key = cascadeCursorKey(input.source, input.cascade.id, input.historyScope ?? 'all')
  input.cursor.files[key] = newCursorEntry({
    snapshots: [],
    marker: key,
    mtimeMs: input.cascade.mtimeMs,
    pendingUpload: false,
    size: input.cascade.size
  })
}

export function hasDbCascadeRowsProcessed(input: {
  cascade: AntigravityCascadeRef
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
  historyScope?: string
}) {
  const entry =
    input.cursor.files[dbCoveredCascadeCursorKey(input.source, input.cascade.id, input.historyScope ?? 'all')]
  return entry !== undefined && entry.mtimeMs === input.cascade.mtimeMs && entry.size === input.cascade.size
}

export function lastSeenDbRowIndexByCascadeHash(input: {
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
  historyScope?: string
}) {
  const historyScope = input.historyScope ?? 'all'
  const reusableScope =
    historyScope !== 'all' ? latestReusableDbScope(input.cursor, input.source, historyScope) : historyScope
  const prefix = dbCascadeCursorPrefixForScope(input.source, reusableScope ?? historyScope)
  const indexes = new Map<string, number>()
  for (const [key, entry] of Object.entries(input.cursor.files)) {
    if (!key.startsWith(prefix)) continue
    const hash = key.slice(prefix.length)
    if (/^[a-f0-9]{64}$/.test(hash)) indexes.set(hash, entry.mtimeMs)
  }
  return indexes
}

export function hasUnanchoredDbRowCursor(input: {
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
  historyScope?: string
}) {
  return unanchoredDbRowCursorHashes(input).size > 0
}

export function unanchoredDbRowCursorHashes(input: {
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
  historyScope?: string
}) {
  const rowIndexes = lastSeenDbRowIndexByCascadeHash(input)
  if (rowIndexes.size === 0) return new Set<string>()
  const scanFiles = input.cursor.antigravityDbFileScan?.files
  const unanchored = new Set<string>()
  for (const [cascadeHash, rowIndex] of rowIndexes.entries()) {
    const entry = scanFiles?.[cascadeHash] as
      | {
          metadataCursorRowIndex?: unknown
          metadataCursorRowSha256?: unknown
        }
      | undefined
    if (
      !entry ||
      !Number.isSafeInteger(entry.metadataCursorRowIndex) ||
      entry.metadataCursorRowIndex !== rowIndex ||
      typeof entry.metadataCursorRowSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.metadataCursorRowSha256)
    ) {
      unanchored.add(cascadeHash)
    }
  }
  return unanchored
}

export function resetGuiDbCursorState(input: { cursor: AntigravityGuiCursor; source: AntigravityGuiSource }) {
  assertGuiDbResetStateIsClassified(input)
  assertGuiDbResetHasNoPendingDatabaseUsage(input)
  const corrections = collectGuiDbResetCorrections(input.cursor)
  const rowPrefix = dbCascadeCursorPrefix(input.source)
  const coveredPrefix = dbCoveredCascadeCursorPrefix(input.source)
  for (const key of Object.keys(input.cursor.files)) {
    if (key.startsWith(rowPrefix) || key.startsWith(coveredPrefix)) {
      delete input.cursor.files[key]
    }
  }
  for (const [key, entry] of Object.entries(input.cursor.files)) {
    if (isDatabaseGuiUsageEntry(key, entry)) {
      delete input.cursor.files[key]
    }
  }
  for (const [key, entry] of Object.entries(input.cursor.files)) {
    if (isGuiSessionKey(key, input.source) && entry.antigravityOrigin === 'database') {
      delete input.cursor.files[key]
    }
  }
  input.cursor.antigravityDbFileScan = { nextSequence: 0, files: {} }
  return corrections
}

export function queueGuiDbResetCorrections(input: {
  cursor: AntigravityGuiCursor
  corrections: CursorSnapshot[]
  collectedAt: string
}) {
  for (const snapshot of input.corrections) {
    const key = guiDbResetCorrectionKey(snapshot)
    input.cursor.files[key] = newCursorEntry({
      snapshots: [snapshot],
      marker: key,
      mtimeMs: Date.parse(input.collectedAt),
      pendingUpload: true,
      antigravityOrigin: 'database',
      updatedAt: input.collectedAt
    })
  }
}

function assertGuiDbResetStateIsClassified(input: { cursor: AntigravityGuiCursor; source: AntigravityGuiSource }) {
  for (const [key, entry] of Object.entries(input.cursor.files)) {
    if (isGuiUsageStateKey(key, input.source) && entry.antigravityOrigin === undefined) {
      throw new Error(
        'Antigravity SQLite metadata cursor reset cannot safely classify legacy database or language-server usage state'
      )
    }
  }
}

export function assertGuiDbResetHasNoPendingDatabaseUsage(input: {
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
}) {
  for (const [key, entry] of Object.entries(input.cursor.files)) {
    if (!entry.pendingUpload) continue
    if (entry.antigravityOrigin === 'database' && !isGuiDbResetCorrectionKey(key)) {
      throw new Error('Antigravity SQLite metadata cursor reset cannot discard pending database usage')
    }
  }
}

export function markDbCascadeRowsProcessed(input: {
  cursor: AntigravityGuiCursor
  coveredCascadeIds?: Set<string>
  coveredCascades?: AntigravityCascadeRef[]
  source: AntigravityGuiSource
  lastReadRowIndexByCascade?: Map<string, number>
  historyScope?: string
}) {
  const historyScope = input.historyScope ?? 'all'
  const prefix = dbCascadeCursorPrefixForScope(input.source, historyScope)
  if (historyScope !== 'all') {
    const boundedPrefix = dbCascadeBoundedCursorPrefix(input.source)
    for (const key of Object.keys(input.cursor.files)) {
      if (key.startsWith(boundedPrefix) && !key.startsWith(prefix)) delete input.cursor.files[key]
    }
  }
  for (const [cascadeId, rowIndex] of input.lastReadRowIndexByCascade ?? []) {
    const key = `${prefix}${hash(cascadeId)}`
    input.cursor.files[key] = newCursorEntry({
      snapshots: [],
      marker: key,
      mtimeMs: rowIndex,
      pendingUpload: false
    })
  }
  const coveredCascadeIds = input.coveredCascadeIds ?? new Set<string>()
  for (const cascade of input.coveredCascades ?? []) {
    if (!coveredCascadeIds.has(cascade.id)) continue
    const key = dbCoveredCascadeCursorKey(input.source, cascade.id, historyScope)
    input.cursor.files[key] = newCursorEntry({
      snapshots: [],
      marker: key,
      mtimeMs: cascade.mtimeMs,
      pendingUpload: false,
      size: cascade.size
    })
  }
}

function buildSnapshot(input: {
  event: AntigravityUsageEvent
  origin: AntigravityUsageOrigin
  cursor: AntigravityGuiCursor
  timezone: string
  collectedAt: string
  source: AntigravityGuiSource
}) {
  const usageDate = formatDate(new Date(input.event.createdAt), input.timezone)
  const sessionKey = usageSessionKey(input.event, usageDate, input.source)
  const sessionEntry = input.cursor.files[sessionKey]
  if (!sessionEntry) {
    input.cursor.files[sessionKey] = newCursorEntry({
      snapshots: [],
      marker: sessionKey,
      mtimeMs: Date.parse(input.event.createdAt),
      pendingUpload: true,
      antigravityOrigin: input.origin
    })
  }
  return usageSnapshotSchema.parse({
    source: input.source,
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
  })
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
  size?: number
  antigravityOrigin?: AntigravityUsageOrigin
  updatedAt?: string
}): CursorEntry {
  return {
    size: input.size ?? 0,
    mtimeMs: Number.isFinite(input.mtimeMs) ? input.mtimeMs : 0,
    sha256: hash(input.marker),
    snapshots: input.snapshots,
    missingCost: true,
    pendingUpload: input.pendingUpload,
    ...(input.antigravityOrigin ? { antigravityOrigin: input.antigravityOrigin } : {}),
    updatedAt: input.updatedAt ?? new Date().toISOString()
  }
}

function usageEventKey(event: AntigravityUsageEvent) {
  return ['event', event.cascadeHash, event.eventHash].join('\0')
}

function isDatabaseGuiUsageEntry(key: string, entry: CursorEntry) {
  return entry.antigravityOrigin === 'database' && (isGuiUsageEventKey(key) || isGuiAggregateEntry(key))
}

export function isGuiDbResetCorrectionKey(key: string) {
  return key.startsWith(antigravityGuiDbResetCorrectionPrefix)
}

function collectGuiDbResetCorrections(cursor: AntigravityGuiCursor) {
  const corrections = new Map<string, CursorSnapshot>()
  for (const [key, entry] of Object.entries(cursor.files)) {
    if (!isDatabaseGuiUsageEntry(key, entry)) continue
    for (const snapshot of entry.snapshots) {
      const correction = zeroGuiSnapshot(snapshot)
      corrections.set(snapshotGroupKey(correction), correction)
    }
  }
  return [...corrections.values()]
}

function zeroGuiSnapshot(snapshot: CursorSnapshot): CursorSnapshot {
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

function guiDbResetCorrectionKey(snapshot: CursorSnapshot) {
  return `${antigravityGuiDbResetCorrectionPrefix}${hash(snapshotGroupKey(snapshot))}`
}

function isGuiUsageEventKey(key: string) {
  const [kind, cascadeHash, eventHash] = key.split('\0')
  return kind === 'event' && /^[a-f0-9]{64}$/.test(cascadeHash ?? '') && /^[a-f0-9]{64}$/.test(eventHash ?? '')
}

function isGuiAggregateEntry(key: string) {
  return key.startsWith('aggregate\0')
}

function isGuiSessionKey(key: string, source: AntigravityGuiSource) {
  const parts = key.split('\0')
  return parts[0] === 'session' && parts[1] === source && /^[a-f0-9]{64}$/.test(parts[4] ?? '')
}

function isGuiUsageStateKey(key: string, source: AntigravityGuiSource) {
  return isGuiUsageEventKey(key) || isGuiSessionKey(key, source) || isGuiAggregateEntry(key)
}

function cascadeCursorKey(source: AntigravityGuiSource, cascadeId: string, historyScope: string) {
  return historyScope === 'all'
    ? ['cascade', source, hash(cascadeId)].join('\0')
    : ['cascade', source, `since:${historyScope}`, hash(cascadeId)].join('\0')
}

function emptyCascadeFrontierCursorKey(source: AntigravityGuiSource, historyScope: string) {
  return historyScope === 'all'
    ? ['cascade-empty-frontier', source].join('\0')
    : ['cascade-empty-frontier', source, `since:${historyScope}`].join('\0')
}

function dbCoveredCascadeCursorKey(source: AntigravityGuiSource, cascadeId: string, historyScope: string) {
  const prefix = dbCoveredCascadeCursorPrefix(source)
  return historyScope === 'all' ? `${prefix}${hash(cascadeId)}` : `${prefix}since:${historyScope}\0${hash(cascadeId)}`
}

function dbCoveredCascadeCursorPrefix(source: AntigravityGuiSource) {
  return ['db-covered', source, ''].join('\0')
}

function dbCascadeCursorPrefix(source: AntigravityGuiSource) {
  return ['db', source, ''].join('\0')
}

function dbCascadeBoundedCursorPrefix(source: AntigravityGuiSource) {
  return `${dbCascadeCursorPrefix(source)}since:`
}

function dbCascadeCursorPrefixForScope(source: AntigravityGuiSource, historyScope: string) {
  return historyScope === 'all'
    ? dbCascadeCursorPrefix(source)
    : `${dbCascadeBoundedCursorPrefix(source)}${historyScope}\0`
}

function latestReusableDbScope(cursor: AntigravityGuiCursor, source: AntigravityGuiSource, historyScope: string) {
  return Object.keys(cursor.files)
    .filter((key) => key.startsWith(dbCascadeBoundedCursorPrefix(source)))
    .map((key) => key.slice(dbCascadeBoundedCursorPrefix(source).length).split('\0', 1)[0])
    .filter((scope) => isReusableAntigravityHistoryScope(scope, historyScope))
    .sort((left, right) => right.localeCompare(left))[0]
}

function parseBoundedGuiCursorKey(key: string, source: AntigravityGuiSource) {
  const parts = key.split('\0')
  if (parts[1] !== source || !parts[2]?.startsWith('since:')) return null
  if (!boundedGuiCursorKinds.has(parts[0])) return null
  const scope = parts[2].slice('since:'.length)
  return scope ? { scope, parts } : null
}

const boundedGuiCursorKinds = new Set(['cascade', 'cascade-empty-frontier', 'db', 'db-covered'])

function usageSessionKey(event: AntigravityUsageEvent, usageDate: string, source: AntigravityGuiSource) {
  return ['session', source, usageDate, event.model, event.cascadeHash].join('\0')
}

function snapshotGroupKey(snapshot: CursorSnapshot | UsageSnapshot) {
  return [snapshot.source, snapshot.usageDate, snapshot.timezone, snapshot.model].join('\0')
}
