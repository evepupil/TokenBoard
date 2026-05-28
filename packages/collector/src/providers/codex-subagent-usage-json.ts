import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export type UnknownRecord = Record<string, unknown>

export async function* readJsonlRecords(
  filePath: string,
  stderr?: (line: string) => void
): AsyncIterable<UnknownRecord> {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  let lineNumber = 0
  for await (const line of lines) {
    lineNumber += 1
    if (!line.trim()) continue
    const record = parseJsonlRecord(line)
    if (record === 'malformed') {
      stderr?.(`Skipping malformed Codex subagent JSONL row at line ${lineNumber}`)
      continue
    }
    if (record) yield record
  }
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value

  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const directParsed = Date.parse(value)
    if (!Number.isNaN(directParsed)) return new Date(directParsed).toISOString().slice(0, 10)
  }

  const parsed = Date.parse(`${value} UTC`)
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString().slice(0, 10)
}

export function readNumber(record: UnknownRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

export function readTotalTokens(row: UnknownRecord) {
  const total = readNumber(row, ['totalTokens', 'total_tokens'])
  return total > 0
    ? total
    : (
      readNumber(row, ['inputTokens', 'input_tokens']) +
      readNumber(row, ['outputTokens', 'output_tokens']) +
      readCacheCreationTokens(row) +
      readCacheReadTokens(row)
    )
}

export function readCacheCreationTokens(row: UnknownRecord) {
  return readNumber(row, [
    'cacheCreationTokens',
    'cacheCreationInputTokens',
    'inputCacheCreationTokens',
    'cache_creation_tokens',
    'cache_creation_input_tokens',
    'input_cache_creation_tokens'
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
