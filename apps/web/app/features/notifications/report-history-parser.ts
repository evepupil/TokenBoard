import type { DailyTokenReport } from './adapters'

export function parseReportHistorySourceSplit(value: string) {
  return parseHistoryArray(value, 'source_split', parseSourceSplitItem)
}

export function parseReportHistoryTopModels(value: string) {
  return parseHistoryArray(value, 'top_models', parseTopModelItem)
}

function parseHistoryArray<T>(
  value: string,
  column: string,
  parseItem: (value: unknown, column: string) => T
) {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error(`Invalid daily report history ${column}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid daily report history ${column}`)
  }
  return parsed.map((item) => parseItem(item, column))
}

function parseSourceSplitItem(value: unknown, column: string): DailyTokenReport['sourceSplit'][number] {
  const item = historyRecord(value, column)
  return {
    source: historyString(item.source, column),
    totalTokens: historyNumber(item.totalTokens, column),
    totalTokensWithoutCacheRead: historyNumber(item.totalTokensWithoutCacheRead, column),
    cacheReadRate: optionalHistoryNumber(item.cacheReadRate, column)
  }
}

function parseTopModelItem(value: unknown, column: string): DailyTokenReport['topModels'][number] {
  const item = historyRecord(value, column)
  return {
    model: historyString(item.model, column),
    totalTokens: historyNumber(item.totalTokens, column),
    totalTokensWithoutCacheRead: historyNumber(item.totalTokensWithoutCacheRead, column),
    cacheReadRate: optionalHistoryNumber(item.cacheReadRate, column),
    costUsd: historyNumber(item.costUsd, column)
  }
}

function historyRecord(value: unknown, column: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid daily report history ${column}`)
  }
  return value as Record<string, unknown>
}

function historyString(value: unknown, column: string) {
  if (typeof value !== 'string') {
    throw new Error(`Invalid daily report history ${column}`)
  }
  return value
}

function historyNumber(value: unknown, column: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid daily report history ${column}`)
  }
  return value
}

function optionalHistoryNumber(value: unknown, column: string) {
  if (value === undefined) return undefined
  return historyNumber(value, column)
}
