import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { opendir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { errorMessage } from '../error-message'
import type { AntigravityUsageEvent } from './antigravity-gui-parser'
import { parseAntigravityGeneratorMetadataBlobEvents } from './antigravity-history-protobuf'
import { formatDate } from './session-jsonl-parser-utils'
import {
  beginAntigravityFileScan,
  listAntigravityDirectoryFileNames,
  markAntigravityFileScanned,
  pruneAntigravityFileScanState,
  readAntigravityFileScanEntry,
  removeAntigravityFileScanEntry,
  selectAntigravityFileScanIds,
  type AntigravityDirectoryEntry,
  type AntigravityFileScanEntry,
  type AntigravityFileScanState
} from './antigravity-file-scan'

const execFileAsync = promisify(execFile)
const maxSqliteOutputBytes = 128 * 1024 * 1024
const sqliteTimeoutMs = 15_000
const defaultMaxDbFiles = 64
const generatorMetadataRowsPageSize = 500
const cascadeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type StatFile = (filePath: string) => Promise<{ mtimeMs: number; size?: number }>
type ListFiles = (directoryPath: string) => AsyncIterable<AntigravityDirectoryEntry>
// These bounded proofs live beside the existing file scan entry and are validated before use.
type AntigravityDbFileScanEntry = AntigravityFileScanEntry & {
  metadataRowHighWater?: number
  metadataCursorRowIndex?: number
  metadataCursorRowSha256?: string
}
type DbFileCandidate = {
  filePath: string
  mtimeMs: number
  size: number
  metadataRowHighWater: number | undefined
  metadataCursorRowIndex: number | undefined
  metadataCursorRowSha256: string | undefined
}
type DbFileMetadata = Omit<DbFileCandidate, 'filePath' | 'mtimeMs' | 'size'>

const nodeListFiles: ListFiles = async function* (directoryPath) {
  const directory = await opendir(directoryPath)
  try {
    while (true) {
      const entry = await directory.read()
      if (!entry) break
      yield entry
    }
  } finally {
    await directory.close()
  }
}

export type AntigravityDbUsageResult = {
  cascadeIds: Set<string>
  events: AntigravityUsageEvent[]
  // Built-in SQLite reads always declare whether every eligible database was read.
  // Optional only to preserve compatibility with injected test readers.
  completeDirectoryScan?: boolean
  knownCascadeIds?: Set<string>
  lastReadRowIndexByCascade?: Map<string, number>
}

export class AntigravityDbRowCursorResetError extends Error {
  readonly dbFile: string

  constructor(dbFile: string) {
    super(`Antigravity SQLite metadata cursor reset detected for ${dbFile}; rerun with --since all`)
    this.name = 'AntigravityDbRowCursorResetError'
    this.dbFile = dbFile
  }
}

export function isAntigravityDbRowCursorResetError(error: unknown): error is AntigravityDbRowCursorResetError {
  return error instanceof AntigravityDbRowCursorResetError
}

type ReadSqlite = (dbFile: string, sql: string) => Promise<string>

export async function readAntigravityDbUsageEvents(input: {
  conversationDir: string
  sqliteBin?: string
  readSqlite?: ReadSqlite
  lastSeenRowIndexByCascadeHash?: Map<string, number>
  maxDbFiles?: number | null
  statFile?: StatFile
  listFiles?: ListFiles
  scanState?: AntigravityFileScanState
  sinceDate?: string
  timezone?: string
  detectRowCursorReset?: boolean
  requireCompleteDirectoryScan?: boolean
  sourceLabel?: string
  forceFullScanCascadeHashes?: ReadonlySet<string>
}): Promise<AntigravityDbUsageResult> {
  const dbListing = await listDbFiles({
    conversationDir: input.conversationDir,
    maxDbFiles: normalizeMaxDbFiles(input.maxDbFiles),
    statFile: input.statFile ?? stat,
    listFiles: input.listFiles ?? nodeListFiles,
    lastSeenRowIndexByCascadeHash: input.lastSeenRowIndexByCascadeHash ?? new Map(),
    scanState: input.scanState,
    includeFileMtime: buildFileMtimeFilter(input.sinceDate, input.timezone),
    requireCompleteDirectoryScan: input.requireCompleteDirectoryScan ?? false,
    sourceLabel: input.sourceLabel,
    forceFullScanCascadeHashes: input.forceFullScanCascadeHashes
  })
  const result: AntigravityDbUsageResult = {
    cascadeIds: new Set(),
    events: [],
    completeDirectoryScan: dbListing.completeDirectoryScan,
    knownCascadeIds: dbListing.knownCascadeIds,
    lastReadRowIndexByCascade: new Map()
  }
  for (const dbFile of dbListing.dbFiles) {
    const cascadeId = basename(dbFile.filePath, '.db')
    const cascadeHash = hash(cascadeId)
    const forceFullScan = input.forceFullScanCascadeHashes?.has(cascadeHash) === true
    const fallbackCreatedAt = new Date(dbFile.mtimeMs).toISOString()
    const beforeCount = result.events.length
    const lastSeenRowIndex = forceFullScan ? undefined : input.lastSeenRowIndexByCascadeHash?.get(cascadeHash)
    let lastReadRowIndex = normalizeLastSeenRowIndex(lastSeenRowIndex)
    const previousCursorMatches = dbFile.metadataCursorRowIndex === lastReadRowIndex
    let metadataRowHighWater: number | undefined
    let metadataCursorRowIndex = previousCursorMatches && lastReadRowIndex >= 0 ? lastReadRowIndex : undefined
    let metadataCursorRowSha256 = previousCursorMatches ? dbFile.metadataCursorRowSha256 : undefined
    for await (const row of readGeneratorMetadataRows(dbFile.filePath, {
      sqliteBin: input.sqliteBin,
      readSqlite: input.readSqlite,
      lastSeenRowIndex,
      detectRowCursorReset: forceFullScan ? false : input.detectRowCursorReset,
      previousHighWater: dbFile.metadataRowHighWater,
      previousCursorRowIndex: previousCursorMatches ? dbFile.metadataCursorRowIndex : undefined,
      previousCursorRowSha256: previousCursorMatches ? dbFile.metadataCursorRowSha256 : undefined,
      onHighWaterMark: input.scanState
        ? (value) => {
            metadataRowHighWater = value
          }
        : undefined,
      onLastRow: input.scanState
        ? (row) => {
            const rowSha256 = hashBytes(row.data)
            metadataCursorRowIndex = row.index
            metadataCursorRowSha256 = rowSha256
          }
        : undefined
    })) {
      const events = parseAntigravityGeneratorMetadataBlobEvents(row.data, {
        cascadeId,
        rowIndex: row.index,
        fallbackCreatedAt
      })
      lastReadRowIndex = row.index
      result.events.push(...events.map((event) => withLegacyCascadeAlias(event, cascadeId)))
    }
    if (metadataCursorRowIndex === undefined && lastReadRowIndex < 0) {
      metadataCursorRowIndex = -1
      metadataCursorRowSha256 = hashBytes(Buffer.alloc(0))
    }
    if (input.scanState) {
      writeMetadata(
        input.scanState,
        cascadeId,
        {
          metadataRowHighWater,
          metadataCursorRowIndex,
          metadataCursorRowSha256
        },
        dbFile
      )
    }
    result.lastReadRowIndexByCascade?.set(cascadeId, lastReadRowIndex)
    if (result.events.length > beforeCount) {
      result.cascadeIds.add(cascadeId)
    }
  }
  return result
}

function withLegacyCascadeAlias(event: AntigravityUsageEvent, cascadeId: string): AntigravityUsageEvent {
  const legacyHash = legacyAntigravityCliConversationHash(cascadeId)
  if (legacyHash === event.cascadeHash) return event
  return {
    ...event,
    cascadeHashAliases: [...(event.cascadeHashAliases ?? []), legacyHash]
  }
}

function legacyAntigravityCliConversationHash(value: string) {
  return createHash('sha256').update('tokenboard-antigravity-cli\0').update(value).digest('hex')
}

async function listDbFiles(input: {
  conversationDir: string
  maxDbFiles: number | null
  statFile: StatFile
  listFiles: ListFiles
  lastSeenRowIndexByCascadeHash: Map<string, number>
  scanState?: AntigravityFileScanState
  includeFileMtime: (mtimeMs: number) => boolean
  requireCompleteDirectoryScan: boolean
  sourceLabel?: string
  forceFullScanCascadeHashes?: ReadonlySet<string>
}) {
  let names
  try {
    names = (await listAntigravityDirectoryFileNames(input.listFiles(input.conversationDir))).filter(
      (name) => extname(name) === '.db' && cascadeIdPattern.test(basename(name, '.db'))
    )
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Antigravity conversations directory not found: ${input.conversationDir}`)
    }
    throw error
  }
  if (input.maxDbFiles === null) {
    const candidates = await Promise.all(
      names.map(async (name) => {
        const candidate = await readDbFileCandidate(join(input.conversationDir, name), input.statFile)
        if (!candidate) return null
        return {
          ...candidate,
          ...readMetadata(input.scanState, basename(name, '.db'))
        }
      })
    )
    const completeDirectoryScan = candidates.every((candidate) => candidate !== null)
    if (input.requireCompleteDirectoryScan && !completeDirectoryScan) {
      throw new Error(
        `${input.sourceLabel ?? 'Antigravity CLI'} full history scan could not read every enumerated SQLite database; retry after the conversations directory is stable`
      )
    }
    const includedCandidates = candidates.filter(
      (candidate): candidate is DbFileCandidate =>
        candidate !== null &&
        shouldIncludeDbCandidate(
          candidate,
          input.lastSeenRowIndexByCascadeHash,
          input.includeFileMtime,
          input.forceFullScanCascadeHashes
        )
    )
    return {
      dbFiles: sortDbCandidates(includedCandidates),
      completeDirectoryScan,
      knownCascadeIds: new Set(names.map((name) => basename(name, '.db')))
    }
  }
  const scanState = input.scanState ?? { nextSequence: 0, files: {} }
  const checkedSequence = beginAntigravityFileScan(scanState)
  const scanLimit = Math.min(512, Math.max(16, input.maxDbFiles * 8))
  const ids = names.map((name) => basename(name, '.db'))
  pruneAntigravityFileScanState(scanState, ids)
  const forcedIds = ids.filter((id) => input.forceFullScanCascadeHashes?.has(hash(id)) === true)
  const selectedIds = selectAntigravityFileScanIds(ids, scanState, scanLimit)
  const forcedIdSet = new Set(forcedIds)
  const scanIds = [...forcedIds, ...selectedIds.filter((id) => !forcedIdSet.has(id))]
  let allScannedDbFilesReadable = true
  for (const id of scanIds) {
    const filePath = join(input.conversationDir, `${id}.db`)
    const metadata = readMetadata(scanState, id)
    const candidate = await readDbFileCandidate(filePath, input.statFile)
    if (!candidate) {
      allScannedDbFilesReadable = false
      removeAntigravityFileScanEntry(scanState, id)
      continue
    }
    markAntigravityFileScanned(
      scanState,
      id,
      {
        mtimeMs: candidate.mtimeMs,
        size: candidate.size,
        hasDatabaseFile: true
      },
      checkedSequence
    )
    writeMetadata(scanState, id, metadata)
  }
  const candidates = ids
    .map((id) => {
      const entry = readAntigravityFileScanEntry(scanState, id)
      return entry
        ? {
            filePath: join(input.conversationDir, `${id}.db`),
            mtimeMs: entry.mtimeMs,
            size: entry.size,
            ...readMetadata(scanState, id)
          }
        : null
    })
    .filter(
      (candidate): candidate is DbFileCandidate =>
        candidate !== null &&
        shouldIncludeDbCandidate(
          candidate,
          input.lastSeenRowIndexByCascadeHash,
          input.includeFileMtime,
          input.forceFullScanCascadeHashes
        )
    )
  const sorted = sortDbCandidates(candidates)
  const forced = sorted.filter((candidate) => isForcedFullScanCandidate(candidate, input.forceFullScanCascadeHashes))
  const unread = [
    ...forced,
    ...sorted.filter(
      (candidate) =>
        !forced.includes(candidate) && !hasDbRowCursor(candidate.filePath, input.lastSeenRowIndexByCascadeHash)
    )
  ]
  const processed = sorted.filter(
    (candidate) =>
      !forced.includes(candidate) && hasDbRowCursor(candidate.filePath, input.lastSeenRowIndexByCascadeHash)
  )
  const dbFiles = selectDbReadCandidates(unread, processed, input.maxDbFiles, checkedSequence)
  return {
    dbFiles,
    completeDirectoryScan:
      allScannedDbFilesReadable && scanIds.length === ids.length && dbFiles.length === candidates.length,
    knownCascadeIds: new Set(ids)
  }
}

function isForcedFullScanCandidate(candidate: { filePath: string }, forceFullScanCascadeHashes?: ReadonlySet<string>) {
  return forceFullScanCascadeHashes?.has(hash(basename(candidate.filePath, '.db'))) === true
}

function buildFileMtimeFilter(sinceDate?: string, timezone?: string) {
  if (!sinceDate || !timezone) return () => true
  return (mtimeMs: number) => formatDate(new Date(mtimeMs), timezone) >= sinceDate
}

function shouldIncludeDbCandidate(
  candidate: { filePath: string; mtimeMs: number },
  lastSeenRowIndexByCascadeHash: Map<string, number>,
  includeFileMtime: (mtimeMs: number) => boolean,
  forceFullScanCascadeHashes?: ReadonlySet<string>
) {
  const cascadeHash = hash(basename(candidate.filePath, '.db'))
  if (forceFullScanCascadeHashes?.has(cascadeHash)) return true
  return !hasDbRowCursor(candidate.filePath, lastSeenRowIndexByCascadeHash) || includeFileMtime(candidate.mtimeMs)
}

function sortDbCandidates(candidates: DbFileCandidate[]) {
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
}

function selectDbReadCandidates<T>(unread: T[], processed: T[], limit: number, sequence: number) {
  if (unread.length === 0) return processed.slice(0, limit)
  if (processed.length === 0) return unread.slice(0, limit)
  if (limit === 1) return sequence % 2 === 0 ? unread.slice(0, 1) : processed.slice(0, 1)

  let unreadCapacity = Math.min(unread.length, Math.ceil(limit / 2))
  let processedCapacity = Math.min(processed.length, limit - unreadCapacity)
  let remaining = limit - unreadCapacity - processedCapacity
  const extraUnread = Math.min(unread.length - unreadCapacity, remaining)
  unreadCapacity += extraUnread
  remaining -= extraUnread
  processedCapacity += Math.min(processed.length - processedCapacity, remaining)
  return [...unread.slice(0, unreadCapacity), ...processed.slice(0, processedCapacity)]
}

function hasDbRowCursor(filePath: string, lastSeenRowIndexByCascadeHash: Map<string, number>) {
  return lastSeenRowIndexByCascadeHash.has(hash(basename(filePath, '.db')))
}

async function readDbFileCandidate(filePath: string, statFile: StatFile) {
  try {
    const info = await statFile(filePath)
    const walMtimeMs = await readWalMtime(filePath)
    return {
      filePath,
      mtimeMs: Math.max(info.mtimeMs, walMtimeMs ?? info.mtimeMs),
      size: info.size ?? 0
    }
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

async function readWalMtime(dbFilePath: string) {
  try {
    return (await stat(`${dbFilePath}-wal`)).mtimeMs
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

function normalizeMaxDbFiles(value: number | null | undefined) {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultMaxDbFiles
  return Math.min(Math.max(Math.trunc(value), 1), defaultMaxDbFiles)
}

async function* readGeneratorMetadataRows(
  dbFile: string,
  options: {
    sqliteBin?: string
    readSqlite?: ReadSqlite
    lastSeenRowIndex?: number
    detectRowCursorReset?: boolean
    previousHighWater?: number
    previousCursorRowIndex?: number
    previousCursorRowSha256?: string
    onHighWaterMark?: (value: number) => void
    onLastRow?: (row: { index: number; data: Buffer }) => void
  } = {}
) {
  const sqliteBin = options.sqliteBin ?? process.env.TOKENBOARD_SQLITE_BIN ?? 'sqlite3'
  let lastSeenRowIndex = normalizeLastSeenRowIndex(options.lastSeenRowIndex)
  const initialLastSeenRowIndex = lastSeenRowIndex
  let anchorsChecked = false
  let highWaterChecked = false
  while (true) {
    if (!anchorsChecked && options.detectRowCursorReset && initialLastSeenRowIndex >= 0) {
      const hasPreviousCursorRowIndex = options.previousCursorRowIndex !== undefined
      const hasPreviousCursorRowSha256 = options.previousCursorRowSha256 !== undefined
      if (hasPreviousCursorRowIndex !== hasPreviousCursorRowSha256) {
        throw new AntigravityDbRowCursorResetError(dbFile)
      }
      if (
        options.onHighWaterMark &&
        (options.previousHighWater === undefined || options.previousCursorRowSha256 === undefined)
      ) {
        throw new AntigravityDbRowCursorResetError(dbFile)
      }
      await assertGeneratorMetadataAnchors(dbFile, sqliteBin, options)
      anchorsChecked = true
    }
    const rows = await readGeneratorMetadataRowPage(dbFile, {
      sqliteBin,
      readSqlite: options.readSqlite,
      lastSeenRowIndex
    })
    const shouldCheckHighWater = !highWaterChecked && options.detectRowCursorReset && initialLastSeenRowIndex >= 0
    const highestRowIndex = shouldCheckHighWater
      ? await readHighestGeneratorMetadataRowIndex(dbFile, sqliteBin, options.readSqlite)
      : undefined
    highWaterChecked = true
    options.onHighWaterMark?.(highestRowIndex ?? rows[rows.length - 1]?.index ?? lastSeenRowIndex)
    if (rows.length === 0) {
      if (
        options.detectRowCursorReset &&
        initialLastSeenRowIndex >= 0 &&
        ((highestRowIndex ?? lastSeenRowIndex) < initialLastSeenRowIndex ||
          (options.previousHighWater !== undefined &&
            (highestRowIndex ?? lastSeenRowIndex) < options.previousHighWater))
      ) {
        throw new AntigravityDbRowCursorResetError(dbFile)
      }
      return
    }
    if (
      options.detectRowCursorReset &&
      initialLastSeenRowIndex >= 0 &&
      ((highestRowIndex ?? lastSeenRowIndex) < initialLastSeenRowIndex ||
        (options.previousHighWater !== undefined && (highestRowIndex ?? lastSeenRowIndex) < options.previousHighWater))
    ) {
      throw new AntigravityDbRowCursorResetError(dbFile)
    }
    options.onLastRow?.(rows[rows.length - 1])
    for (const row of rows) yield row
    const nextLastSeenRowIndex = rows[rows.length - 1]?.index
    if (nextLastSeenRowIndex === undefined || rows.length < generatorMetadataRowsPageSize) return
    if (nextLastSeenRowIndex <= lastSeenRowIndex) {
      throw new Error(`Antigravity SQLite metadata cursor did not advance for ${dbFile}`)
    }
    lastSeenRowIndex = nextLastSeenRowIndex
  }
}

async function assertGeneratorMetadataAnchors(
  dbFile: string,
  sqliteBin: string,
  options: {
    readSqlite?: ReadSqlite
    previousCursorRowIndex?: number
    previousCursorRowSha256?: string
  }
) {
  const hasPreviousCursorRowIndex = options.previousCursorRowIndex !== undefined
  const hasPreviousCursorRowSha256 = options.previousCursorRowSha256 !== undefined
  if (hasPreviousCursorRowIndex !== hasPreviousCursorRowSha256) {
    throw new AntigravityDbRowCursorResetError(dbFile)
  }
  const anchors = []
  if (options.previousCursorRowSha256 !== undefined && options.previousCursorRowIndex !== undefined) {
    anchors.push(options.previousCursorRowIndex)
  }
  if (anchors.length === 0) return
  const sql = `select idx, hex(data) from gen_metadata where idx in (${anchors.join(', ')}) order by idx`
  const rows = (await readSqliteOutput(dbFile, sqliteBin, sql, options.readSqlite))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseSqliteRow(line, dbFile))
  const row = rows.find((candidate) => candidate.index === options.previousCursorRowIndex)
  if (!row || hashBytes(row.data) !== options.previousCursorRowSha256) {
    throw new AntigravityDbRowCursorResetError(dbFile)
  }
}

function readMetadata(scanState: AntigravityFileScanState | undefined, cascadeId: string): DbFileMetadata {
  const entry = scanState?.files[hash(cascadeId)] as AntigravityDbFileScanEntry | undefined
  return {
    metadataRowHighWater: validMetadataRowIndex(entry?.metadataRowHighWater),
    metadataCursorRowIndex: validMetadataRowIndex(entry?.metadataCursorRowIndex),
    metadataCursorRowSha256: validMetadataRowHash(entry?.metadataCursorRowSha256)
  }
}

function writeMetadata(
  scanState: AntigravityFileScanState,
  cascadeId: string,
  metadata: DbFileMetadata,
  candidate?: Pick<DbFileCandidate, 'mtimeMs' | 'size'>
) {
  const key = hash(cascadeId)
  const entry =
    (scanState.files[key] as AntigravityDbFileScanEntry | undefined) ??
    (candidate
      ? (scanState.files[key] = {
          mtimeMs: candidate.mtimeMs,
          size: candidate.size,
          hasDatabaseFile: true,
          checkedSequence: scanState.nextSequence
        })
      : undefined)
  if (!entry) return
  Object.assign(entry, metadata)
}

function validMetadataRowIndex(value: number | undefined) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 ? value : undefined
}

function validMetadataRowHash(value: string | undefined) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined
}

function hashBytes(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

async function readGeneratorMetadataRowPage(
  dbFile: string,
  options: {
    sqliteBin: string
    readSqlite?: ReadSqlite
    lastSeenRowIndex: number
  }
) {
  const sql = `select idx, hex(data) from gen_metadata where idx > ${options.lastSeenRowIndex} order by idx limit ${generatorMetadataRowsPageSize}`
  const stdout = await readSqliteOutput(dbFile, options.sqliteBin, sql, options.readSqlite)
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseSqliteRow(line, dbFile))
}

async function readHighestGeneratorMetadataRowIndex(dbFile: string, sqliteBin: string, readSqlite?: ReadSqlite) {
  const stdout = await readSqliteOutput(dbFile, sqliteBin, 'select max(idx) from gen_metadata', readSqlite)
  const value = stdout.trim()
  if (!value) return -1
  const index = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== value) {
    throw new Error(`Invalid Antigravity SQLite metadata row index in ${dbFile}`)
  }
  return index
}

async function readSqliteOutput(dbFile: string, sqliteBin: string, sql: string, readSqlite?: ReadSqlite) {
  try {
    return readSqlite
      ? await readSqlite(dbFile, sql)
      : (
          await execFileAsync(sqliteBin, ['-batch', dbFile, sql], {
            maxBuffer: maxSqliteOutputBytes,
            timeout: sqliteTimeoutMs,
            killSignal: 'SIGKILL'
          })
        ).stdout
  } catch (error) {
    if (!readSqlite && isMissingFileError(error)) {
      throw new Error(`Antigravity SQLite reader unavailable: ${sqliteBin} not found`)
    }
    throw new Error(`Failed to read Antigravity SQLite metadata from ${dbFile}: ${errorMessage(error)}`)
  }
}

function normalizeLastSeenRowIndex(value: number | undefined) {
  if (value === undefined) return -1
  if (!Number.isSafeInteger(value) || value < -1) return -1
  return value
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function parseSqliteRow(line: string, dbFile: string) {
  const delimiter = line.indexOf('|')
  if (delimiter <= 0) {
    throw new Error(`Invalid Antigravity SQLite metadata row in ${dbFile}`)
  }
  const rawIndex = line.slice(0, delimiter)
  const index = Number(rawIndex)
  const hex = line.slice(delimiter + 1)
  if (!/^[0-9]+$/.test(rawIndex) || !Number.isSafeInteger(index) || !/^[0-9A-F]*$/.test(hex)) {
    throw new Error(`Invalid Antigravity SQLite metadata row in ${dbFile}`)
  }
  return { index, data: Buffer.from(hex, 'hex') }
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
