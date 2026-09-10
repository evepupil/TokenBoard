import { join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { cursorFileName, readCursor, withCursorLock, writeCursor } from './session-cursor-store'
import { mergeSnapshots, selectPendingCursorSnapshotGroups, shouldIncludeCursorSnapshot } from './session-cursor'
import {
  createAntigravityLanguageServerClient,
  listAntigravityCascades,
  type AntigravityCascadeRef,
  type AntigravityGeneratorMetadataRequest
} from './antigravity-gui-client'
import { hash, parseGeneratorMetadata } from './antigravity-gui-parser'
import { isAntigravityDbRowCursorResetError, type AntigravityDbUsageResult } from './antigravity-history-db'
import { resolveAntigravityCollectionRange, type AntigravityCollectionRange } from './antigravity-since'
import {
  hasDbCascadeRowsProcessed,
  markDbCascadeRowsProcessed,
  markCascadeProcessed,
  markEmptyCascadeAttempted,
  prepareGuiHistoryScope,
  pushCompleteGuiCursorSnapshots,
  pushGuiUsageEvent,
  queueGuiDbResetCorrections,
  readEmptyCascadeFrontier,
  resetGuiDbCursorState,
  type EmptyCascadeFrontier,
  shouldRequestCascade
} from './antigravity-gui-cursor'
import {
  errorMessage,
  isUnavailableDbError,
  isUnavailableLanguageServerError,
  readStateDir
} from './antigravity-gui-environment'
import { readAntigravityGuiLocalDbUsage } from './antigravity-gui-local-db'

export type AntigravityGuiSource = 'antigravity' | 'antigravity-ide'

export type CollectAntigravityGuiUsageOptions = {
  source: AntigravityGuiSource
  timezone?: string
  collectedAt?: string
  stateDir?: string
  cursorScope?: string
  since?: string
  conversationDir?: string
  languageServerPath?: string
  overrideIdeVersion?: string
  listCascadeIds?: () => Promise<string[]>
  listCascades?: () => Promise<AntigravityCascadeRef[]>
  requestGeneratorMetadata?: (input: AntigravityGeneratorMetadataRequest) => Promise<unknown>
  readDbUsageEvents?: (input?: {
    lastSeenRowIndexByCascadeHash?: Map<string, number>
    maxDbFiles?: number | null
    sinceDate?: string
    timezone?: string
    detectRowCursorReset?: boolean
    requireCompleteDirectoryScan?: boolean
    forceFullScanCascadeHashes?: ReadonlySet<string>
  }) => Promise<AntigravityDbUsageResult>
  stderr?: (line: string) => void
  maxLanguageServerCascades?: number
  maxDbFiles?: number | null
}

const defaultMaxLanguageServerCascades = 12

export const maxAntigravityLanguageServerUsageEvents = 32_768

export class AntigravityPartialUsageError extends Error {
  readonly fatal: boolean
  readonly snapshots: UsageSnapshot[]

  constructor(message: string, snapshots: UsageSnapshot[], cause?: unknown, fatal = false) {
    super(message)
    this.fatal = fatal
    this.name = 'AntigravityPartialUsageError'
    this.snapshots = snapshots
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, configurable: true })
    }
  }
}

export function isAntigravityPartialUsageError(error: unknown): error is AntigravityPartialUsageError {
  return error instanceof AntigravityPartialUsageError
}

export function collectAntigravityUsage(options: Omit<CollectAntigravityGuiUsageOptions, 'source'> = {}) {
  return collectAntigravityGuiUsage({ ...options, source: 'antigravity' })
}

export function collectAntigravityIdeUsage(options: Omit<CollectAntigravityGuiUsageOptions, 'source'> = {}) {
  return collectAntigravityGuiUsage({ ...options, source: 'antigravity-ide' })
}

export async function collectAntigravityGuiUsage(options: CollectAntigravityGuiUsageOptions): Promise<UsageSnapshot[]> {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const stateDir = options.stateDir ?? readStateDir()
  const cursorPath = join(stateDir, cursorFileName(options.source, options.cursorScope))
  return withCursorLock(cursorPath, () =>
    collectAntigravityGuiUsageLocked({
      options,
      timezone,
      collectedAt,
      cursorPath
    })
  )
}

async function collectAntigravityGuiUsageLocked(input: {
  options: CollectAntigravityGuiUsageOptions
  timezone: string
  collectedAt: string
  cursorPath: string
}) {
  const { options, timezone, collectedAt, cursorPath } = input
  const cursor = await readCursor(cursorPath, options.source)
  const range = resolveAntigravityCollectionRange({ since: options.since, timezone })
  const pendingSnapshotGroups = selectPendingCursorSnapshotGroups({
    cursor,
    sinceDate: range.sinceDate
  })
  prepareGuiHistoryScope({ cursor, source: options.source, historyScope: range.historyScope })
  cursor.antigravityDbFileScan ??= { nextSequence: 0, files: {} }
  cursor.antigravityCascadeFileScan ??= { nextSequence: 0, files: {} }
  const snapshots: UsageSnapshot[] = []
  const emittedKeys = new Set<string>()

  const { usage: localDbUsage, error: localDbError } = await readGuiLocalDbUsageWithCursorRecovery({
    options,
    cursor,
    range,
    timezone,
    collectedAt
  })
  assertFullHistoryDirectoryScanComplete(range, localDbUsage)
  for (const event of localDbUsage.events.filter((item) => range.includesTimestamp(item.createdAt))) {
    pushGuiUsageEvent({
      event,
      origin: 'database',
      cursor,
      snapshots,
      emittedKeys,
      timezone,
      collectedAt,
      source: options.source
    })
  }

  if (localDbError && !isUnavailableDbError(localDbError)) {
    throw localDbError
  }

  await collectLanguageServerUsage({
    options,
    cursor,
    cursorPath,
    snapshots,
    emittedKeys,
    timezone,
    collectedAt,
    localDbUsage,
    range
  })

  markDbCascadeRowsProcessed({
    cursor,
    source: options.source,
    lastReadRowIndexByCascade: localDbUsage.lastReadRowIndexByCascade,
    historyScope: range.historyScope
  })
  pushCompleteGuiCursorSnapshots(snapshots, cursor, collectedAt, emittedKeys, (snapshot) =>
    shouldIncludeCursorSnapshot(snapshot, range.sinceDate, pendingSnapshotGroups)
  )
  await writeCursor(cursorPath, cursor)
  return mergeSnapshots(snapshots)
}

function assertFullHistoryDirectoryScanComplete(
  range: AntigravityCollectionRange,
  localDbUsage: AntigravityDbUsageResult
) {
  if (range.fullHistory && localDbUsage.completeDirectoryScan === false) {
    throw new Error('Antigravity GUI --since all requires a complete SQLite directory scan')
  }
}

async function readGuiLocalDbUsageWithCursorRecovery(input: {
  options: CollectAntigravityGuiUsageOptions
  cursor: Awaited<ReturnType<typeof readCursor>>
  range: AntigravityCollectionRange
  timezone: string
  collectedAt: string
}) {
  const firstAttempt = await readAntigravityGuiLocalDbUsage(input.options, input.cursor, input.range, input.timezone)
  if (!input.range.fullHistory || !isAntigravityDbRowCursorResetError(firstAttempt.error)) {
    return firstAttempt
  }

  const corrections = resetGuiDbCursorState({
    cursor: input.cursor,
    source: input.options.source
  })
  const stderr = input.options.stderr ?? console.error
  stderr('Antigravity SQLite metadata cursor reset detected; rebuilding full local database history once')
  const rebuilt = await readAntigravityGuiLocalDbUsage(input.options, input.cursor, input.range, input.timezone)
  if (rebuilt.error) {
    throw new Error(`Antigravity SQLite metadata cursor reset recovery failed: ${errorMessage(rebuilt.error)}`, {
      cause: rebuilt.error
    })
  }
  queueGuiDbResetCorrections({ cursor: input.cursor, corrections, collectedAt: input.collectedAt })
  return rebuilt
}

async function collectLanguageServerUsage(input: {
  options: CollectAntigravityGuiUsageOptions
  cursor: Awaited<ReturnType<typeof readCursor>>
  cursorPath: string
  snapshots: UsageSnapshot[]
  emittedKeys: Set<string>
  timezone: string
  collectedAt: string
  localDbUsage: AntigravityDbUsageResult
  range: AntigravityCollectionRange
}) {
  let request
  let collectionFailed = false
  let collectionError: unknown
  const cleanupErrors: unknown[] = []
  try {
    const uncapturedCascades = await listUncapturedLanguageServerCascades(input)
    if (uncapturedCascades.length > 0) {
      request = await createRequestContext(input.options)
      await requestLanguageServerUsage({ ...input, uncapturedCascades }, request)
    }
  } catch (error) {
    collectionFailed = true
    collectionError = error
    await preservePartialGuiUsage(input, cleanupErrors)
  } finally {
    try {
      await request?.close()
    } catch (closeError) {
      cleanupErrors.push(closeError)
    }
  }
  if (collectionFailed) {
    throw guiCollectionError(collectionError, input.snapshots, cleanupErrors)
  }
  const cleanupError = cleanupErrors[0]
  if (cleanupError !== undefined) {
    throw guiCollectionError(cleanupError, input.snapshots, cleanupErrors.slice(1))
  }
}

async function requestLanguageServerUsage(
  input: Parameters<typeof collectLanguageServerUsage>[0] & {
    uncapturedCascades: AntigravityCascadeRef[]
  },
  request: Awaited<ReturnType<typeof createRequestContext>>
) {
  let usageEventCount = 0
  for (const cascade of input.uncapturedCascades) {
    const response = await request.requestGeneratorMetadata({ source: input.options.source, cascadeId: cascade.id })
    const events = parseGeneratorMetadata(response, cascade.id)
    usageEventCount = reserveAntigravityLanguageServerUsageEvents(usageEventCount, events.length)
    let hasUsableEvents = false
    for (const event of events) {
      hasUsableEvents = true
      if (!input.range.includesTimestamp(event.createdAt)) continue
      pushGuiUsageEvent({
        event,
        origin: 'language-server',
        cursor: input.cursor,
        snapshots: input.snapshots,
        emittedKeys: input.emittedKeys,
        timezone: input.timezone,
        collectedAt: input.collectedAt,
        source: input.options.source
      })
    }
    if (!hasUsableEvents) {
      markEmptyCascadeAttempted({
        cascade,
        cursor: input.cursor,
        source: input.options.source,
        historyScope: input.range.historyScope
      })
      await writeCursor(input.cursorPath, input.cursor)
      continue
    }
    markCascadeProcessed({
      cascade,
      cursor: input.cursor,
      source: input.options.source,
      historyScope: input.range.historyScope
    })
    await writeCursor(input.cursorPath, input.cursor)
  }
}

export function reserveAntigravityLanguageServerUsageEvents(currentCount: number, incomingCount: number) {
  const nextCount = currentCount + incomingCount
  if (nextCount > maxAntigravityLanguageServerUsageEvents) {
    throw new Error(
      `Antigravity language server metadata exceeded the ${maxAntigravityLanguageServerUsageEvents} usage-event limit`
    )
  }
  return nextCount
}

async function preservePartialGuiUsage(
  input: Parameters<typeof collectLanguageServerUsage>[0],
  cleanupErrors: unknown[]
) {
  try {
    markDbCascadeRowsProcessed({
      cursor: input.cursor,
      source: input.options.source,
      lastReadRowIndexByCascade: input.localDbUsage.lastReadRowIndexByCascade,
      historyScope: input.range.historyScope
    })
    pushCompleteGuiCursorSnapshots(input.snapshots, input.cursor, input.collectedAt, input.emittedKeys, (snapshot) =>
      shouldIncludeCursorSnapshot(
        snapshot,
        input.range.sinceDate,
        selectPendingCursorSnapshotGroups({ cursor: input.cursor, sinceDate: input.range.sinceDate })
      )
    )
    await writeCursor(input.cursorPath, input.cursor)
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError)
  }
}

function guiCollectionError(error: unknown, snapshots: UsageSnapshot[], cleanupErrors: unknown[]) {
  const cause = cleanupErrorCause(cleanupErrors)
  if (snapshots.length > 0) {
    const unavailable = isUnavailableLanguageServerError(error)
    return new AntigravityPartialUsageError(
      `${
        unavailable ? 'Antigravity language server unavailable' : 'Antigravity language server collection failed'
      } after DB history was collected: ${errorMessage(error)}`,
      mergeSnapshots(snapshots),
      cause,
      cleanupErrors.length > 0 || !unavailable
    )
  }
  if (!(error instanceof Error) || cause === undefined) return error
  attachCleanupCause(error, cause)
  return error
}

function attachCleanupCause(error: Error, cause: unknown) {
  const existingCause = (error as Error & { cause?: unknown }).cause
  const combinedCause =
    existingCause === undefined
      ? cause
      : new AggregateError([existingCause, cause], 'Antigravity collection cleanup failed')
  try {
    Object.defineProperty(error, 'cause', { value: combinedCause, configurable: true })
  } catch {
    // Preserve the primary error even if a third-party error object is immutable.
  }
}

function cleanupErrorCause(errors: unknown[]) {
  if (errors.length === 0) return undefined
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, 'Antigravity collection cleanup failed')
}

async function createRequestContext(options: CollectAntigravityGuiUsageOptions) {
  if (options.requestGeneratorMetadata) {
    return {
      requestGeneratorMetadata: options.requestGeneratorMetadata,
      close: async () => undefined
    }
  }
  const client = await createAntigravityLanguageServerClient(options)
  return { requestGeneratorMetadata: client.requestGeneratorMetadata, close: client.close }
}

async function listUncapturedLanguageServerCascades(input: {
  options: CollectAntigravityGuiUsageOptions
  cursor: Awaited<ReturnType<typeof readCursor>>
  localDbUsage: AntigravityDbUsageResult
  range: AntigravityCollectionRange
}) {
  const maxCascades = normalizeMaxLanguageServerCascades(input.options.maxLanguageServerCascades)
  const emptyCascadeFrontier = readEmptyCascadeFrontier({
    cursor: input.cursor,
    source: input.options.source,
    historyScope: input.range.historyScope
  })
  const cascades = await readLanguageServerCascadeRefs({ ...input, maxCascades, emptyCascadeFrontier })
  markDbCascadeRowsProcessed({
    coveredCascadeIds: input.localDbUsage.cascadeIds,
    coveredCascades: cascades,
    cursor: input.cursor,
    source: input.options.source,
    historyScope: input.range.historyScope
  })
  return cascades
    .filter((cascade) => input.range.includesFileMtime(cascade.mtimeMs))
    .filter((cascade) =>
      shouldRequestLanguageServerCascade({
        cascade,
        cursor: input.cursor,
        localDbUsage: input.localDbUsage,
        source: input.options.source,
        historyScope: input.range.historyScope
      })
    )
    .sort((left, right) => compareLanguageServerCascadePriority(left, right, emptyCascadeFrontier))
    .slice(0, maxCascades)
}

function compareLanguageServerCascadePriority(
  left: AntigravityCascadeRef,
  right: AntigravityCascadeRef,
  frontier: EmptyCascadeFrontier | null
) {
  if (frontier) {
    const leftAfterFrontier = isCascadeAfterFrontier(left, frontier)
    const rightAfterFrontier = isCascadeAfterFrontier(right, frontier)
    if (leftAfterFrontier !== rightAfterFrontier) return leftAfterFrontier ? -1 : 1
  }
  return compareCascadeRecency(left, right)
}

function isCascadeAfterFrontier(cascade: AntigravityCascadeRef, frontier: EmptyCascadeFrontier) {
  if (cascade.mtimeMs !== frontier.mtimeMs) return cascade.mtimeMs < frontier.mtimeMs
  return hash(cascade.id).localeCompare(frontier.cascadeHash) > 0
}

function compareCascadeRecency(left: AntigravityCascadeRef, right: AntigravityCascadeRef) {
  if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs
  return hash(left.id).localeCompare(hash(right.id))
}

function normalizeMaxLanguageServerCascades(value: number | undefined) {
  if (value === undefined) return defaultMaxLanguageServerCascades
  if (!Number.isFinite(value) || value < 0) return defaultMaxLanguageServerCascades
  return Math.min(Math.floor(value), defaultMaxLanguageServerCascades)
}

async function readLanguageServerCascadeRefs(input: {
  options: CollectAntigravityGuiUsageOptions
  cursor: Awaited<ReturnType<typeof readCursor>>
  localDbUsage: AntigravityDbUsageResult
  maxCascades: number
  emptyCascadeFrontier: EmptyCascadeFrontier | null
  range: AntigravityCollectionRange
}) {
  const { options } = input
  if (options.listCascades) return options.listCascades()
  if (options.listCascadeIds) {
    const ids = await options.listCascadeIds()
    return ids.map((id) => ({ id, mtimeMs: 0, size: 0 }))
  }
  return listAntigravityCascades({
    ...options,
    limit: input.maxCascades,
    scanState: input.cursor.antigravityCascadeFileScan,
    requiredCascadeIds: requiredLanguageServerCascadeIds({
      cursor: input.cursor,
      localDbUsage: input.localDbUsage,
      source: options.source
    }),
    compareCascades: (left, right) => compareLanguageServerCascadePriority(left, right, input.emptyCascadeFrontier),
    includeCascade: (cascade) => {
      if (!input.range.includesFileMtime(cascade.mtimeMs)) return false
      if (input.localDbUsage.cascadeIds.has(cascade.id)) {
        markDbCascadeRowsProcessed({
          coveredCascadeIds: input.localDbUsage.cascadeIds,
          coveredCascades: [cascade],
          cursor: input.cursor,
          source: options.source,
          historyScope: input.range.historyScope
        })
      }
      return shouldRequestLanguageServerCascade({
        cascade,
        cursor: input.cursor,
        localDbUsage: input.localDbUsage,
        source: options.source,
        historyScope: input.range.historyScope
      })
    }
  })
}

function requiredLanguageServerCascadeIds(input: {
  cursor: Awaited<ReturnType<typeof readCursor>>
  localDbUsage: AntigravityDbUsageResult
  source: AntigravityGuiSource
}) {
  return new Set([...input.localDbUsage.cascadeIds, ...(input.localDbUsage.lastReadRowIndexByCascade?.keys() ?? [])])
}

function shouldRequestLanguageServerCascade(input: {
  cascade: AntigravityCascadeRef
  cursor: Awaited<ReturnType<typeof readCursor>>
  localDbUsage: AntigravityDbUsageResult
  source: AntigravityGuiSource
  historyScope: string
}) {
  const databaseScanPending =
    input.cascade.hasDatabaseFile && !input.localDbUsage.lastReadRowIndexByCascade?.has(input.cascade.id)
  return (
    !databaseScanPending &&
    !input.localDbUsage.cascadeIds.has(input.cascade.id) &&
    !hasDbCascadeRowsProcessed({
      cascade: input.cascade,
      cursor: input.cursor,
      source: input.source,
      historyScope: input.historyScope
    }) &&
    shouldRequestCascade({
      cascade: input.cascade,
      cursor: input.cursor,
      source: input.source,
      historyScope: input.historyScope
    })
  )
}
