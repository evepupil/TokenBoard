import { cacheReadRateFromTotals } from '../../lib/usage-metrics'
import { effectiveDailyUsageSummaryWith } from '../usage/deduped-daily-usage'
import type { DailyTokenReport } from './adapters'

type ReportTotalsRow = {
  totalTokens: number | null
  totalTokensWithoutCacheRead: number | null
  costUsd: number | null
  sessionCount: number | null
}

export async function getDailyTokenReport(input: {
  db: D1Database
  userId: string
  displayName: string
  reportDate: string
  timezone: string
  dashboardUrl: string
}): Promise<DailyTokenReport> {
  const [totals, sourceSplit, topModels] = await Promise.all([
    readReportTotals(input),
    readReportSourceSplit(input),
    readReportTopModels(input)
  ])

  return {
    displayName: input.displayName,
    reportDate: input.reportDate,
    timezone: input.timezone,
    dashboardUrl: input.dashboardUrl,
    totalTokens: Number(totals?.totalTokens ?? 0),
    totalTokensWithoutCacheRead: Number(totals?.totalTokensWithoutCacheRead ?? 0),
    cacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(totals?.totalTokens ?? 0),
      totalTokensWithoutCacheRead: Number(totals?.totalTokensWithoutCacheRead ?? 0)
    }),
    costUsd: Number(totals?.costUsd ?? 0),
    sessionCount: Number(totals?.sessionCount ?? 0),
    sourceSplit: (sourceSplit.results ?? []).map((row) => ({
      source: row.source,
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens: Number(row.totalTokens),
        totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
      })
    })),
    topModels: (topModels.results ?? []).map((row) => ({
      model: row.model,
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens: Number(row.totalTokens),
        totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
      }),
      costUsd: Number(row.costUsd)
    }))
  }
}

function readReportTotals(input: {
  db: D1Database
  userId: string
  reportDate: string
}) {
  return input.db
    .prepare(
      `
        WITH ${effectiveDailyUsageSummaryWith({
          dailyUsageFilter: 'daily_usage.user_id = ? AND daily_usage.usage_date = ?',
          summaryFilter: 'daily_usage_summary.user_id = ? AND daily_usage_summary.usage_date = ?'
        })}
        SELECT
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(total_tokens_without_cache_read), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(cost_usd), 0) as costUsd,
          COALESCE(SUM(session_count), 0) as sessionCount
        FROM effective_daily_usage_summary
      `
    )
    .bind(input.userId, input.reportDate, input.userId, input.reportDate)
    .first<ReportTotalsRow>()
}

function readReportSourceSplit(input: {
  db: D1Database
  userId: string
  reportDate: string
}) {
  return input.db
    .prepare(
      `
        WITH ${effectiveDailyUsageSummaryWith({
          dailyUsageFilter: 'daily_usage.user_id = ? AND daily_usage.usage_date = ?',
          summaryFilter: 'daily_usage_summary.user_id = ? AND daily_usage_summary.usage_date = ?'
        })}
        SELECT
          source,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(total_tokens_without_cache_read), 0) as totalTokensWithoutCacheRead
        FROM effective_daily_usage_summary
        GROUP BY source
        ORDER BY totalTokensWithoutCacheRead DESC, totalTokens DESC
      `
    )
    .bind(input.userId, input.reportDate, input.userId, input.reportDate)
    .all<{ source: string; totalTokens: number; totalTokensWithoutCacheRead: number }>()
}

function readReportTopModels(input: {
  db: D1Database
  userId: string
  reportDate: string
}) {
  return input.db
    .prepare(
      `
        WITH ${effectiveDailyUsageSummaryWith({
          dailyUsageFilter: 'daily_usage.user_id = ? AND daily_usage.usage_date = ?',
          summaryFilter: 'daily_usage_summary.user_id = ? AND daily_usage_summary.usage_date = ?'
        })}
        SELECT
          model,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(total_tokens_without_cache_read), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(cost_usd), 0) as costUsd
        FROM effective_daily_usage_summary
        GROUP BY model
        ORDER BY totalTokensWithoutCacheRead DESC, totalTokens DESC
        LIMIT 5
      `
    )
    .bind(input.userId, input.reportDate, input.userId, input.reportDate)
    .all<{ model: string; totalTokens: number; totalTokensWithoutCacheRead: number; costUsd: number }>()
}
