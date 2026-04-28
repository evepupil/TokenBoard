import { usageSnapshotSchema, type UsageSnapshot, type UsageSource } from '@tokenboard/usage-core'

type NormalizeOptions = {
  source: UsageSource
  timezone: string
  collectedAt?: string
}

type UnknownRecord = Record<string, unknown>

export function normalizeCcusageDailyJson(input: unknown, options: NormalizeOptions): UsageSnapshot[] {
  const collectedAt = options.collectedAt ?? new Date().toISOString()

  return extractDailyRows(input).flatMap((row) =>
    extractModelRows(row).map(({ model, metrics }) =>
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
        costUsd: readNumber(metrics, ['costUsd', 'costUSD', 'totalCost', 'cost']),
        sessionCount: readNumber(metrics, ['sessionCount', 'sessions']),
        collectedAt
      })
    )
  )
}

function extractDailyRows(input: unknown): UnknownRecord[] {
  if (Array.isArray(input)) {
    return input.filter(isRecord)
  }

  if (!isRecord(input)) {
    return []
  }

  for (const key of ['data', 'daily', 'rows', 'items']) {
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
    return Object.entries(breakdown)
      .filter(([, metrics]) => isRecord(metrics))
      .map(([model, metrics]) => ({ model, metrics: metrics as UnknownRecord }))
  }

  const modelBreakdowns = row.modelBreakdowns
  if (Array.isArray(modelBreakdowns)) {
    return modelBreakdowns.filter(isRecord).map((metrics) => ({
      model: readModel(metrics),
      metrics
    }))
  }

  if (isRecord(modelBreakdowns)) {
    return Object.entries(modelBreakdowns)
      .filter(([, metrics]) => isRecord(metrics))
      .map(([model, metrics]) => ({ model, metrics: metrics as UnknownRecord }))
  }

  return [{ model: readModel(row), metrics: row }]
}

function readDate(row: UnknownRecord) {
  const value = row.date ?? row.usageDate
  if (typeof value !== 'string') {
    throw new Error('ccusage row is missing date')
  }
  return value
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

function hasTokenMetrics(row: UnknownRecord) {
  return ['inputTokens', 'outputTokens', 'totalTokens'].some((key) => typeof row[key] === 'number')
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

