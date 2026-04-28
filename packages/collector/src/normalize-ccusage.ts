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
      .map(([model, metrics]) => ({ model, metrics: metrics as UnknownRecord, parent: row }))
  }

  const modelBreakdowns = row.modelBreakdowns
  if (Array.isArray(modelBreakdowns)) {
    return modelBreakdowns.filter(isRecord).map((metrics) => ({
      model: readModel(metrics),
      metrics,
      parent: row
    }))
  }

  if (isRecord(modelBreakdowns)) {
    return Object.entries(modelBreakdowns)
      .filter(([, metrics]) => isRecord(metrics))
      .map(([model, metrics]) => ({ model, metrics: metrics as UnknownRecord, parent: row }))
  }

  const models = row.models
  if (isRecord(models) && !Array.isArray(models)) {
    return Object.entries(models)
      .filter(([, metrics]) => isRecord(metrics))
      .map(([model, metrics]) => ({ model, metrics: metrics as UnknownRecord, parent: row }))
  }

  return [{ model: readModel(row), metrics: row, parent: row }]
}

function readDate(row: UnknownRecord) {
  const value = row.date ?? row.usageDate
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

  const parsed = Date.parse(`${value} UTC`)
  if (Number.isNaN(parsed)) {
    return value
  }

  return new Date(parsed).toISOString().slice(0, 10)
}

function hasTokenMetrics(row: UnknownRecord) {
  return ['inputTokens', 'outputTokens', 'totalTokens'].some((key) => typeof row[key] === 'number')
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}
