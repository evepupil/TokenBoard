import { createHash } from 'node:crypto'
import { isReusableAntigravityHistoryScope } from './antigravity-since'
import type { CursorState } from './session-cursor-store'

export function lastSeenCliDbRowIndexByCascadeHash(input: { cursor: CursorState; historyScope?: string }) {
  const historyScope = input.historyScope ?? 'all'
  const indexes = new Map<string, number>()
  for (const [key, entry] of Object.entries(input.cursor.files)) {
    const cascadeHash = parseCliDbCascadeHash(key, historyScope)
    if (!cascadeHash) continue
    const current = indexes.get(cascadeHash)
    if (current !== undefined && current >= entry.mtimeMs) continue
    indexes.set(cascadeHash, entry.mtimeMs)
  }
  return indexes
}

export function hasUnanchoredCliDbRowCursor(input: { cursor: CursorState; historyScope?: string }) {
  return unanchoredCliDbRowCursorHashes(input).size > 0
}

export function unanchoredCliDbRowCursorHashes(input: { cursor: CursorState; historyScope?: string }) {
  const rowIndexes = lastSeenCliDbRowIndexByCascadeHash(input)
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

export function markCliDbRowsProcessed(input: {
  cursor: CursorState
  knownCascadeIds?: Set<string>
  lastReadRowIndexByCascade?: Map<string, number>
  historyScope?: string
}) {
  const historyScope = input.historyScope ?? 'all'
  const prefix = cliDbCascadeCursorPrefixForScope(historyScope)
  if (historyScope !== 'all') {
    const reusableScopes = reusableCliDbScopes(input.cursor, historyScope)
    for (const key of Object.keys(input.cursor.files)) {
      const parsed = parseCliDbBoundedKey(key)
      if (!parsed) continue
      if (!reusableScopes.has(parsed.scope)) {
        delete input.cursor.files[key]
        continue
      }
      const nextKey = `${prefix}${parsed.cascadeHash}`
      if (nextKey === key) continue
      const existing = input.cursor.files[nextKey]
      if (!existing || existing.mtimeMs < input.cursor.files[key].mtimeMs) {
        input.cursor.files[nextKey] = input.cursor.files[key]
      }
      delete input.cursor.files[key]
    }
  }
  for (const [cascadeId, rowIndex] of input.lastReadRowIndexByCascade ?? []) {
    const key = `${prefix}${hash(cascadeId)}`
    input.cursor.files[key] = {
      size: 0,
      mtimeMs: rowIndex,
      sha256: hash(key),
      snapshots: [],
      missingCost: true,
      pendingUpload: false,
      updatedAt: new Date().toISOString()
    }
  }
  if (input.knownCascadeIds) {
    pruneAbsentCliDbRowCursors(input.cursor, input.knownCascadeIds)
  }
}

function cliDbCascadeCursorPrefixForScope(historyScope: string) {
  return historyScope === 'all' ? cliDbCascadeCursorPrefix : `${cliDbBoundedCursorPrefix}${historyScope}\0`
}

function reusableCliDbScopes(cursor: CursorState, historyScope: string) {
  const scopes = new Set<string>()
  return Object.keys(cursor.files)
    .filter((key) => key.startsWith(cliDbBoundedCursorPrefix))
    .map((key) => key.slice(cliDbBoundedCursorPrefix.length).split('\0', 1)[0])
    .filter((scope) => isReusableAntigravityHistoryScope(scope, historyScope))
    .reduce((result, scope) => result.add(scope), scopes)
}

function parseCliDbCascadeHash(key: string, historyScope: string) {
  if (historyScope === 'all') {
    if (!key.startsWith(cliDbCascadeCursorPrefix)) return null
    const cascadeHash = key.slice(cliDbCascadeCursorPrefix.length)
    return /^[a-f0-9]{64}$/.test(cascadeHash) ? cascadeHash : null
  }

  if (key.startsWith(cliDbCascadeCursorPrefix)) {
    const cascadeHash = key.slice(cliDbCascadeCursorPrefix.length)
    if (/^[a-f0-9]{64}$/.test(cascadeHash)) return cascadeHash
  }

  const parsed = parseCliDbBoundedKey(key)
  if (!parsed || !isReusableAntigravityHistoryScope(parsed.scope, historyScope)) return null
  return parsed.cascadeHash
}

function pruneAbsentCliDbRowCursors(cursor: CursorState, knownCascadeIds: Set<string>) {
  const knownCascadeHashes = new Set([...knownCascadeIds].map(hash))
  for (const key of Object.keys(cursor.files)) {
    const cascadeHash = parseAnyCliDbCascadeHash(key)
    if (cascadeHash && !knownCascadeHashes.has(cascadeHash)) {
      delete cursor.files[key]
    }
  }
}

function parseAnyCliDbCascadeHash(key: string) {
  if (key.startsWith(cliDbCascadeCursorPrefix)) {
    const cascadeHash = key.slice(cliDbCascadeCursorPrefix.length)
    if (/^[a-f0-9]{64}$/.test(cascadeHash)) return cascadeHash
  }
  return parseCliDbBoundedKey(key)?.cascadeHash ?? null
}

function parseCliDbBoundedKey(key: string) {
  if (!key.startsWith(cliDbBoundedCursorPrefix)) return null
  const remainder = key.slice(cliDbBoundedCursorPrefix.length)
  const separator = remainder.indexOf('\0')
  if (separator < 0) return null
  const scope = remainder.slice(0, separator)
  const cascadeHash = remainder.slice(separator + 1)
  if (!/^[a-f0-9]{64}$/.test(cascadeHash)) return null
  return { scope, cascadeHash }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

const cliDbCascadeCursorPrefix = 'db-row\0antigravity-cli\0'
const cliDbBoundedCursorPrefix = `${cliDbCascadeCursorPrefix}since:`
