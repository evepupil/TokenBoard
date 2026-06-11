import { cacheReadRateFromTotals } from '../../../lib/usage-metrics'
import {
  effectiveDailyUsageSummaryWith,
  usageSummaryScopeSql,
  usageSummaryValue
} from '../deduped-daily-usage'
import { eachIsoDate, summaryRangeBindings } from './shared'
import type { DailyUsageTrendInput, DailyUsageTrendItem } from './types'

export async function getDailyUsageTrend(
  db: D1Database,
  input: DailyUsageTrendInput
): Promise<DailyUsageTrendItem[]> {
  const rows = await db
    .prepare(
      `
        WITH ${effectiveDailyUsageSummaryWith({
          filter: usageSummaryScopeSql({
            userId: usageSummaryValue.bind(),
            usageDateGte: usageSummaryValue.bind(),
            usageDateLte: usageSummaryValue.bind()
          }),
          summaryStrict: input.summaryStrict
        })}
        SELECT
          usage_date as usageDate,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(total_tokens_without_cache_read), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(cost_usd), 0) as costUsd
        FROM effective_daily_usage_summary
        GROUP BY usage_date
        ORDER BY usage_date ASC
      `
    )
    .bind(...summaryRangeBindings(input.summaryStrict, input.userId, input.startDate, input.endDate))
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
