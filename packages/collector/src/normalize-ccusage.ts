import { usageSnapshotSchema, type UsageSnapshot, type UsageSource } from '@tokenboard/usage-core'

type NormalizeOptions = {
  source: UsageSource
  timezone: string
  collectedAt?: string
  sessions?: unknown
}

type UnknownRecord = Record<string, unknown>
type SessionCountState = {
  provided: boolean
  counts: Map<string, number>
}

export function normalizeCcusageDailyJson(input: unknown, options: NormalizeOptions): UsageSnapshot[] {
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const sessionCounts = getSessionCounts(options.sessions, options.timezone)

  return extractDailyRows(input).flatMap((row) =>
    extractModelRows(row).map(({ model, metrics, parent }) =>
      usageSnapshotSchema.parse({
        source: options.source,
        usageDate: readDate(row),
        timezone: options.timezone,
        model,
        inputTokens: readNumber(metrics, ['inputTokens']),
        outputTokens: readNumber(metrics, ['outputTokens']),
        cacheCreationTokens: readNumber(metrics, [
          'cacheCreationTokens',
          'cacheCreationInputTokens',
          'inputCacheCreationTokens'
        ]),
        cacheReadTokens: readNumber(metrics, [
          'cacheReadTokens',
          'cacheReadInputTokens',
          'cachedInputTokens'
        ]),
        totalTokens: readTotalTokens(metrics),
        costUsd: readCostUsd(metrics, parent),
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
}

function getSessionCounts(input: unknown, timezone: string) {
  const counts = new Map<string, number>()

  for (const row of extractDailyRows(input)) {
    const date = readSessionDate(row, timezone)
    if (!date) continue

    const model = readSessionCountModel(row)
    const key = sessionCountKey(date, model)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return {
    provided: input !== undefined,
    counts
  }
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

function readSessionCountModel(row: UnknownRecord) {
  const rows = extractModelRows(row)
  const first = rows[0] ?? { model: readModel(row), metrics: row, parent: row }
  return rows.slice(1).reduce((selected, candidate) =>
    readTotalTokens(candidate.metrics) > readTotalTokens(selected.metrics)
      ? candidate
      : selected
  , first).model
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

function readTotalTokens(row: UnknownRecord) {
  const explicitTotal = readNumber(row, ['totalTokens'])
  if (explicitTotal > 0) {
    return explicitTotal
  }

  return (
    readNumber(row, ['inputTokens']) +
    readNumber(row, ['outputTokens']) +
    readNumber(row, ['cacheCreationTokens', 'cacheCreationInputTokens', 'inputCacheCreationTokens']) +
    readNumber(row, ['cacheReadTokens', 'cacheReadInputTokens', 'cachedInputTokens'])
  )
}

function readNumber(row: UnknownRecord, keys: string[]) {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }

  return 0
}

function readCostUsd(row: UnknownRecord, parent: UnknownRecord) {
  const directCost = readNumber(row, ['costUsd', 'costUSD', 'totalCost', 'cost'])
  if (directCost > 0) {
    return directCost
  }

  if (row === parent) {
    return directCost
  }

  const parentCost = readNumber(parent, ['costUsd', 'costUSD', 'totalCost', 'cost'])
  const parentTokens = readNumber(parent, ['totalTokens'])
  const rowTokens = readTotalTokens(row)
  if (parentCost <= 0 || parentTokens <= 0 || rowTokens <= 0) {
    return 0
  }

  return parentCost * (rowTokens / parentTokens)
}

function normalizeDate(value: string) {
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
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(parsed))
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Invalid timezone for ccusage session date: ${timezone}`)
    }
    throw error
  }
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function hasTokenMetrics(row: UnknownRecord) {
  return ['inputTokens', 'outputTokens', 'totalTokens'].some((key) => typeof row[key] === 'number')
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}
