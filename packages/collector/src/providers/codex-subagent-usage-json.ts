import { createReadStream } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { TextDecoder } from 'node:util'
import { assertValidIsoCalendarDate } from '../iso-calendar-date'
import type { UsageSource } from '@tokenboard/usage-core'
import { normalizeCodexTotalTokens } from '../codex-token-usage'
import {
  createSessionJsonlMetadataScanner,
  finishSessionJsonlMetadataScan,
  hasRelevantSessionJsonlMetadata,
  readSessionJsonlMetadataRecord,
  readSessionJsonlRecordType,
  scanSessionJsonlMetadata,
  type SessionJsonlMetadataRecord,
  type SessionJsonlMetadataScanner
} from './session-jsonl-metadata-scanner'

export type UnknownRecord = Record<string, unknown>

export type JsonlReadLimits = {
  maxBytes?: number
  maxLineBytes?: number
  maxDiscardedLineBytes?: number
  relevantMetadataKeys?: readonly string[]
  discardableLineTypes?: readonly string[]
  label?: string
}

export async function* readJsonlRecords(
  filePath: string,
  stderr?: (line: string) => void,
  limits: JsonlReadLimits = {}
): AsyncIterable<UnknownRecord> {
  if (limits.maxBytes === undefined) {
    yield* readJsonlRecordsFromStream(createReadStream(filePath), stderr, limits)
    return
  }

  const label = limits.label ?? 'Codex JSONL input'
  const file = await openVerifiedJsonlFile(filePath, limits.maxBytes, label)
  const stream =
    file.fingerprint.size === 0
      ? undefined
      : file.handle.createReadStream({ end: file.fingerprint.size - 1, autoClose: false })
  let completed = false
  let readerFailed = false
  try {
    if (!stream) return
    try {
      for await (const record of readJsonlRecordsFromStreamWithLifecycle(stream, stderr, limits, false)) {
        yield record
      }
      completed = true
    } catch (error) {
      readerFailed = true
      throw error
    }
  } finally {
    try {
      if (!readerFailed) await assertVerifiedJsonlFileUnchanged(filePath, file, label)
    } finally {
      if (!completed) stream?.destroy()
      await closeJsonlFileHandle(file.handle)
    }
  }
}

export async function* readJsonlRecordsFromStream(
  stream: Readable,
  stderr?: (line: string) => void,
  limits: JsonlReadLimits = {}
): AsyncIterable<UnknownRecord> {
  yield* readJsonlRecordsFromStreamWithLifecycle(stream, stderr, limits, true)
}

async function* readJsonlRecordsFromStreamWithLifecycle(
  stream: Readable,
  stderr: ((line: string) => void) | undefined,
  limits: JsonlReadLimits,
  destroyOnIncomplete: boolean
): AsyncIterable<UnknownRecord> {
  let lineNumber = 0
  let discardedRows = 0
  let projectedRows = 0
  let largestDiscardedRowBytes = 0
  const onDiscardedLine = (lineBytes: number, projection?: SessionJsonlMetadataRecord) => {
    if (projection) projectedRows += 1
    else discardedRows += 1
    largestDiscardedRowBytes = Math.max(largestDiscardedRowBytes, lineBytes)
  }

  try {
    for await (const line of readJsonlLines(stream, { ...limits, onDiscardedLine }, destroyOnIncomplete)) {
      lineNumber += 1
      if (line === null) continue
      if (typeof line !== 'string') {
        yield line
        continue
      }
      if (!line.trim()) continue
      const record = parseJsonlRecord(line)
      if (record === 'malformed') {
        stderr?.(`Skipping malformed Codex subagent JSONL row at line ${lineNumber}`)
        continue
      }
      if (record) yield record
    }
  } finally {
    if (discardedRows > 0) {
      const label = limits.label ?? 'Codex JSONL input'
      stderr?.(
        `Skipped ${discardedRows} oversized ${label} JSONL row${discardedRows === 1 ? '' : 's'} without usage or subagent metadata (largest ${largestDiscardedRowBytes} bytes)`
      )
    }
    if (projectedRows > 0) {
      const label = limits.label ?? 'Codex JSONL input'
      stderr?.(
        `Retained bounded turn_context metadata from ${projectedRows} oversized ${label} JSONL row${projectedRows === 1 ? '' : 's'} (largest ${largestDiscardedRowBytes} bytes)`
      )
    }
  }
}

type JsonlReadRuntimeLimits = JsonlReadLimits & {
  onDiscardedLine?: (lineBytes: number, projection?: SessionJsonlMetadataRecord) => void
}

type JsonlLineState = {
  chunks: Buffer[]
  bytes: number
  skipping: boolean
  metadataScanner: SessionJsonlMetadataScanner
  startsAsObject: boolean | undefined
}

const codexSource: UsageSource = 'codex'

async function* readJsonlLines(
  stream: Readable,
  limits: JsonlReadRuntimeLimits,
  destroyOnIncomplete: boolean
): AsyncIterable<string | SessionJsonlMetadataRecord | null> {
  let line = emptyLineState(limits)
  let skipLeadingLineFeed = false
  let completed = false
  let totalBytes = 0

  try {
    const chunks = destroyOnIncomplete ? stream : stream.iterator({ destroyOnReturn: false })
    for await (const chunk of chunks) {
      const buffer = toBuffer(chunk)
      totalBytes += buffer.length
      assertTotalBytesLimit(totalBytes, limits)
      let offset = 0
      if (skipLeadingLineFeed) {
        if (buffer.length === 0) continue
        if (buffer[0] === 0x0a) offset = 1
        skipLeadingLineFeed = false
      }

      while (offset < buffer.length) {
        const terminator = findLineTerminator(buffer, offset)
        const end = terminator === -1 ? buffer.length : terminator
        appendLineSegment(buffer.subarray(offset, end), line, limits)
        if (terminator === -1) break

        yield finishLine(line, limits)
        line = emptyLineState(limits)

        const terminatorByte = buffer[terminator]
        offset = terminator + 1
        if (terminatorByte === 0x0d) {
          if (offset < buffer.length && buffer[offset] === 0x0a) {
            offset += 1
          } else if (offset === buffer.length) {
            skipLeadingLineFeed = true
          }
        }
      }
    }

    if (line.bytes > 0) yield finishLine(line, limits)
    completed = true
  } finally {
    if (!completed && destroyOnIncomplete) stream.destroy()
  }
}

function emptyLineState(limits: JsonlReadRuntimeLimits): JsonlLineState {
  return {
    chunks: [],
    bytes: 0,
    skipping: false,
    startsAsObject: undefined,
    metadataScanner: createSessionJsonlMetadataScanner({
      additionalRelevantKeys: limits.relevantMetadataKeys
    })
  }
}

function appendLineSegment(segment: Buffer, line: JsonlLineState, limits: JsonlReadRuntimeLimits) {
  if (segment.length === 0) return
  recordLinePrefix(segment, line)
  const nextBytes = line.bytes + segment.length
  if (!line.skipping && (limits.maxLineBytes === undefined || nextBytes <= limits.maxLineBytes)) {
    line.chunks.push(segment)
    line.bytes = nextBytes
    return
  }

  if (!line.skipping && line.startsAsObject !== true) throw lineLimitError(limits)
  scanSessionJsonlMetadata(line.skipping ? [segment] : [...line.chunks, segment], line.metadataScanner, codexSource)
  if (line.metadataScanner.invalid) {
    throw malformedOversizedLineError(limits)
  }
  if (hasRelevantSessionJsonlMetadata(line.metadataScanner, codexSource)) throw oversizedRelevantLineError(limits)
  line.bytes = nextBytes
  if (!line.skipping) {
    if (limits.maxDiscardedLineBytes === undefined) throw lineLimitError(limits)
    line.skipping = true
    line.chunks = []
  }
  assertDiscardedLineLimit(line.bytes, limits)
}

function finishLine(line: JsonlLineState, limits: JsonlReadRuntimeLimits) {
  if (line.skipping) {
    if (!finishSessionJsonlMetadataScan(line.metadataScanner)) {
      throw malformedOversizedLineError(limits)
    }
    if (hasRelevantSessionJsonlMetadata(line.metadataScanner, codexSource)) {
      throw oversizedRelevantLineError(limits)
    }
    if (!isDiscardableLineType(line.metadataScanner, limits)) {
      throw unknownOversizedLineTypeError(limits)
    }
    const projection = readSessionJsonlMetadataRecord(line.metadataScanner)
    limits.onDiscardedLine?.(line.bytes, projection ?? undefined)
    return projection
  }
  return decodeJsonlLine(Buffer.concat(line.chunks, line.bytes), limits)
}

function findLineTerminator(buffer: Buffer, offset: number) {
  const carriageReturn = buffer.indexOf(0x0d, offset)
  const lineFeed = buffer.indexOf(0x0a, offset)
  if (carriageReturn === -1) return lineFeed
  if (lineFeed === -1) return carriageReturn
  return Math.min(carriageReturn, lineFeed)
}

function toBuffer(chunk: unknown) {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  throw new Error('Codex JSONL stream emitted a non-byte chunk')
}

function assertDiscardedLineLimit(lineBytes: number, limits: JsonlReadRuntimeLimits) {
  if (limits.maxDiscardedLineBytes === undefined || lineBytes <= limits.maxDiscardedLineBytes) return
  const label = limits.label ?? 'Codex JSONL input'
  throw new Error(`${label} contains a line exceeding the ${limits.maxDiscardedLineBytes}-byte discarded-line limit`)
}

function assertTotalBytesLimit(totalBytes: number, limits: JsonlReadRuntimeLimits) {
  if (limits.maxBytes === undefined || totalBytes <= limits.maxBytes) return
  const label = limits.label ?? 'Codex JSONL input'
  throw new Error(`${label} exceeds the ${limits.maxBytes}-byte limit`)
}

function isDiscardableLineType(scanner: SessionJsonlMetadataScanner, limits: JsonlReadRuntimeLimits) {
  const types = limits.discardableLineTypes ?? []
  if (types.length === 0) return false
  const type = readSessionJsonlRecordType(scanner)
  return type !== undefined && types.includes(type)
}

function lineLimitError(limits: JsonlReadRuntimeLimits) {
  const label = limits.label ?? 'Codex JSONL input'
  return new Error(`${label} contains a line exceeding the ${limits.maxLineBytes}-byte limit`)
}

function oversizedRelevantLineError(limits: JsonlReadRuntimeLimits) {
  const label = limits.label ?? 'Codex JSONL input'
  return new Error(`${label} contains an oversized line with usage or subagent metadata`)
}

function malformedOversizedLineError(limits: JsonlReadRuntimeLimits) {
  const label = limits.label ?? 'Codex JSONL input'
  return new Error(`${label} contains a malformed oversized line`)
}

function unknownOversizedLineTypeError(limits: JsonlReadRuntimeLimits) {
  const label = limits.label ?? 'Codex JSONL input'
  return new Error(`${label} contains an oversized line with an unknown record type`)
}

function decodeJsonlLine(value: Buffer, limits: JsonlReadRuntimeLimits) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    const label = limits.label ?? 'Codex JSONL input'
    throw new Error(`${label} contains invalid UTF-8`)
  }
}

function recordLinePrefix(buffer: Buffer, line: JsonlLineState) {
  if (line.startsAsObject !== undefined) return
  for (const byte of buffer) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) continue
    line.startsAsObject = byte === 0x7b
    return
  }
}

type JsonlFileFingerprint = {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

async function openVerifiedJsonlFile(filePath: string, maxBytes: number, label: string) {
  const pathBefore = await lstat(filePath)
  assertJsonlFileAtPath(pathBefore, filePath, label)
  if (pathBefore.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`)
  }

  const handle = await open(filePath, 'r')
  try {
    const [handleBefore, pathAfterOpen] = await Promise.all([handle.stat(), lstat(filePath)])
    assertJsonlFileAtPath(pathAfterOpen, filePath, label)
    const fingerprint = jsonlFileFingerprint(handleBefore)
    if (
      !sameJsonlFileFingerprint(jsonlFileFingerprint(pathBefore), fingerprint) ||
      !sameJsonlFileFingerprint(jsonlFileFingerprint(pathAfterOpen), fingerprint)
    ) {
      throw new Error(`${label} changed before reading; retry the sync`)
    }
    return { handle, fingerprint }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function assertVerifiedJsonlFileUnchanged(
  filePath: string,
  file: { handle: FileHandle; fingerprint: JsonlFileFingerprint },
  label: string
) {
  const [handleAfter, pathAfter] = await Promise.all([file.handle.stat(), lstat(filePath)])
  assertJsonlFileAtPath(pathAfter, filePath, label)
  if (
    !sameJsonlFileFingerprint(jsonlFileFingerprint(handleAfter), file.fingerprint) ||
    !sameJsonlFileFingerprint(jsonlFileFingerprint(pathAfter), file.fingerprint)
  ) {
    throw new Error(`${label} changed while reading; retry the sync`)
  }
}

async function closeJsonlFileHandle(handle: FileHandle) {
  try {
    await handle.close()
  } catch (error) {
    if (isBadFileDescriptorError(error)) return
    throw error
  }
}

function isBadFileDescriptorError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EBADF'
}

function assertJsonlFileAtPath(details: Awaited<ReturnType<typeof lstat>>, filePath: string, label: string) {
  if (details.isSymbolicLink()) {
    throw new Error(`Unable to read ${label}: symbolic links are not supported`)
  }
  if (!details.isFile()) throw new Error(`Unable to read ${label}: path is not a file`)
}

function jsonlFileFingerprint(details: {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}): JsonlFileFingerprint {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs
  }
}

function sameJsonlFileFingerprint(left: JsonlFileFingerprint, right: JsonlFileFingerprint) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function parseJsonlRecord(line: string): UnknownRecord | 'malformed' | null {
  try {
    return readRecord(JSON.parse(line))
  } catch {
    return 'malformed'
  }
}

export function extractRows(input: unknown): UnknownRecord[] {
  if (Array.isArray(input)) return input.filter(isRecord)
  if (!isRecord(input)) return []
  for (const key of ['sessions', 'data', 'rows', 'items']) {
    const value = input[key]
    if (Array.isArray(value)) return value.filter(isRecord)
  }
  return []
}

export function normalizeDate(value: string) {
  assertValidIsoCalendarDate(value, 'Invalid Codex date')
  if (isoDateOnlyPattern.test(value)) return value

  if (isoTimestampPattern.test(value)) {
    const directParsed = Date.parse(value)
    if (!Number.isNaN(directParsed)) return new Date(directParsed).toISOString().slice(0, 10)
  }

  const parsed = Date.parse(`${value} UTC`)
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString().slice(0, 10)
}

const isoDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T/

export function readNumber(record: UnknownRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  }
  return 0
}

export function readTotalTokens(row: UnknownRecord) {
  const explicitTotal = readNumber(row, ['totalTokens', 'total_tokens'])
  return normalizeCodexTotalTokens({
    inputTokens: readNumber(row, ['inputTokens', 'input_tokens']),
    outputTokens: readNumber(row, ['outputTokens', 'output_tokens']),
    cacheCreationTokens: readCacheCreationTokens(row),
    cacheReadTokens: readCacheReadTokens(row),
    explicitTotalTokens: explicitTotal > 0 ? explicitTotal : undefined
  })
}

export function readCacheCreationTokens(row: UnknownRecord) {
  return readNumber(row, [
    'cacheCreationTokens',
    'cacheCreationInputTokens',
    'inputCacheCreationTokens',
    'cache_creation_tokens',
    'cache_creation_input_tokens',
    'input_cache_creation_tokens',
    'cache_write_input_tokens'
  ])
}

export function readCacheReadTokens(row: UnknownRecord) {
  return readNumber(row, [
    'cacheReadTokens',
    'cacheReadInputTokens',
    'cachedInputTokens',
    'cache_read_tokens',
    'cache_read_input_tokens',
    'cached_input_tokens'
  ])
}

export function readString(record: UnknownRecord | null | undefined, keys: string[]) {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

export function readRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
