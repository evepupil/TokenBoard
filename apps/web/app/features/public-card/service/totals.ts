import {
  costUnavailableSourcesSql,
  effectiveDailyUsageSummaryWith,
  usageSummaryParam,
  usageSummaryScopeSql
} from '../../usage/deduped-daily-usage'
import { billableCostSql, costUnavailableSourcesSql as sharedCostUnavailableSourcesSql } from '../../../lib/usage-cost'
import type { TotalsRow } from './types'

export async function getPublicTotals(input: {
  db: D1Database
  userId: string
  today: string
  monthStart: string
  summaryStrict: boolean
  includeBreakdown: boolean
  includeSourceSplit: boolean
}) {
  return input.db
    .prepare(
      `
        WITH params(user_id, today, month_start) AS (SELECT ?, ?, ?),
        ${effectiveDailyUsageSummaryWith({
          filter: usageSummaryScopeSql({
            userId: usageSummaryParam('userId')
          }),
          summaryStrict: input.summaryStrict
        })},
        month_usage AS (
          SELECT
            effective_daily_usage_summary.*
          FROM effective_daily_usage_summary
          JOIN params ON params.user_id = effective_daily_usage_summary.user_id
          WHERE effective_daily_usage_summary.usage_date >= params.month_start
            AND effective_daily_usage_summary.usage_date < date(params.month_start, '+1 month')
        ),
        today_source_usage AS (
          SELECT
            source
          FROM month_usage
          JOIN params ON params.user_id = month_usage.user_id
          WHERE month_usage.usage_date = params.today
          GROUP BY source
        ),
        month_source_usage AS (
          SELECT
            source
          FROM month_usage
          GROUP BY source
        ),
        total_source_usage AS (
          SELECT
            source
          FROM effective_daily_usage_summary
          JOIN params ON params.user_id = effective_daily_usage_summary.user_id
          GROUP BY source
        )
        ${publicBreakdownCtes(input.includeBreakdown, input.includeSourceSplit)}
        ,
        effective_totals AS (
          SELECT
            user_usage_totals.user_id,
            user_usage_totals.total_tokens,
            user_usage_totals.total_tokens_without_cache_read,
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM effective_daily_usage_summary
                WHERE effective_daily_usage_summary.user_id = params.user_id
                  AND effective_daily_usage_summary.source IN (${sharedCostUnavailableSourcesSql})
              ) THEN COALESCE((
                SELECT SUM(${billableCostSql()})
                FROM effective_daily_usage_summary
                WHERE effective_daily_usage_summary.user_id = params.user_id
              ), 0)
              ELSE user_usage_totals.cost_usd
            END as cost_usd
          FROM user_usage_totals
          JOIN params ON params.user_id = user_usage_totals.user_id
          WHERE NOT EXISTS (
            SELECT 1
            FROM effective_daily_usage_summary
            WHERE effective_daily_usage_summary.user_id = params.user_id
              AND effective_daily_usage_summary.updated_at > user_usage_totals.updated_at
          )
          UNION ALL
          SELECT
            params.user_id,
            COALESCE(SUM(effective_daily_usage_summary.total_tokens), 0),
            COALESCE(SUM(effective_daily_usage_summary.total_tokens_without_cache_read), 0),
            COALESCE(SUM(${billableCostSql()}), 0)
          FROM params
          LEFT JOIN effective_daily_usage_summary
            ON effective_daily_usage_summary.user_id = params.user_id
          WHERE NOT EXISTS (
            SELECT 1
            FROM user_usage_totals
            WHERE user_usage_totals.user_id = params.user_id
              AND NOT EXISTS (
                SELECT 1
                FROM effective_daily_usage_summary
                WHERE effective_daily_usage_summary.user_id = params.user_id
                  AND effective_daily_usage_summary.updated_at > user_usage_totals.updated_at
              )
          )
        )
        SELECT
          COALESCE(MAX(effective_totals.total_tokens), 0) as totalTokens,
          COALESCE(MAX(effective_totals.total_tokens_without_cache_read), 0) as totalTokensWithoutCacheRead,
          COALESCE(MAX(effective_totals.cost_usd), 0) as totalCostUsd,
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.total_tokens ELSE 0 END), 0) as todayTokens,
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.total_tokens_without_cache_read ELSE 0 END), 0) as todayTokensWithoutCacheRead,
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN ${billableCostSql({ sourceColumn: 'month_usage.source', costColumn: 'month_usage.cost_usd' })} ELSE 0 END), 0) as todayCostUsd,
          COALESCE(SUM(month_usage.total_tokens), 0) as monthTokens,
          COALESCE(SUM(month_usage.total_tokens_without_cache_read), 0) as monthTokensWithoutCacheRead,
          COALESCE(SUM(${billableCostSql({ sourceColumn: 'month_usage.source', costColumn: 'month_usage.cost_usd' })}), 0) as monthCostUsd
          , CASE WHEN EXISTS (SELECT 1 FROM total_source_usage WHERE source IN (${costUnavailableSourcesSql})) THEN 0 ELSE 1 END as totalCostAvailable
          , CASE WHEN EXISTS (SELECT 1 FROM today_source_usage WHERE source IN (${costUnavailableSourcesSql})) THEN 0 ELSE 1 END as todayCostAvailable
          , CASE WHEN EXISTS (SELECT 1 FROM month_source_usage WHERE source IN (${costUnavailableSourcesSql})) THEN 0 ELSE 1 END as monthCostAvailable
          ${publicBreakdownSelect(input.includeBreakdown, input.includeSourceSplit)}
        FROM params
        LEFT JOIN effective_totals ON effective_totals.user_id = params.user_id
        LEFT JOIN month_usage ON month_usage.user_id = params.user_id
      `
    )
    .bind(input.userId, input.today, input.monthStart)
    .first<TotalsRow>()
}

function publicBreakdownCtes(includeBreakdown: boolean, includeSourceSplit: boolean) {
  const ctes = [includeSourceSplit ? sourceBreakdownCte() : '', includeBreakdown ? modelBreakdownCte() : ''].filter(
    Boolean
  )
  return ctes.length > 0 ? `,\n        ${ctes.join(',\n        ')}` : ''
}

function sourceBreakdownCte() {
  return `source_usage AS (
          SELECT
            source,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(total_tokens_without_cache_read), 0) as total_tokens_without_cache_read
          FROM month_usage
          GROUP BY source
        )`
}

function modelBreakdownCte() {
  return `model_usage AS (
          SELECT
            model,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(total_tokens_without_cache_read), 0) as total_tokens_without_cache_read,
            COALESCE(SUM(${billableCostSql()}), 0) as cost_usd,
            MIN(CASE
              WHEN source IN (${costUnavailableSourcesSql}) THEN 0
              ELSE 1
            END) as cost_available
          FROM month_usage
          GROUP BY model
        )`
}

function publicBreakdownSelect(includeBreakdown: boolean, includeSourceSplit: boolean) {
  if (!includeBreakdown && !includeSourceSplit)
    return `,
          '[]' as sourceSplit,
          '[]' as topModels`
  if (includeSourceSplit && !includeBreakdown)
    return `,
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
          '[]' as topModels`
  if (includeBreakdown && !includeSourceSplit)
    return `,
          '[]' as sourceSplit,
          (
            SELECT COALESCE(json_group_array(json_object(
              'model', ordered_models.model,
              'totalTokens', ordered_models.total_tokens,
              'totalTokensWithoutCacheRead', ordered_models.total_tokens_without_cache_read,
              'costUsd', ordered_models.cost_usd,
              'costAvailable', ordered_models.cost_available
            )), '[]')
            FROM (
              SELECT
                model,
                total_tokens,
                total_tokens_without_cache_read,
                cost_usd,
                cost_available
              FROM model_usage
              ORDER BY total_tokens_without_cache_read DESC, total_tokens DESC
              LIMIT 5
            ) AS ordered_models
          ) as topModels`
  return `,
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
              'costAvailable', ordered_models.cost_available
            )), '[]')
            FROM (
              SELECT
                model,
                total_tokens,
                total_tokens_without_cache_read,
                cost_usd,
                cost_available
              FROM model_usage
              ORDER BY total_tokens_without_cache_read DESC, total_tokens DESC
              LIMIT 5
            ) AS ordered_models
          ) as topModels`
}
