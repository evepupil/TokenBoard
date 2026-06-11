import type { UsageSource } from '@tokenboard/usage-core'
import { cacheReadRateFromTotals } from '../../../lib/usage-metrics'
import {
  dailyUsageScopeSql,
  normalizeDeviceFilter,
  optionalDedupedDailyUsageWith,
  tokensWithoutCacheReadSql,
  usageSummaryValue,
  usageTableForDeviceFilter
} from '../deduped-daily-usage'
import { eachIsoDate, roundMetric } from './shared'
import type {
  UsageDetails,
  UsageDetailsDailyRow,
  UsageDetailsInput,
  UsageDetailsModelRow
} from './types'

export async function getUsageDetails(
  db: D1Database,
  input: UsageDetailsInput
): Promise<UsageDetails> {
  const deviceId = normalizeDeviceFilter(input.deviceId)
  const usageTable = usageTableForDeviceFilter(deviceId)
  const dedupedUsageFilter = usageDetailsDedupedFilter(deviceId)
  const usageWith = optionalDedupedDailyUsageWith(deviceId, dedupedUsageFilter)
  const bindings = usageDetailsBindings(input, deviceId)
  const dailySourceRows = await db
    .prepare(
      `
        ${usageWith}
        SELECT
          usage_date as usageDate,
          source,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(${tokensWithoutCacheReadSql()}), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(cost_usd), 0) as costUsd,
          COALESCE(SUM(session_count), 0) as sessionCount
        FROM ${usageTable}
        WHERE user_id = ?
          AND usage_date >= ?
          AND usage_date <= ?
          AND (? = 'all' OR source = ?)
          AND (? = 'all' OR device_id = ?)
          AND (? = '' OR lower(model) LIKE '%' || lower(?) || '%')
        GROUP BY usage_date, source
        ORDER BY usage_date ASC, source ASC
      `
    )
    .bind(...bindings)
    .all<{
      usageDate: string
      source: UsageSource
      totalTokens: number
      totalTokensWithoutCacheRead: number
      costUsd: number
      sessionCount: number
    }>()

  const modelRowsResult = await db
    .prepare(modelRowsSql(usageWith, usageTable))
    .bind(...bindings)
    .all<UsageDetailsModelRow>()

  const modelRows = (modelRowsResult.results ?? []).map((row) => normalizeModelRow(row))
  const dailyRows = buildDailyDetails(
    input.startDate,
    input.endDate,
    (dailySourceRows.results ?? []).map((row) => ({
      usageDate: row.usageDate,
      source: row.source,
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens: Number(row.totalTokens),
        totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
      }),
      costUsd: Number(row.costUsd),
      sessionCount: Number(row.sessionCount)
    })),
    modelRows
  )

  return {
    summary: {
      totalTokens: dailyRows.reduce((total, row) => total + row.totalTokens, 0),
      totalTokensWithoutCacheRead: dailyRows.reduce((total, row) => total + row.totalTokensWithoutCacheRead, 0),
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens: dailyRows.reduce((total, row) => total + row.totalTokens, 0),
        totalTokensWithoutCacheRead: dailyRows.reduce((total, row) => total + row.totalTokensWithoutCacheRead, 0)
      }),
      costUsd: roundMetric(dailyRows.reduce((total, row) => total + row.costUsd, 0)),
      sessionCount: dailyRows.reduce((total, row) => total + row.sessionCount, 0),
      activeDays: dailyRows.filter((row) => row.totalTokens > 0).length
    },
    dailyRows,
    modelRows
  }
}

function usageDetailsDedupedFilter(deviceId: string) {
  if (deviceId !== 'all') return undefined
  return dailyUsageScopeSql({
    userId: usageSummaryValue.bind(),
    usageDateGte: usageSummaryValue.bind(),
    usageDateLte: usageSummaryValue.bind(),
    optionalSource: {
      selector: usageSummaryValue.bind(),
      value: usageSummaryValue.bind()
    },
    modelQuery: {
      selector: usageSummaryValue.bind(),
      value: usageSummaryValue.bind()
    }
  })
}

function usageDetailsBindings(input: UsageDetailsInput, deviceId: string) {
  const outer = [
    input.userId,
    input.startDate,
    input.endDate,
    input.source,
    input.source,
    deviceId,
    deviceId,
    input.modelQuery ?? '',
    input.modelQuery ?? ''
  ]
  if (deviceId !== 'all') return outer
  return [
    input.userId,
    input.startDate,
    input.endDate,
    input.source,
    input.source,
    input.modelQuery ?? '',
    input.modelQuery ?? '',
    ...outer
  ]
}

function modelRowsSql(usageWith: string, usageTable: string) {
  return `
    ${usageWith}
    SELECT
      usage_date as usageDate,
      source,
      model,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
      COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
      COALESCE(SUM(total_tokens), 0) as totalTokens,
      COALESCE(SUM(${tokensWithoutCacheReadSql()}), 0) as totalTokensWithoutCacheRead,
      COALESCE(SUM(cost_usd), 0) as costUsd,
      COALESCE(SUM(session_count), 0) as sessionCount
    FROM ${usageTable}
    WHERE user_id = ?
      AND usage_date >= ?
      AND usage_date <= ?
      AND (? = 'all' OR source = ?)
      AND (? = 'all' OR device_id = ?)
      AND (? = '' OR lower(model) LIKE '%' || lower(?) || '%')
    GROUP BY usage_date, source, model
    ORDER BY usage_date DESC, totalTokens DESC, model ASC
  `
}

function normalizeModelRow(row: UsageDetailsModelRow): UsageDetailsModelRow {
  return {
    usageDate: row.usageDate,
    source: row.source,
    model: row.model,
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheCreationTokens: Number(row.cacheCreationTokens),
    cacheReadTokens: Number(row.cacheReadTokens),
    totalTokens: Number(row.totalTokens),
    totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
    cacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
    }),
    costUsd: Number(row.costUsd),
    sessionCount: Number(row.sessionCount)
  }
}

function buildDailyDetails(
  startDate: string,
  endDate: string,
  rows: Array<{
    usageDate: string
    source: UsageSource
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
    costUsd: number
    sessionCount: number
  }>,
  modelRows: UsageDetailsModelRow[]
) {
  const byDate = new Map<string, UsageDetailsDailyRow>()

  for (const usageDate of eachIsoDate(startDate, endDate)) {
    byDate.set(usageDate, {
      usageDate,
      totalTokens: 0,
      totalTokensWithoutCacheRead: 0,
      cacheReadRate: 0,
      costUsd: 0,
      sessionCount: 0,
      sourceSplit: [],
      modelRows: []
    })
  }

  for (const row of rows) {
    const daily = byDate.get(row.usageDate)
    if (!daily) continue

    daily.totalTokens += row.totalTokens
    daily.totalTokensWithoutCacheRead += row.totalTokensWithoutCacheRead
    daily.cacheReadRate = cacheReadRateFromTotals({
      totalTokens: daily.totalTokens,
      totalTokensWithoutCacheRead: daily.totalTokensWithoutCacheRead
    })
    daily.costUsd = roundMetric(daily.costUsd + row.costUsd)
    daily.sessionCount += row.sessionCount
    daily.sourceSplit.push({
      source: row.source,
      totalTokens: row.totalTokens,
      totalTokensWithoutCacheRead: row.totalTokensWithoutCacheRead,
      cacheReadRate: row.cacheReadRate
    })
  }

  for (const row of modelRows) {
    byDate.get(row.usageDate)?.modelRows.push(row)
  }

  return [...byDate.values()]
}
