import type { UsageSource } from '@tokenboard/usage-core'
import {
  dedupedDailyUsageCte,
  normalizeDeviceFilter,
  optionalDedupedDailyUsageWith,
  usageTableForDeviceFilter
} from './deduped-daily-usage'
import { cacheReadRateFromTotals } from '../../lib/usage-metrics'

export type UsageSummaryInput = {
  userId: string
  today: string
  monthStart: string
}

export type UsageSummary = {
  todayTokens: number
  todayTokensWithoutCacheRead: number
  todayCacheReadRate: number
  todayCostUsd: number
  monthTokens: number
  monthTokensWithoutCacheRead: number
  monthCacheReadRate: number
  monthCostUsd: number
  lastSyncedAt: string | null
  deviceCount: number
  sourceSplit: Array<{
    source: UsageSource
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
  }>
}

export type DailyUsageTrendInput = {
  userId: string
  startDate: string
  endDate: string
}

export type DailyUsageTrendItem = {
  usageDate: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
}

export type UsageDetailsInput = {
  userId: string
  startDate: string
  endDate: string
  source: UsageSource | 'all'
  deviceId?: string
  modelQuery?: string
}

export type UsageDetailsDailyRow = {
  usageDate: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
  sessionCount: number
  sourceSplit: Array<{
    source: UsageSource
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
  }>
  modelRows: UsageDetailsModelRow[]
}

export type UsageDetailsModelRow = {
  usageDate: string
  source: UsageSource
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
  sessionCount: number
}

export type UsageDetails = {
  summary: {
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
    costUsd: number
    sessionCount: number
    activeDays: number
  }
  dailyRows: UsageDetailsDailyRow[]
  modelRows: UsageDetailsModelRow[]
}

type SummaryRow = {
  todayTokens: number | null
  todayTokensWithoutCacheRead: number | null
  todayCostUsd: number | null
  monthTokens: number | null
  monthTokensWithoutCacheRead: number | null
  monthCostUsd: number | null
  lastSyncedAt: string | null
  deviceCount: number | null
}

export async function getUsageSummary(
  db: D1Database,
  input: UsageSummaryInput
): Promise<UsageSummary> {
  const summary = await db
    .prepare(
      `
        WITH ${dedupedDailyUsageCte},
        params(user_id, today, month_start) AS (SELECT ?, ?, ?),
        device_stats AS (
          SELECT
            devices.user_id,
            MAX(devices.last_synced_at) as lastSyncedAt,
            COUNT(*) as deviceCount
          FROM devices
          GROUP BY devices.user_id
        )
        SELECT
          COALESCE(SUM(CASE WHEN deduped_daily_usage.usage_date = params.today THEN deduped_daily_usage.total_tokens ELSE 0 END), 0) as todayTokens,
          COALESCE(SUM(CASE WHEN deduped_daily_usage.usage_date = params.today THEN deduped_daily_usage.input_tokens + deduped_daily_usage.output_tokens + deduped_daily_usage.cache_creation_tokens ELSE 0 END), 0) as todayTokensWithoutCacheRead,
          COALESCE(SUM(CASE WHEN deduped_daily_usage.usage_date = params.today THEN deduped_daily_usage.cost_usd ELSE 0 END), 0) as todayCostUsd,
          COALESCE(SUM(CASE WHEN deduped_daily_usage.usage_date >= params.month_start THEN deduped_daily_usage.total_tokens ELSE 0 END), 0) as monthTokens,
          COALESCE(SUM(CASE WHEN deduped_daily_usage.usage_date >= params.month_start THEN deduped_daily_usage.input_tokens + deduped_daily_usage.output_tokens + deduped_daily_usage.cache_creation_tokens ELSE 0 END), 0) as monthTokensWithoutCacheRead,
          COALESCE(SUM(CASE WHEN deduped_daily_usage.usage_date >= params.month_start THEN deduped_daily_usage.cost_usd ELSE 0 END), 0) as monthCostUsd,
          device_stats.lastSyncedAt as lastSyncedAt,
          COALESCE(device_stats.deviceCount, 0) as deviceCount
        FROM params
        LEFT JOIN deduped_daily_usage ON deduped_daily_usage.user_id = params.user_id
        LEFT JOIN device_stats ON device_stats.user_id = params.user_id
      `
    )
    .bind(input.userId, input.today, input.monthStart)
    .first<SummaryRow>()

  const split = await db
    .prepare(
      `
        WITH ${dedupedDailyUsageCte}
        SELECT
          source,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens), 0) as totalTokensWithoutCacheRead
        FROM deduped_daily_usage
        WHERE user_id = ?
          AND usage_date >= ?
        GROUP BY source
        ORDER BY totalTokensWithoutCacheRead DESC, totalTokens DESC
      `
    )
    .bind(input.userId, input.monthStart)
    .all<{ source: UsageSource; totalTokens: number; totalTokensWithoutCacheRead: number }>()

  return {
    todayTokens: Number(summary?.todayTokens ?? 0),
    todayTokensWithoutCacheRead: Number(summary?.todayTokensWithoutCacheRead ?? 0),
    todayCacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(summary?.todayTokens ?? 0),
      totalTokensWithoutCacheRead: Number(summary?.todayTokensWithoutCacheRead ?? 0)
    }),
    todayCostUsd: Number(summary?.todayCostUsd ?? 0),
    monthTokens: Number(summary?.monthTokens ?? 0),
    monthTokensWithoutCacheRead: Number(summary?.monthTokensWithoutCacheRead ?? 0),
    monthCacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(summary?.monthTokens ?? 0),
      totalTokensWithoutCacheRead: Number(summary?.monthTokensWithoutCacheRead ?? 0)
    }),
    monthCostUsd: Number(summary?.monthCostUsd ?? 0),
    lastSyncedAt: summary?.lastSyncedAt ?? null,
    deviceCount: Number(summary?.deviceCount ?? 0),
    sourceSplit: (split.results ?? []).map((row) => ({
      source: row.source,
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens: Number(row.totalTokens),
        totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
      })
    }))
  }
}

export async function getDailyUsageTrend(
  db: D1Database,
  input: DailyUsageTrendInput
): Promise<DailyUsageTrendItem[]> {
  const rows = await db
    .prepare(
      `
        WITH ${dedupedDailyUsageCte}
        SELECT
          usage_date as usageDate,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(cost_usd), 0) as costUsd
        FROM deduped_daily_usage
        WHERE user_id = ?
          AND usage_date >= ?
          AND usage_date <= ?
        GROUP BY usage_date
        ORDER BY usage_date ASC
      `
    )
    .bind(input.userId, input.startDate, input.endDate)
    .all<DailyUsageTrendItem>()

  const byDate = new Map(
    (rows.results ?? []).map((row) => [
      row.usageDate,
      {
        usageDate: row.usageDate,
        totalTokens: Number(row.totalTokens),
        totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
        cacheReadRate: cacheReadRateFromTotals({
          totalTokens: Number(row.totalTokens),
          totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
        }),
        costUsd: Number(row.costUsd)
      }
    ])
  )

  return eachIsoDate(input.startDate, input.endDate).map(
    (usageDate) => byDate.get(usageDate) ?? {
      usageDate,
      totalTokens: 0,
      totalTokensWithoutCacheRead: 0,
      cacheReadRate: 0,
      costUsd: 0
    }
  )
}

export async function getUsageDetails(
  db: D1Database,
  input: UsageDetailsInput
): Promise<UsageDetails> {
  const deviceId = normalizeDeviceFilter(input.deviceId)
  const usageTable = usageTableForDeviceFilter(deviceId)
  const usageWith = optionalDedupedDailyUsageWith(deviceId)
  const dailySourceRows = await db
    .prepare(
      `
        ${usageWith}
        SELECT
          usage_date as usageDate,
          source,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens), 0) as totalTokensWithoutCacheRead,
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
    .bind(
      input.userId,
      input.startDate,
      input.endDate,
      input.source,
      input.source,
      deviceId,
      deviceId,
      input.modelQuery ?? '',
      input.modelQuery ?? ''
    )
    .all<{
      usageDate: string
      source: UsageSource
      totalTokens: number
      totalTokensWithoutCacheRead: number
      costUsd: number
      sessionCount: number
    }>()

  const modelRowsResult = await db
    .prepare(
      `
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
          COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens), 0) as totalTokensWithoutCacheRead,
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
    )
    .bind(
      input.userId,
      input.startDate,
      input.endDate,
      input.source,
      input.source,
      deviceId,
      deviceId,
      input.modelQuery ?? '',
      input.modelQuery ?? ''
    )
    .all<UsageDetailsModelRow>()

  const modelRows = (modelRowsResult.results ?? []).map((row) => ({
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
  }))
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

function eachIsoDate(startDate: string, endDate: string) {
  const dates: string[] = []
  const current = new Date(`${startDate}T00:00:00.000Z`)
  const end = new Date(`${endDate}T00:00:00.000Z`)

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return dates
}

function roundMetric(value: number) {
  return Math.round(value * 10000) / 10000
}
