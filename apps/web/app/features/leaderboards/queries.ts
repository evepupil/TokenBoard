import { cacheReadRateFromTotals } from '../../lib/usage-metrics'
import { billableCostSql, costUnavailableSourcesSql } from '../../lib/usage-cost'
import { effectiveDailyUsageSummaryWith, usageSummaryScopeSql, usageSummaryValue } from '../usage/deduped-daily-usage'

export type LeaderboardEntry = {
  rank: number
  slug: string
  displayName: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
  costAvailable: boolean
}

export type LeaderboardQuery = {
  period: 'daily' | 'monthly'
  metric: 'tokens' | 'tokens-without-cache-read' | 'cost'
  startDate: string
  endDateExclusive: string
  limit?: number
  summaryStrict?: boolean
}

export async function listDailyLeaderboard(db: D1Database, usageDate: string, limit = 50): Promise<LeaderboardEntry[]> {
  return listLeaderboard(db, {
    period: 'daily',
    metric: 'tokens',
    startDate: usageDate,
    endDateExclusive: nextIsoDate(usageDate),
    limit
  })
}

export async function listLeaderboard(db: D1Database, input: LeaderboardQuery): Promise<LeaderboardEntry[]> {
  const orderBy = leaderboardOrderBy(input.metric)

  const rows = await db
    .prepare(
      `
        WITH ${effectiveDailyUsageSummaryWith({
          filter: usageSummaryScopeSql({
            usageDateGte: usageSummaryValue.bind(),
            usageDateLt: usageSummaryValue.bind()
          }),
          summaryStrict: input.summaryStrict
        })}
        SELECT
          profiles.slug as slug,
          profiles.display_name as displayName,
          COALESCE(SUM(effective_daily_usage_summary.total_tokens), 0) as totalTokens,
          COALESCE(SUM(effective_daily_usage_summary.total_tokens_without_cache_read), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(${billableCostSql({
            sourceColumn: 'effective_daily_usage_summary.source',
            costColumn: 'effective_daily_usage_summary.cost_usd'
          })}), 0) as costUsd,
          COALESCE(MIN(CASE
            WHEN effective_daily_usage_summary.source IN (${costUnavailableSourcesSql}) THEN 0
            ELSE 1
          END), 1) as costAvailable
        FROM profiles
        JOIN effective_daily_usage_summary ON effective_daily_usage_summary.user_id = profiles.user_id
        WHERE profiles.is_public = 1
          AND profiles.participates_in_leaderboards = 1
        GROUP BY profiles.user_id, profiles.slug, profiles.display_name
        ${orderBy}
        LIMIT ?
      `
    )
    .bind(...leaderboardBindings(input))
    .all<Omit<LeaderboardEntry, 'rank'>>()

  return (rows.results ?? []).map((row, index) => ({
    rank: index + 1,
    slug: row.slug,
    displayName: row.displayName,
    totalTokens: Number(row.totalTokens),
    totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
    cacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
    }),
    costUsd: Number(row.costUsd),
    costAvailable: Number(row.costAvailable) !== 0
  }))
}

function leaderboardBindings(input: LeaderboardQuery) {
  return input.summaryStrict
    ? [input.startDate, input.endDateExclusive, input.limit ?? 50]
    : [input.startDate, input.endDateExclusive, input.startDate, input.endDateExclusive, input.limit ?? 50]
}

function leaderboardOrderBy(metric: LeaderboardQuery['metric']) {
  if (metric === 'cost') return 'ORDER BY costUsd DESC, totalTokens DESC'
  if (metric === 'tokens-without-cache-read') {
    return 'ORDER BY totalTokensWithoutCacheRead DESC, totalTokens DESC, costUsd DESC'
  }
  return 'ORDER BY totalTokens DESC, costUsd DESC'
}

function nextIsoDate(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}
