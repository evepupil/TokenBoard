import { usageSnapshotSchema, type UsageSnapshot, type UsageSource } from '@tokenboard/usage-core'
import { assertValidIsoCalendarDate } from './iso-calendar-date'
import { normalizeCodexTotalTokens } from './codex-token-usage'

type NormalizeOptions = {
  source: UsageSource
  timezone: string
  collectedAt?: string
  sessions?: unknown
  includeSessionOnlySnapshots?: boolean
}

type UnknownRecord = Record<string, unknown>
export type CcusageSessionAttribution = {
  usageDate: string
  model: string
}

type SessionCountState = {
  provided: boolean
  counts: Map<string, number>
  attributions: Map<string, CcusageSessionAttribution>
}

const dateFormatterByTimezone = new Map<string, Intl.DateTimeFormat>()
const inputTokenKeys = ['inputTokens', 'input_tokens']
const outputTokenKeys = ['outputTokens', 'output_tokens']
const cacheCreationTokenKeys = [
  'cacheCreationTokens',
  'cacheCreationInputTokens',
  'inputCacheCreationTokens',
  'cache_creation_tokens',
  'cache_creation_input_tokens',
  'input_cache_creation_tokens',
  'cache_write_input_tokens'
]
const cacheReadTokenKeys = [
  'cacheReadTokens',
  'cacheReadInputTokens',
  'cachedInputTokens',
  'cache_read_tokens',
  'cache_read_input_tokens',
  'cached_input_tokens'
]

export function normalizeCcusageDailyJson(input: unknown, options: NormalizeOptions): UsageSnapshot[] {
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const sessionCounts = getSessionCounts(options.sessions, options.timezone, options.source)

  const snapshots = extractDailyRows(input).flatMap((row) =>
    extractModelRows(row).map(({ model, metrics, parent }) =>
      usageSnapshotSchema.parse({
        source: options.source,
        usageDate: readDate(row),
        timezone: options.timezone,
        model,
        inputTokens: readNumber(metrics, inputTokenKeys),
        outputTokens: readNumber(metrics, outputTokenKeys),
        cacheCreationTokens: readNumber(metrics, cacheCreationTokenKeys),
        cacheReadTokens: readNumber(metrics, cacheReadTokenKeys),
        totalTokens: readTotalTokens(metrics, options.source),
        costUsd: readCostUsd(metrics, parent, options.source),
        sessionCount: readSessionCount({
          sessionCounts,
          usageDate: readDate(row),
          model,
          metrics
        }),
        collectedAt
      })
    )
  )
  return appendSessionOnlySnapshots(snapshots, sessionCounts, {
    source: options.source,
    timezone: options.timezone,
    collectedAt,
    includeSessionOnlySnapshots: options.includeSessionOnlySnapshots ?? false
  })
}

function getSessionCounts(input: unknown, timezone: string, source: UsageSource) {
  const counts = new Map<string, number>()
  const attributions = new Map<string, CcusageSessionAttribution>()

  for (const row of extractDailyRows(input)) {
    const attribution = readCcusageSessionAttribution(row, timezone, source)
    if (!attribution) continue
    const key = sessionCountKey(attribution.usageDate, attribution.model)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    attributions.set(key, attribution)
  }

  return {
    provided: input !== undefined,
    counts,
    attributions
  }
}

function appendSessionOnlySnapshots(
  snapshots: UsageSnapshot[],
  sessionCounts: SessionCountState,
  input: {
    source: UsageSource
    timezone: string
    collectedAt: string
    includeSessionOnlySnapshots: boolean
  }
) {
  if (!input.includeSessionOnlySnapshots || !sessionCounts.provided || sessionCounts.counts.size === 0) {
    return snapshots
  }
  const existing = new Set(snapshots.map((snapshot) => sessionCountKey(snapshot.usageDate, snapshot.model)))
  const sessionOnly: UsageSnapshot[] = []
  for (const [key, sessionCount] of sessionCounts.counts) {
    if (existing.has(key) || sessionCount <= 0) continue
    const attribution = sessionCounts.attributions.get(key)
    if (!attribution) continue
    sessionOnly.push(
      usageSnapshotSchema.parse({
        source: input.source,
        usageDate: attribution.usageDate,
        timezone: input.timezone,
        model: attribution.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        sessionCount,
        collectedAt: input.collectedAt
      })
    )
  }
  return [...snapshots, ...sessionOnly]
}

function readSessionCount(input: {
  sessionCounts: SessionCountState
  usageDate: string
  model: string
  metrics: UnknownRecord
}) {
  if (input.sessionCounts.provided) {
    return input.sessionCounts.counts.get(sessionCountKey(input.usageDate, input.model)) ?? 0
  }

  return readNumber(input.metrics, ['sessionCount', 'sessions'])
}

function readSessionDate(row: UnknownRecord, timezone: string) {
  const value = row.lastActivity ?? row.date ?? row.usageDate
  if (typeof value !== 'string') {
    return null
  }
  return formatDate(value, timezone)
}

export function readCcusageSessionAttribution(
  row: unknown,
  timezone: string,
  source: UsageSource = 'claude-code'
): CcusageSessionAttribution | null {
  if (!isRecord(row)) return null
  const usageDate = readSessionDate(row, timezone)
  if (!usageDate) return null
  return {
    usageDate,
    model: readSessionCountModel(row, source)
  }
}

function readSessionCountModel(row: UnknownRecord, source: UsageSource) {
  const rows = extractModelRows(row)
  const first = rows[0] ?? { model: readModel(row), metrics: row, parent: row }
  return rows
    .slice(1)
    .reduce(
      (selected, candidate) =>
        readTotalTokens(candidate.metrics, source) > readTotalTokens(selected.metrics, source) ? candidate : selected,
      first
    ).model
}

function sessionCountKey(date: string, model: string) {
  return `${date}\u0000${model}`
}

function extractDailyRows(input: unknown): UnknownRecord[] {
  if (Array.isArray(input)) {
    return input.filter(isRecord)
  }

  if (!isRecord(input)) {
    return []
  }

  for (const key of ['data', 'daily', 'rows', 'items', 'sessions']) {
    const value = input[key]
    if (Array.isArray(value)) {
      return value.filter(isRecord)
    }
  }

  return hasTokenMetrics(input) ? [input] : []
}

function extractModelRows(row: UnknownRecord) {
  const breakdown = row.breakdown
  if (isRecord(breakdown)) {
    const rows = Object.entries(breakdown)
      .filter(([, metrics]) => isRecord(metrics))
      .map(([model, metrics]) => ({ model, metrics: metrics as UnknownRecord, parent: row }))
    if (rows.length > 0) return rows
  }

  const modelBreakdowns = row.modelBreakdowns
  if (Array.isArray(modelBreakdowns)) {
    const rows = modelBreakdowns.filter(isRecord).map((metrics) => ({
      model: readModel(metrics),
      metrics,
      parent: row
    }))
    if (rows.length > 0) return rows
  }

  if (isRecord(modelBreakdowns)) {
    const rows = Object.entries(modelBreakdowns)
      .filter(([, metrics]) => isRecord(metrics))
      .map(([model, metrics]) => ({ model, metrics: metrics as UnknownRecord, parent: row }))
    if (rows.length > 0) return rows
  }

  const models = row.models
  if (isRecord(models) && !Array.isArray(models)) {
    const rows = Object.entries(models)
      .filter(([, metrics]) => isRecord(metrics))
      .map(([model, metrics]) => ({ model, metrics: metrics as UnknownRecord, parent: row }))
    if (rows.length > 0) return rows
  }

  return [{ model: readModel(row), metrics: row, parent: row }]
}

function readDate(row: UnknownRecord) {
  const value = row.date ?? row.usageDate ?? row.period
  if (typeof value !== 'string') {
    throw new Error('ccusage row is missing date')
  }
  return normalizeDate(value)
}

function readModel(row: UnknownRecord) {
  for (const key of ['model', 'modelName', 'name']) {
    const value = row[key]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }

  for (const key of ['models', 'modelsUsed']) {
    const value = row[key]
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
      return value[0]
    }
  }

  return 'all'
}

function readTotalTokens(row: UnknownRecord, source: UsageSource = 'claude-code') {
  const inputTokens = readNumber(row, inputTokenKeys)
  const outputTokens = readNumber(row, outputTokenKeys)
  const cacheCreationTokens = readNumber(row, cacheCreationTokenKeys)
  const cacheReadTokens = readNumber(row, cacheReadTokenKeys)
  const explicitTotal = readNumber(row, ['totalTokens', 'total_tokens'])
  if (source === 'codex') {
    return normalizeCodexTotalTokens({
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      explicitTotalTokens: explicitTotal > 0 ? explicitTotal : undefined
    })
  }
  if (explicitTotal > 0) return explicitTotal
  return inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
}

function readNumber(row: UnknownRecord, keys: readonly string[]) {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }

  return 0
}

function readCostUsd(row: UnknownRecord, parent: UnknownRecord, source: UsageSource = 'claude-code') {
  const directCost = readNumber(row, ['costUsd', 'costUSD', 'totalCost', 'cost'])
  if (directCost > 0) {
    return directCost
  }

  if (row === parent) {
    return directCost
  }

  const parentCost = readNumber(parent, ['costUsd', 'costUSD', 'totalCost', 'cost'])
  const parentTokens = readTotalTokens(parent, source)
  const rowTokens = readTotalTokens(row, source)
  if (parentCost <= 0 || parentTokens <= 0 || rowTokens <= 0) {
    return 0
  }

  return parentCost * (rowTokens / parentTokens)
}

function normalizeDate(value: string) {
  assertValidIsoCalendarDate(value, 'Invalid ccusage date')
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const directParsed = Date.parse(value)
    if (!Number.isNaN(directParsed)) {
      return new Date(directParsed).toISOString().slice(0, 10)
    }
  }

  const parsed = Date.parse(`${value} UTC`)
  if (Number.isNaN(parsed)) {
    return value
  }

  return new Date(parsed).toISOString().slice(0, 10)
}

function formatDate(value: string, timezone: string) {
  assertValidIsoCalendarDate(value, 'Invalid ccusage date')
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value
  }

  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return normalizeDate(value)
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return normalizeDate(value)
  }

  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = dateFormatter(timezone).formatToParts(new Date(parsed))
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Invalid timezone for ccusage session date: ${timezone}`)
    }
    throw error
  }
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  )
  return `${values.year}-${values.month}-${values.day}`
}

function dateFormatter(timezone: string) {
  const existing = dateFormatterByTimezone.get(timezone)
  if (existing) return existing
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  dateFormatterByTimezone.set(timezone, formatter)
  return formatter
}

function hasTokenMetrics(row: UnknownRecord) {
  return ['inputTokens', 'outputTokens', 'totalTokens'].some((key) => typeof row[key] === 'number')
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}
