import type { UsageSource } from '@tokenboard/usage-core'
import { cacheReadRateFromTotals } from '../../../lib/usage-metrics'
import {
  effectiveDailyUsageSummaryWith,
  usageSummaryParam,
  usageSummaryScopeSql
} from '../deduped-daily-usage'
import type { UsageSummary, UsageSummaryInput } from './types'

type SummaryRow = {
  todayTokens: number | null
  todayTokensWithoutCacheRead: number | null
  todayCostUsd: number | null
  monthTokens: number | null
  monthTokensWithoutCacheRead: number | null
  monthCostUsd: number | null
  lastSyncedAt: string | null
  deviceCount: number | null
  sourceSplit: unknown
}

export async function getUsageSummary(
  db: D1Database,
  input: UsageSummaryInput
): Promise<UsageSummary> {
  const summary = await db
    .prepare(
      `
        WITH params(user_id, today, month_start) AS (SELECT ?, ?, ?),
        ${effectiveDailyUsageSummaryWith({
          filter: usageSummaryScopeSql({
            userId: usageSummaryParam('userId'),
            usageDateGte: usageSummaryParam('monthStart')
          }),
          summaryStrict: input.summaryStrict
        })},
        month_usage AS (
          SELECT
            effective_daily_usage_summary.*
          FROM effective_daily_usage_summary
          JOIN params ON params.user_id = effective_daily_usage_summary.user_id
        ),
        source_usage AS (
          SELECT
            source,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(total_tokens_without_cache_read), 0) as total_tokens_without_cache_read
          FROM month_usage
          GROUP BY source
        ),
        device_stats AS (
          SELECT
            devices.user_id,
            MAX(devices.last_synced_at) as lastSyncedAt,
            COUNT(*) as deviceCount
          FROM devices
          GROUP BY devices.user_id
        )
        SELECT
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.total_tokens ELSE 0 END), 0) as todayTokens,
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.total_tokens_without_cache_read ELSE 0 END), 0) as todayTokensWithoutCacheRead,
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.cost_usd ELSE 0 END), 0) as todayCostUsd,
          COALESCE(SUM(month_usage.total_tokens), 0) as monthTokens,
          COALESCE(SUM(month_usage.total_tokens_without_cache_read), 0) as monthTokensWithoutCacheRead,
          COALESCE(SUM(month_usage.cost_usd), 0) as monthCostUsd,
          device_stats.lastSyncedAt as lastSyncedAt,
          COALESCE(device_stats.deviceCount, 0) as deviceCount,
          (
            SELECT COALESCE(json_group_array(json_object(
              'source', ordered_sources.source,
              'totalTokens', ordered_sources.total_tokens,
              'totalTokensWithoutCacheRead', ordered_sources.total_tokens_without_cache_read
            )), '[]')
            FROM (
              SELECT
                source,
                total_tokens,
                total_tokens_without_cache_read
              FROM source_usage
              ORDER BY total_tokens_without_cache_read DESC, total_tokens DESC
            ) AS ordered_sources
          ) as sourceSplit
        FROM params
        LEFT JOIN month_usage ON month_usage.user_id = params.user_id
        LEFT JOIN device_stats ON device_stats.user_id = params.user_id
      `
    )
    .bind(input.userId, input.today, input.monthStart)
    .first<SummaryRow>()
  const sourceSplit = parseSummarySourceSplit(summary?.sourceSplit)

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
    sourceSplit: sourceSplit.map((row) => ({
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

function parseSummarySourceSplit(value: unknown) {
  if (!value) return []
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid dashboard summary sourceSplit')
  }
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid dashboard summary sourceSplit item')
    }
    const row = item as Record<string, unknown>
    if (typeof row.source !== 'string') throw new Error('Invalid dashboard summary sourceSplit source')
    return {
      source: row.source as UsageSource,
      totalTokens: Number(row.totalTokens ?? 0),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead ?? 0)
    }
  })
}
