import { createHash, randomBytes } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { link, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { usageSources, type UsageSnapshot, type UsageSource } from '@tokenboard/usage-core'
import { isValidAntigravityFileScanState, type AntigravityFileScanState } from './antigravity-file-scan'
import { probeCursorProcessLiveness } from './cursor-process-liveness'

export type CursorSnapshot = Omit<UsageSnapshot, 'collectedAt'> & {
  codexContextPricingPending?: true
}

export type CursorEntry = {
  size: number
  mtimeMs: number
  sha256: string
  endsWithNewline?: boolean
  snapshots: CursorSnapshot[]
  missingCost: boolean
  pendingUpload?: boolean
  compactedIdentity?: true
  statuslineClaimed?: true
  antigravityOrigin?: AntigravityUsageOrigin
  updatedAt: string
}

export type AntigravityUsageOrigin = 'database' | 'language-server'

export const antigravityGuiDbResetCorrectionPrefix = 'gui-db-reset-correction\0'

export type CursorState = {
  version: 1
  source: UsageSource
  codexHookProfileHash?: string
  lastScanHighWaterMs?: number
  lastScanOffsetBytes?: number
  lastScanGeneration?: string
  lastScanPrefixSha256?: string
  antigravityDbFileScan?: AntigravityFileScanState
  antigravityCascadeFileScan?: AntigravityFileScanState
  antigravityHistoryAliasMtimes?: Record<string, number[]>
  antigravityHistoryReplayReady?: true
  antigravityStatuslineReplayReady?: true
  antigravityHistoryReplayCompacted?: true
  antigravityStatuslineReplayCompacted?: true
  antigravityCliMeteringVersion?: number
  antigravityCliHistoryComplete?: true
  antigravityCliHistoryCompacted?: true
  antigravityCliHistoryCompactedThroughDate?: string
  pendingSnapshotRetryCursor?: string
  files: Record<string, CursorEntry>
}

const cursorLockRetryMs = 25
const cursorLockTimeoutMs = 35_000
const cursorLockStaleMs = 30_000
const cursorLockHeartbeatMs = 5_000
const cursorLockContext = new AsyncLocalStorage<CursorLockLease>()

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
  const tempPath = `${cursorPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    await writeFile(tempPath, `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 })
    await assertCursorWriteOwnership(cursorPath)
    await rename(tempPath, cursorPath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

export async function withCursorLock<T>(
  cursorPath: string,
  callback: () => Promise<T>,
  options: CursorLockHeartbeatOptions = {}
) {
  await mkdir(dirname(cursorPath), { recursive: true })
  const lockPath = `${cursorPath}.lock`
  const owner = { pid: process.pid, token: randomBytes(16).toString('hex') }
  await acquireCursorLock(lockPath, owner)
  const stopHeartbeat = startCursorLockHeartbeat(
    () => (options.refreshCursorLock ?? refreshCursorLock)(lockPath, owner),
    options.heartbeatIntervalMs ?? cursorLockHeartbeatMs
  )
  let callbackFailed = false
  try {
    return await cursorLockContext.run({ cursorPath, lockPath, owner }, callback)
  } catch (error) {
    callbackFailed = true
    throw error
  } finally {
    let heartbeatFailure: { error: unknown } | undefined
    try {
      await stopHeartbeat()
    } catch (error) {
      heartbeatFailure = { error }
    }
    try {
      await releaseCursorLock(lockPath, owner)
    } catch (error) {
      if (!callbackFailed) throw error
    }
    if (!callbackFailed && heartbeatFailure) throw heartbeatFailure.error
  }
}

function startCursorLockHeartbeat(refresh: () => Promise<void>, intervalMs: number) {
  let inFlight: Promise<void> | undefined
  let refreshFailure: { error: unknown } | undefined
  const heartbeat = setInterval(() => {
    if (inFlight) return
    inFlight = (async () => {
      try {
        await refresh()
      } catch (error) {
        refreshFailure ??= { error }
      } finally {
        inFlight = undefined
      }
    })()
  }, intervalMs)
  heartbeat.unref()
  return async () => {
    clearInterval(heartbeat)
    await inFlight
    if (refreshFailure) throw refreshFailure.error
  }
}

async function acquireCursorLock(lockPath: string, owner: CursorLockOwner) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < cursorLockTimeoutMs) {
    const pendingPath = `${lockPath}.pending-${process.pid}-${owner.token}`
    try {
      await writeFile(pendingPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
      await link(pendingPath, lockPath)
      try {
        await rm(pendingPath, { force: true })
      } catch (error) {
        await releaseCursorLock(lockPath, owner)
        throw new Error(`Cursor lock pending file could not be removed: ${pendingPath}`, { cause: error })
      }
      return
    } catch (error) {
      await rm(pendingPath, { force: true })
      if (!isFileExistsError(error)) throw error
      await recoverStaleCursorLock(lockPath)
      await delay(cursorLockRetryMs)
    }
  }
  throw new Error(`Timed out waiting for cursor lock: ${lockPath}`)
}

async function recoverStaleCursorLock(lockPath: string) {
  const lockStat = await stat(lockPath).catch(() => null)
  if (!lockStat || Date.now() - lockStat.mtimeMs < cursorLockStaleMs) return
  const owner = await readCursorLockOwner(lockPath)
  if (owner && probeCursorProcessLiveness(owner.pid) !== 'dead') return
  if (!(await sameCursorLockSnapshot(lockPath, lockStat, owner))) return
  const quarantinePath = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    await rename(lockPath, quarantinePath)
  } catch (error) {
    if (isMissingFileError(error)) return
    throw error
  }
  const quarantinedStat = await stat(quarantinePath).catch(() => null)
  if (!quarantinedStat || !sameFileStat(lockStat, quarantinedStat)) {
    await restoreCursorLock(lockPath, quarantinePath)
    return
  }
  await rm(quarantinePath, { force: true })
}

async function sameCursorLockSnapshot(
  lockPath: string,
  expectedStat: Awaited<ReturnType<typeof stat>>,
  owner: CursorLockOwner | null
) {
  const currentStat = await stat(lockPath).catch(() => null)
  if (!currentStat || !sameFileStat(expectedStat, currentStat)) return false
  return !owner || (await sameCursorLockOwner(lockPath, owner))
}

function sameFileStat(expected: Awaited<ReturnType<typeof stat>>, current: Awaited<ReturnType<typeof stat>>) {
  return expected.dev === current.dev && expected.ino === current.ino && expected.mtimeMs === current.mtimeMs
}

async function restoreCursorLock(lockPath: string, quarantinePath: string) {
  try {
    await link(quarantinePath, lockPath)
    await rm(quarantinePath, { force: true })
  } catch (error) {
    if (!isFileExistsError(error)) throw error
    throw new Error(`Cursor replacement lock could not be restored because another owner exists: ${lockPath}`, {
      cause: error
    })
  }
}

async function refreshCursorLock(lockPath: string, owner: CursorLockOwner) {
  if (!(await sameCursorLockOwner(lockPath, owner))) return
  const now = new Date()
  await utimes(lockPath, now, now).catch(() => undefined)
}

async function releaseCursorLock(lockPath: string, owner: CursorLockOwner) {
  const expectedStat = await stat(lockPath).catch(() => null)
  if (!expectedStat) return
  if (!(await sameCursorLockOwner(lockPath, owner))) {
    throw new Error(`Cursor lock ownership changed: ${lockPath}`)
  }
  const quarantinePath = `${lockPath}.release-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    await rename(lockPath, quarantinePath)
  } catch (error) {
    if (isMissingFileError(error)) return
    throw error
  }
  const quarantinedStat = await stat(quarantinePath).catch(() => null)
  if (
    !quarantinedStat ||
    !sameFileStat(expectedStat, quarantinedStat) ||
    !(await sameCursorLockOwner(quarantinePath, owner))
  ) {
    await restoreCursorLock(lockPath, quarantinePath)
    return
  }
  await rm(quarantinePath, { force: true })
}

async function sameCursorLockOwner(lockPath: string, expected: CursorLockOwner) {
  const current = await readCursorLockOwner(lockPath)
  return current?.pid === expected.pid && current.token === expected.token
}

export async function assertCursorWriteOwnership(cursorPath: string) {
  const lease = cursorLockContext.getStore()
  if (!lease || lease.cursorPath !== cursorPath) return
  if (!(await sameCursorLockOwner(lease.lockPath, lease.owner))) {
    throw new Error(`Cursor lock ownership changed before write: ${lease.lockPath}`)
  }
}

async function readCursorLockOwner(lockPath: string): Promise<CursorLockOwner | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<CursorLockOwner>
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return null
    if (typeof value.token !== 'string' || !value.token) return null
    return { pid: Number(value.pid), token: value.token }
  } catch {
    return null
  }
}

function isFileExistsError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

type CursorLockOwner = { pid: number; token: string }
type CursorLockLease = { cursorPath: string; lockPath: string; owner: CursorLockOwner }
type CursorLockHeartbeatOptions = {
  heartbeatIntervalMs?: number
  refreshCursorLock?: (lockPath: string, owner: CursorLockOwner) => Promise<void>
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

export function cursorFileName(source: UsageSource, scope?: string) {
  const baseName = sourceCursorFileName(source)
  if (!scope) return baseName
  const scopeHash = createHash('sha256').update(scope).digest('hex')
  const scopeLabel = source === 'codex' ? 'profile' : 'server'
  return baseName.replace(/\.json$/, `.${scopeLabel}-${scopeHash}.json`)
}

function sourceCursorFileName(source: UsageSource) {
  if (source === 'claude-code') return 'claude-code-cursor.json'
  return `${source}-cursor.json`
}

function isValidCursor(value: unknown, source: UsageSource): value is CursorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as CursorState
  return (
    candidate.version === 1 &&
    candidate.source === source &&
    (candidate.codexHookProfileHash === undefined || isSha256(candidate.codexHookProfileHash)) &&
    (candidate.lastScanHighWaterMs === undefined || isFiniteTimestampMs(candidate.lastScanHighWaterMs)) &&
    (candidate.lastScanOffsetBytes === undefined || isNonNegativeSafeInteger(candidate.lastScanOffsetBytes)) &&
    (candidate.lastScanGeneration === undefined || isValidScanGeneration(candidate.lastScanGeneration)) &&
    (candidate.lastScanPrefixSha256 === undefined || isSha256(candidate.lastScanPrefixSha256)) &&
    (candidate.antigravityDbFileScan === undefined ||
      isValidAntigravityFileScanState(candidate.antigravityDbFileScan)) &&
    (candidate.antigravityCascadeFileScan === undefined ||
      isValidAntigravityFileScanState(candidate.antigravityCascadeFileScan)) &&
    (candidate.antigravityHistoryAliasMtimes === undefined ||
      isValidAntigravityHistoryAliasMtimes(candidate.antigravityHistoryAliasMtimes)) &&
    (candidate.antigravityHistoryReplayReady === undefined || candidate.antigravityHistoryReplayReady === true) &&
    (candidate.antigravityStatuslineReplayReady === undefined || candidate.antigravityStatuslineReplayReady === true) &&
    (candidate.antigravityHistoryReplayCompacted === undefined ||
      candidate.antigravityHistoryReplayCompacted === true) &&
    (candidate.antigravityStatuslineReplayCompacted === undefined ||
      candidate.antigravityStatuslineReplayCompacted === true) &&
    (candidate.antigravityCliMeteringVersion === undefined ||
      (Number.isSafeInteger(candidate.antigravityCliMeteringVersion) &&
        candidate.antigravityCliMeteringVersion >= 1)) &&
    (candidate.antigravityCliHistoryComplete === undefined || candidate.antigravityCliHistoryComplete === true) &&
    (candidate.antigravityCliHistoryCompacted === undefined || candidate.antigravityCliHistoryCompacted === true) &&
    (candidate.antigravityCliHistoryCompactedThroughDate === undefined ||
      isUsageDate(candidate.antigravityCliHistoryCompactedThroughDate)) &&
    (candidate.pendingSnapshotRetryCursor === undefined ||
      (typeof candidate.pendingSnapshotRetryCursor === 'string' &&
        candidate.pendingSnapshotRetryCursor.length <= 4096)) &&
    candidate.files !== null &&
    typeof candidate.files === 'object' &&
    !Array.isArray(candidate.files) &&
    Object.values(candidate.files).every(isValidCursorEntry)
  )
}

function isValidAntigravityHistoryAliasMtimes(value: unknown): value is Record<string, number[]> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, mtimes]) => /^[a-f0-9]{64}$/.test(key) && Array.isArray(mtimes) && mtimes.every(isFiniteNumber)
    )
  )
}

function isUsageDate(value: unknown) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isValidCursorEntry(value: unknown): value is CursorEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as CursorEntry
  return (
    isFiniteNumber(candidate.size) &&
    isFiniteNumber(candidate.mtimeMs) &&
    typeof candidate.sha256 === 'string' &&
    (candidate.endsWithNewline === undefined || typeof candidate.endsWithNewline === 'boolean') &&
    Array.isArray(candidate.snapshots) &&
    candidate.snapshots.every(isValidCursorSnapshot) &&
    typeof candidate.missingCost === 'boolean' &&
    typeof candidate.updatedAt === 'string' &&
    (candidate.pendingUpload === undefined || typeof candidate.pendingUpload === 'boolean') &&
    (candidate.compactedIdentity === undefined || candidate.compactedIdentity === true) &&
    (candidate.statuslineClaimed === undefined || candidate.statuslineClaimed === true) &&
    (candidate.antigravityOrigin === undefined ||
      candidate.antigravityOrigin === 'database' ||
      candidate.antigravityOrigin === 'language-server')
  )
}

function isValidCursorSnapshot(value: unknown): value is CursorSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as CursorSnapshot
  if (!(usageSources as readonly string[]).includes(candidate.source)) return false
  return (
    typeof candidate.usageDate === 'string' &&
    typeof candidate.timezone === 'string' &&
    typeof candidate.model === 'string' &&
    (candidate.codexContextPricingPending === undefined || candidate.codexContextPricingPending === true) &&
    isFiniteNumber(candidate.inputTokens) &&
    isFiniteNumber(candidate.outputTokens) &&
    isFiniteNumber(candidate.cacheCreationTokens) &&
    isFiniteNumber(candidate.cacheReadTokens) &&
    isFiniteNumber(candidate.totalTokens) &&
    isFiniteNumber(candidate.costUsd) &&
    isFiniteNumber(candidate.sessionCount)
  )
}

function isFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeSafeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFiniteTimestampMs(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isValidScanGeneration(value: unknown) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function isSha256(value: unknown) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
