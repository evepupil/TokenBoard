import { cacheReadRateFromTotals } from '../../lib/usage-metrics'
import { billableCostSql, costUnavailableSourcesSql } from '../../lib/usage-cost'
import { effectiveDailyUsageSummaryWith, usageSummaryScopeSql, usageSummaryValue } from '../usage/deduped-daily-usage'

export type LeaderboardSourceBreakdown = {
  /** The stable usage source id, not a display label; the UI formats it. */
  source: string
  /** This source's share of the user's ranked-window total tokens, `0`–`1`. */
  share: number
}

export type LeaderboardEntry = {
  rank: number
  slug: string
  displayName: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
  costAvailable: boolean
  /** The model with the most total tokens in the ranked window, or `null` when there is none. */
  primaryModel: string | null
  /** Every source the user ranked with, ordered by share, the largest first. */
  sourceBreakdown: LeaderboardSourceBreakdown[]
  /**
   * Whether this row belongs to the signed-in viewer. Resolved inside SQL and carried as a
   * boolean, so a viewer's own `user_id` never reaches the response — the board is public and
   * the highlight is the only thing the viewer needs back.
   */
  isCurrentViewer: boolean
}

export type LeaderboardQuery = {
  period: 'daily' | 'monthly'
  metric: 'tokens' | 'tokens-without-cache-read' | 'cost'
  startDate: string
  endDateExclusive: string
  limit?: number
  summaryStrict?: boolean
  /** The signed-in viewer, so their own row can be flagged; `null`/omitted means nobody. */
  viewerUserId?: string | null
}

type LeaderboardRow = {
  slug: string
  displayName: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  costUsd: number
  costAvailable: number
  isCurrentViewer: number
  primaryModel: string | null
  sourceTokens: string | null
}

export async function listLeaderboard(db: D1Database, input: LeaderboardQuery): Promise<LeaderboardEntry[]> {
  const orderBy = leaderboardOrderBy(input.metric)
  // The per-user detail the board shows beside each total — the model they used most and how
  // their tokens split across sources — is computed by the same statement, in CTEs joined once
  // each. Selecting it through correlated subqueries instead would re-aggregate the window for
  // every candidate row the `ORDER BY` sorts, so a busy month would pay for the whole summary
  // table once per public user rather than once per request.
  //
  // Token totals use SQLite's `total()`, never `SUM()`. `SUM()` accumulates integers and throws
  // "integer overflow" once a window exceeds int64; the per-row cap (1e12) makes that ~9.2M rows
  // for one public account, which an uploader can create on purpose — and the failure would blank
  // the board for every other viewer, not just the account that caused it. `total()` accumulates
  // in floating point, the same precision the D1 driver hands back as a JS number anyway, so no
  // displayed total loses information it would otherwise have kept. Costs stay on `SUM()`: the
  // column is REAL, which never takes the integer path.
  const viewerUserId = input.viewerUserId ?? null

  const rows = await db
    .prepare(
      `
        WITH ${effectiveDailyUsageSummaryWith({
          filter: usageSummaryScopeSql({
            usageDateGte: usageSummaryValue.bind(),
            usageDateLt: usageSummaryValue.bind()
          }),
          summaryStrict: input.summaryStrict
        })},
        user_primary_model AS (
          SELECT user_id, model
          FROM (
            SELECT
              user_id,
              model,
              ROW_NUMBER() OVER (
                PARTITION BY user_id
                ORDER BY COALESCE(total(total_tokens), 0) DESC, model ASC
              ) as primaryModelRank
            FROM effective_daily_usage_summary
            GROUP BY user_id, model
          )
          WHERE primaryModelRank = 1
        ),
        user_source_tokens AS (
          SELECT
            user_id,
            COALESCE(json_group_array(json_object(
              'source', source,
              'totalTokens', total_tokens
            )), '[]') as sourceTokens
          FROM (
            SELECT user_id, source, COALESCE(total(total_tokens), 0) as total_tokens
            FROM effective_daily_usage_summary
            GROUP BY user_id, source
          )
          GROUP BY user_id
        )
        SELECT
          profiles.slug as slug,
          profiles.display_name as displayName,
          COALESCE(total(effective_daily_usage_summary.total_tokens), 0) as totalTokens,
          COALESCE(total(effective_daily_usage_summary.total_tokens_without_cache_read), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(${billableCostSql({
            sourceColumn: 'effective_daily_usage_summary.source',
            costColumn: 'effective_daily_usage_summary.cost_usd'
          })}), 0) as costUsd,
          COALESCE(MIN(CASE
            WHEN effective_daily_usage_summary.source IN (${costUnavailableSourcesSql}) THEN 0
            ELSE 1
          END), 1) as costAvailable,
          CASE WHEN profiles.user_id = ? THEN 1 ELSE 0 END as isCurrentViewer,
          user_primary_model.model as primaryModel,
          user_source_tokens.sourceTokens as sourceTokens
        FROM profiles
        JOIN effective_daily_usage_summary ON effective_daily_usage_summary.user_id = profiles.user_id
        LEFT JOIN user_primary_model ON user_primary_model.user_id = profiles.user_id
        LEFT JOIN user_source_tokens ON user_source_tokens.user_id = profiles.user_id
        WHERE profiles.is_public = 1
          AND profiles.participates_in_leaderboards = 1
        GROUP BY profiles.user_id, profiles.slug, profiles.display_name, user_primary_model.model, user_source_tokens.sourceTokens
        ${orderBy}
        LIMIT ?
      `
    )
    .bind(...leaderboardBindings(input))
    .all<LeaderboardRow>()

  return (rows.results ?? []).map((row, index) => {
    const totalTokens = Number(row.totalTokens)
    const totalTokensWithoutCacheRead = Number(row.totalTokensWithoutCacheRead)

    return {
      rank: index + 1,
      slug: row.slug,
      displayName: row.displayName,
      totalTokens,
      totalTokensWithoutCacheRead,
      cacheReadRate: cacheReadRateFromTotals({ totalTokens, totalTokensWithoutCacheRead }),
      costUsd: Number(row.costUsd),
      costAvailable: Number(row.costAvailable) !== 0,
      primaryModel: row.primaryModel ?? null,
      sourceBreakdown: sourceBreakdownFromJson(row.sourceTokens, totalTokens),
      isCurrentViewer: Number(row.isCurrentViewer) !== 0
    }
  })
}

// `json_group_array` gives no ordering guarantee across SQLite builds, so the array is sorted
// here instead of in SQL: every reader then sees the same order for the same totals, and the
// code-unit tie-break keeps that order identical on every runtime. A value that is not the JSON
// array this statement produced is a bug, not input, so it throws rather than degrading the
// board silently.
function sourceBreakdownFromJson(sourceTokens: string | null, totalTokens: number): LeaderboardSourceBreakdown[] {
  if (!sourceTokens) return []

  const parsed: unknown = JSON.parse(sourceTokens)
  if (!Array.isArray(parsed)) {
    throw new Error('Leaderboard source breakdown was not a JSON array')
  }

  const totals = parsed.map((item) => {
    const { source, totalTokens: tokens } = (item ?? {}) as { source?: unknown; totalTokens?: unknown }
    return { source: typeof source === 'string' ? source : '', tokens: Number(tokens) }
  })

  return totals
    .filter((item) => item.source.length > 0 && Number.isFinite(item.tokens) && item.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens || compareCodeUnits(left.source, right.source))
    .map((item) => ({
      source: item.source,
      share: totalTokens > 0 ? item.tokens / totalTokens : 0
    }))
}

function compareCodeUnits(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function leaderboardBindings(input: LeaderboardQuery) {
  const limit = input.limit ?? 50
  const viewerUserId = input.viewerUserId ?? null
  // Bindings follow the order the placeholders appear in the statement: the summary window's
  // date bounds first (the CTEs sit above the `SELECT`), then the viewer id, then the limit.
  return input.summaryStrict
    ? [input.startDate, input.endDateExclusive, viewerUserId, limit]
    : [input.startDate, input.endDateExclusive, input.startDate, input.endDateExclusive, viewerUserId, limit]
}

function leaderboardOrderBy(metric: LeaderboardQuery['metric']) {
  // Every branch ends in `profiles.slug`, which is unique. Without a unique final key the
  // order of tied rows is whatever SQLite happens to return, so two users with identical
  // totals could swap places between requests — and at a page boundary that makes a user
  // appear to drop off the leaderboard and come back on refresh. The slug decides ties
  // deterministically without changing who outranks whom on the metric itself.
  if (metric === 'cost') return 'ORDER BY costUsd DESC, totalTokens DESC, profiles.slug ASC'
  if (metric === 'tokens-without-cache-read') {
    return 'ORDER BY totalTokensWithoutCacheRead DESC, totalTokens DESC, costUsd DESC, profiles.slug ASC'
  }
  return 'ORDER BY totalTokens DESC, costUsd DESC, profiles.slug ASC'
}
