import { usageSnapshotSchema, type UsageSnapshot, type UsageSource } from '@tokenboard/usage-core'
import { hasUnparsedTokenMetricField } from './session-jsonl-token-fields'

type ParseInput = {
  source: UsageSource
  timezone: string
  collectedAt: string
  sessionId: string
  content: string
}

type ParseLinesInput = Omit<ParseInput, 'content'> & {
  lines: AsyncIterable<string>
}

type ParseContext = Omit<ParseInput, 'content'>

type ParseState = {
  rows: Map<string, AggregateRow>
  ignoredUploadSafeRows: number
  malformedRows: number
  missingCost: boolean
  unparsedTokenLikeRows: number
}

type MetricRow = {
  usageDate: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  costUsd: number
  hasCost: boolean
}

type AggregateRow = Omit<MetricRow, 'hasCost'> & {
  sessions: Set<string>
}

type UnknownRecord = Record<string, unknown>

export function parseSessionJsonl(input: ParseInput): {
  snapshots: UsageSnapshot[]
  ignoredUploadSafeRows: number
  malformedRows: number
  missingCost: boolean
  unparsedTokenLikeRows: number
} {
  const state = createParseState()
  for (const line of input.content.split('\n')) {
    consumeLine(state, input, line)
  }
  return finishParseState(state, input)
}

export async function parseSessionJsonlLines(input: ParseLinesInput) {
  const state = createParseState()
  for await (const line of input.lines) {
    consumeLine(state, input, line)
  }
  return finishParseState(state, input)
}

function createParseState(): ParseState {
  return {
    rows: new Map(),
    ignoredUploadSafeRows: 0,
    malformedRows: 0,
    missingCost: false,
    unparsedTokenLikeRows: 0
  }
}

function consumeLine(state: ParseState, input: ParseContext, line: string) {
  const record = readLineRecord(state, line)
  if (!record) return

  const metric = input.source === 'codex'
    ? readCodexMetric(record, input.timezone)
    : readClaudeMetric(record, input.timezone)
  if (!metric) {
    if (isKnownCodexTokenMetadata(input.source, record)) return
    if (isKnownClaudeSyntheticZeroUsage(input.source, record)) {
      state.ignoredUploadSafeRows += 1
      return
    }
    if (hasUnparsedTokenMetricField(input.source, record)) state.unparsedTokenLikeRows += 1
    return
  }

  state.missingCost ||= !metric.hasCost
  mergeMetric(state.rows, metric, input.sessionId)
}

function finishParseState(state: ParseState, input: ParseContext) {
  return {
    ignoredUploadSafeRows: state.ignoredUploadSafeRows,
    malformedRows: state.malformedRows,
    missingCost: state.missingCost,
    unparsedTokenLikeRows: state.unparsedTokenLikeRows,
    snapshots: [...state.rows.values()].map((row) => toSnapshot(row, input))
  }
}

function readCodexMetric(record: UnknownRecord, timezone: string): MetricRow | null {
  if (record.type !== 'event_msg') return null
  const payload = readRecord(record.payload)
  if (payload?.type !== 'token_count') return null

  const info = readRecord(payload.info)
  const usage = readRecord(info?.last_token_usage ?? payload.usage)
  const timestamp = readTimestamp(record)
  if (!usage || !timestamp) return null

  const model = readString(info, ['model']) || readString(usage, ['model']) || 'all'
  return buildMetric({ record, usage, model, timestamp, timezone })
}

function isKnownCodexTokenMetadata(source: UsageSource, record: UnknownRecord) {
  if (source !== 'codex' || record.type !== 'event_msg') return false
  const payload = readRecord(record.payload)
  if (payload?.type !== 'token_count') return false

  const info = readRecord(payload.info)
  const usage = readRecord(info?.last_token_usage ?? payload.usage)
  if (usage) return false
  return Boolean(readRecord(info?.total_token_usage) ?? readRecord(payload.total_token_usage))
}

function readClaudeMetric(record: UnknownRecord, timezone: string): MetricRow | null {
  const message = readRecord(record.message) ?? record
  const usage = readRecord(message.usage ?? record.usage)
  const timestamp = readTimestamp(record)
  if (!usage || !timestamp) return null

  const model = readString(message, ['model', 'modelName']) || readString(record, ['model']) || 'all'
  if (isSyntheticZeroUsage(model, usage)) return null
  return buildMetric({ record, usage, model, timestamp, timezone })
}

function isKnownClaudeSyntheticZeroUsage(source: UsageSource, record: UnknownRecord) {
  if (source !== 'claude-code') return false
  const message = readRecord(record.message) ?? record
  const usage = readRecord(message.usage ?? record.usage)
  if (!usage) return false

  const model = readString(message, ['model', 'modelName']) || readString(record, ['model']) || 'all'
  return isSyntheticZeroUsage(model, usage)
}

function isSyntheticZeroUsage(model: string, usage: UnknownRecord) {
  if (model !== '<synthetic>') return false
  return [
    'input_tokens',
    'inputTokens',
    'output_tokens',
    'outputTokens',
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cacheCreationTokens',
    'cache_read_input_tokens',
    'cached_input_tokens',
    'cacheReadInputTokens',
    'cachedInputTokens',
    'cacheReadTokens',
    'total_tokens',
    'totalTokens'
  ].every((key) => readOptionalNumber(usage, [key]) === null || readOptionalNumber(usage, [key]) === 0)
}

function buildMetric(input: {
  record: UnknownRecord
  usage: UnknownRecord
  model: string
  timestamp: Date
  timezone: string
}): MetricRow {
  const inputTokens = readNumber(input.usage, ['input_tokens', 'inputTokens'])
  const outputTokens = readNumber(input.usage, ['output_tokens', 'outputTokens'])
  const cacheCreationTokens = readNumber(input.usage, [
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cacheCreationTokens'
  ])
  const cacheReadTokens = readNumber(input.usage, [
    'cache_read_input_tokens',
    'cached_input_tokens',
    'cacheReadInputTokens',
    'cachedInputTokens',
    'cacheReadTokens'
  ])
  const costUsd = readCostUsd(input.usage, input.record)

  return {
    usageDate: formatDate(input.timestamp, input.timezone),
    model: input.model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: readTotalTokens(input.usage, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens),
    costUsd: costUsd.value,
    hasCost: costUsd.found
  }
}

function mergeMetric(rows: Map<string, AggregateRow>, metric: MetricRow, sessionId: string) {
  const key = `${metric.usageDate}\0${metric.model}`
  const current = rows.get(key)
  if (!current) {
    rows.set(key, { ...metric, sessions: new Set([sessionId]) })
    return
  }

  current.inputTokens += metric.inputTokens
  current.outputTokens += metric.outputTokens
  current.cacheCreationTokens += metric.cacheCreationTokens
  current.cacheReadTokens += metric.cacheReadTokens
  current.totalTokens += metric.totalTokens
  current.costUsd += metric.costUsd
  current.sessions.add(sessionId)
}

function toSnapshot(row: AggregateRow, input: ParseContext) {
  return usageSnapshotSchema.parse({
    source: input.source,
    usageDate: row.usageDate,
    timezone: input.timezone,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheReadTokens: row.cacheReadTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    sessionCount: row.sessions.size,
    collectedAt: input.collectedAt
  })
}

function readLineRecord(state: ParseState, line: string) {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return readRecord(JSON.parse(trimmed))
  } catch {
    state.malformedRows += 1
    return null
  }
}

function readTimestamp(record: UnknownRecord) {
  const value = readString(record, ['timestamp', 'createdAt', 'created_at'])
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function readTotalTokens(
  usage: UnknownRecord,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number
) {
  const total = readNumber(usage, ['total_tokens', 'totalTokens'])
  return total > 0 ? total : inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
}

function readCostUsd(usage: UnknownRecord, record: UnknownRecord) {
  for (const source of [usage, record]) {
    const value = readOptionalNumber(source, ['cost_usd', 'costUsd', 'costUSD', 'total_cost', 'totalCost'])
    if (value !== null) return { found: true, value }
  }
  return { found: false, value: 0 }
}

function readOptionalNumber(record: UnknownRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function readNumber(record: UnknownRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

function readString(record: UnknownRecord | null | undefined, keys: string[]) {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function readRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function formatDate(date: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Invalid timezone for session JSONL formatDate: ${timezone}`)
    }
    throw error
  }
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}
