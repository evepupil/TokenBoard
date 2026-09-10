import { cacheReadRateFromTotals } from '../../lib/usage-metrics'
import { costUnavailableSourcesSql } from '../../lib/usage-cost'
import { effectiveDailyUsageSummaryWith, usageSummaryScopeSql, usageSummaryValue } from '../usage/deduped-daily-usage'
import type { DailyTokenReport } from './adapters'

type ReportTotalsRow = {
  totalTokens: number | null
  totalTokensWithoutCacheRead: number | null
  costUsd: number | null
  sessionCount: number | null
  sourceSplit: unknown
  topModels: unknown
}

export async function getDailyTokenReport(input: {
  db: D1Database
  userId: string
  displayName: string
  reportDate: string
  timezone: string
  dashboardUrl: string
  summaryStrict?: boolean
}): Promise<DailyTokenReport> {
  const totals = await readReportTotals(input)
  const sourceSplit = parseReportArray(totals?.sourceSplit, 'sourceSplit', parseSourceSplitItem)
  const topModels = parseReportArray(totals?.topModels, 'topModels', parseTopModelItem)

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
    sourceSplit: sourceSplit.map((row) => ({
      source: row.source,
      totalTokens: row.totalTokens,
      totalTokensWithoutCacheRead: row.totalTokensWithoutCacheRead,
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens: row.totalTokens,
        totalTokensWithoutCacheRead: row.totalTokensWithoutCacheRead
      })
    })),
    topModels: topModels.map((row) => ({
      model: row.model,
      totalTokens: row.totalTokens,
      totalTokensWithoutCacheRead: row.totalTokensWithoutCacheRead,
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens: row.totalTokens,
        totalTokensWithoutCacheRead: row.totalTokensWithoutCacheRead
      }),
      costUsd: row.costUsd,
      sourceSplit: row.sourceSplit
    }))
  }
}

function readReportTotals(input: { db: D1Database; userId: string; reportDate: string; summaryStrict?: boolean }) {
  return input.db
    .prepare(
      `
        WITH ${effectiveDailyUsageSummaryWith({
          filter: usageSummaryScopeSql({
            userId: usageSummaryValue.bind(),
            usageDate: usageSummaryValue.bind()
          }),
          summaryStrict: input.summaryStrict
        })},
        aggregate_usage AS (
          SELECT
            source,
            model,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(total_tokens_without_cache_read), 0) as total_tokens_without_cache_read,
            COALESCE(SUM(CASE
              WHEN source IN (${costUnavailableSourcesSql}) THEN 0
              ELSE cost_usd
            END), 0) as cost_usd,
            COALESCE(SUM(session_count), 0) as session_count
          FROM effective_daily_usage_summary
          GROUP BY source, model
        ),
        source_usage AS (
          SELECT
            source,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(total_tokens_without_cache_read), 0) as total_tokens_without_cache_read
          FROM aggregate_usage
          GROUP BY source
        ),
        model_usage AS (
          SELECT
            model_totals.model,
            model_totals.total_tokens,
            model_totals.total_tokens_without_cache_read,
            model_totals.cost_usd,
            (
              SELECT json_group_array(json_object('source', ordered_model_sources.source))
              FROM (
                SELECT source
                FROM aggregate_usage AS model_sources
                WHERE model_sources.model = model_totals.model
                ORDER BY source ASC
              ) AS ordered_model_sources
            ) as source_split
          FROM (
            SELECT
              model,
              COALESCE(SUM(total_tokens), 0) as total_tokens,
              COALESCE(SUM(total_tokens_without_cache_read), 0) as total_tokens_without_cache_read,
              COALESCE(SUM(cost_usd), 0) as cost_usd
            FROM aggregate_usage
            GROUP BY model
          ) AS model_totals
        )
        SELECT
          COALESCE(SUM(aggregate_usage.total_tokens), 0) as totalTokens,
          COALESCE(SUM(aggregate_usage.total_tokens_without_cache_read), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(aggregate_usage.cost_usd), 0) as costUsd,
          COALESCE(SUM(aggregate_usage.session_count), 0) as sessionCount,
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
          ) as sourceSplit,
          (
            SELECT COALESCE(json_group_array(json_object(
              'model', ordered_models.model,
              'totalTokens', ordered_models.total_tokens,
              'totalTokensWithoutCacheRead', ordered_models.total_tokens_without_cache_read,
              'costUsd', ordered_models.cost_usd,
              'sourceSplit', json(ordered_models.source_split)
            )), '[]')
            FROM (
              SELECT
                model,
                total_tokens,
                total_tokens_without_cache_read,
                cost_usd,
                source_split
              FROM model_usage
              ORDER BY total_tokens_without_cache_read DESC, total_tokens DESC
              LIMIT 5
            ) AS ordered_models
          ) as topModels
        FROM aggregate_usage
      `
    )
    .bind(...reportBindings(input))
    .first<ReportTotalsRow>()
}

function reportBindings(input: { userId: string; reportDate: string; summaryStrict?: boolean }) {
  return input.summaryStrict
    ? [input.userId, input.reportDate]
    : [input.userId, input.reportDate, input.userId, input.reportDate]
}

function parseReportArray<T>(value: unknown, column: string, parseItem: (value: unknown, column: string) => T) {
  if (!value) return []
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`Invalid daily token report ${column}`)
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid daily token report ${column}`)
  }
  return parsed.map((item) => parseItem(item, column))
}

function parseSourceSplitItem(value: unknown, column: string) {
  const item = reportRecord(value, column)
  return {
    source: reportString(item.source, column),
    totalTokens: reportNumber(item.totalTokens, column),
    totalTokensWithoutCacheRead: reportNumber(item.totalTokensWithoutCacheRead, column)
  }
}

function parseTopModelItem(value: unknown, column: string) {
  const item = reportRecord(value, column)
  return {
    model: reportString(item.model, column),
    totalTokens: reportNumber(item.totalTokens, column),
    totalTokensWithoutCacheRead: reportNumber(item.totalTokensWithoutCacheRead, column),
    costUsd: reportNumber(item.costUsd, column),
    sourceSplit: reportModelSourceSplit(item.sourceSplit, column)
  }
}

function reportModelSourceSplit(value: unknown, column: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`Invalid daily token report ${column}`)
  return value.map((source) => ({
    source: reportString(reportRecord(source, column).source, column)
  }))
}

function reportRecord(value: unknown, column: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid daily token report ${column}`)
  }
  return value as Record<string, unknown>
}

function reportString(value: unknown, column: string) {
  if (typeof value !== 'string') {
    throw new Error(`Invalid daily token report ${column}`)
  }
  return value
}

function reportNumber(value: unknown, column: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid daily token report ${column}`)
  }
  return value
}
