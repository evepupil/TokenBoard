import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { UsageSnapshot, UsageSource } from '@tokenboard/usage-core'

export type CursorSnapshot = Omit<UsageSnapshot, 'collectedAt'>

export type CursorEntry = {
  size: number
  mtimeMs: number
  sha256: string
  snapshots: CursorSnapshot[]
  missingCost: boolean
  pendingUpload?: boolean
  updatedAt: string
}

export type CursorState = {
  version: 1
  source: UsageSource
  lastScanHighWaterMs?: number
  files: Record<string, CursorEntry>
}

export async function readCursor(cursorPath: string, source: UsageSource): Promise<CursorState> {
  const empty: CursorState = { version: 1, source, files: {} }
  try {
    const parsed = JSON.parse(await readFile(cursorPath, 'utf8')) as unknown
    if (isValidCursor(parsed, source)) return parsed
    throw new Error(`Invalid ${source} cursor file: ${cursorPath}`)
  } catch (error) {
    if (isMissingFileError(error)) {
      return empty
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid ${source} cursor JSON: ${cursorPath}`)
    }
    throw error
  }
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function writeCursor(cursorPath: string, cursor: CursorState) {
  await mkdir(dirname(cursorPath), { recursive: true })
  const tempPath = `${cursorPath}.tmp`
  await writeFile(tempPath, `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 })
  await rename(tempPath, cursorPath)
}

export function stripCollectedAt(snapshot: UsageSnapshot): CursorSnapshot {
  return {
    source: snapshot.source,
    usageDate: snapshot.usageDate,
    timezone: snapshot.timezone,
    model: snapshot.model,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    cacheCreationTokens: snapshot.cacheCreationTokens,
    cacheReadTokens: snapshot.cacheReadTokens,
    totalTokens: snapshot.totalTokens,
    costUsd: snapshot.costUsd,
    sessionCount: snapshot.sessionCount
  }
}

export function cursorFileName(source: UsageSource) {
  return `${source === 'codex' ? 'codex' : 'claude-code'}-cursor.json`
}

function isValidCursor(value: unknown, source: UsageSource): value is CursorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as CursorState
  return candidate.version === 1 &&
    candidate.source === source &&
    (candidate.lastScanHighWaterMs === undefined || isFiniteTimestampMs(candidate.lastScanHighWaterMs)) &&
    candidate.files !== null &&
    typeof candidate.files === 'object' &&
    !Array.isArray(candidate.files) &&
    Object.values(candidate.files).every(isValidCursorEntry)
}

function isValidCursorEntry(value: unknown): value is CursorEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as CursorEntry
  return isFiniteNumber(candidate.size) &&
    isFiniteNumber(candidate.mtimeMs) &&
    typeof candidate.sha256 === 'string' &&
    Array.isArray(candidate.snapshots) &&
    candidate.snapshots.every(isValidCursorSnapshot) &&
    typeof candidate.missingCost === 'boolean' &&
    typeof candidate.updatedAt === 'string' &&
    (candidate.pendingUpload === undefined || typeof candidate.pendingUpload === 'boolean')
}

function isValidCursorSnapshot(value: unknown): value is CursorSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as CursorSnapshot
  if (candidate.source !== 'codex' && candidate.source !== 'claude-code') return false
  return typeof candidate.usageDate === 'string' &&
    typeof candidate.timezone === 'string' &&
    typeof candidate.model === 'string' &&
    isFiniteNumber(candidate.inputTokens) &&
    isFiniteNumber(candidate.outputTokens) &&
    isFiniteNumber(candidate.cacheCreationTokens) &&
    isFiniteNumber(candidate.cacheReadTokens) &&
    isFiniteNumber(candidate.totalTokens) &&
    isFiniteNumber(candidate.costUsd) &&
    isFiniteNumber(candidate.sessionCount)
}

function isFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isFiniteTimestampMs(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
