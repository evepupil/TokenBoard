import type { UsageSource } from '@tokenboard/usage-core'
import { cacheReadRateFromTotals } from '../../../lib/usage-metrics'

export function parseSourceSplit(value: unknown) {
  return parseJsonRows(value, 'sourceSplit').map((row) => {
    const source = readString(row, 'sourceSplit.source')
    const totalTokens = readNumber(row, 'sourceSplit.totalTokens')
    const totalTokensWithoutCacheRead = readNumber(row, 'sourceSplit.totalTokensWithoutCacheRead')
    return {
      source: source as UsageSource,
      totalTokens,
      totalTokensWithoutCacheRead,
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens,
        totalTokensWithoutCacheRead
      })
    }
  })
}

export function parseTopModels(value: unknown) {
  return parseJsonRows(value, 'topModels').map((row) => {
    const totalTokens = readNumber(row, 'topModels.totalTokens')
    const totalTokensWithoutCacheRead = readNumber(row, 'topModels.totalTokensWithoutCacheRead')
    return {
      model: readString(row, 'topModels.model'),
      totalTokens,
      totalTokensWithoutCacheRead,
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens,
        totalTokensWithoutCacheRead
      }),
      costUsd: readNumber(row, 'topModels.costUsd')
    }
  })
}

function parseJsonRows(value: unknown, column: string) {
  if (!value) return []
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`Invalid public usage ${column}`)
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid public usage ${column}`)
  }
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid public usage ${column}`)
    }
    return item as Record<string, unknown>
  })
}

function readString(row: Record<string, unknown>, column: string) {
  const value = row[column.slice(column.lastIndexOf('.') + 1)]
  if (typeof value !== 'string') {
    throw new Error(`Invalid public usage ${column}`)
  }
  return value
}

function readNumber(row: Record<string, unknown>, column: string) {
  const value = Number(row[column.slice(column.lastIndexOf('.') + 1)] ?? 0)
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid public usage ${column}`)
  }
  return value
}
