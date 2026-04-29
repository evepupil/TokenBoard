import type { UsageSource } from '@tokenboard/usage-core'

export type UsageSummaryInput = {
  userId: string
  today: string
  monthStart: string
}

export type UsageSummary = {
  todayTokens: number
  todayCostUsd: number
  monthTokens: number
  monthCostUsd: number
  lastSyncedAt: string | null
  deviceCount: number
  sourceSplit: Array<{
    source: UsageSource
    totalTokens: number
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
  costUsd: number
}

type SummaryRow = {
  todayTokens: number | null
  todayCostUsd: number | null
  monthTokens: number | null
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
        WITH params(user_id, today, month_start) AS (SELECT ?, ?, ?),
        device_stats AS (
          SELECT
            devices.user_id,
            MAX(devices.last_synced_at) as lastSyncedAt,
            COUNT(*) as deviceCount
          FROM devices
          GROUP BY devices.user_id
        )
        SELECT
          COALESCE(SUM(CASE WHEN daily_usage.usage_date = params.today THEN daily_usage.total_tokens ELSE 0 END), 0) as todayTokens,
          COALESCE(SUM(CASE WHEN daily_usage.usage_date = params.today THEN daily_usage.cost_usd ELSE 0 END), 0) as todayCostUsd,
          COALESCE(SUM(CASE WHEN daily_usage.usage_date >= params.month_start THEN daily_usage.total_tokens ELSE 0 END), 0) as monthTokens,
          COALESCE(SUM(CASE WHEN daily_usage.usage_date >= params.month_start THEN daily_usage.cost_usd ELSE 0 END), 0) as monthCostUsd,
          device_stats.lastSyncedAt as lastSyncedAt,
          COALESCE(device_stats.deviceCount, 0) as deviceCount
        FROM params
        LEFT JOIN daily_usage ON daily_usage.user_id = params.user_id
        LEFT JOIN device_stats ON device_stats.user_id = params.user_id
      `
    )
    .bind(input.userId, input.today, input.monthStart)
    .first<SummaryRow>()

  const split = await db
    .prepare(
      `
        SELECT source, COALESCE(SUM(total_tokens), 0) as totalTokens
        FROM daily_usage
        WHERE user_id = ?
          AND usage_date >= ?
        GROUP BY source
        ORDER BY totalTokens DESC
      `
    )
    .bind(input.userId, input.monthStart)
    .all<{ source: UsageSource; totalTokens: number }>()

  return {
    todayTokens: Number(summary?.todayTokens ?? 0),
    todayCostUsd: Number(summary?.todayCostUsd ?? 0),
    monthTokens: Number(summary?.monthTokens ?? 0),
    monthCostUsd: Number(summary?.monthCostUsd ?? 0),
    lastSyncedAt: summary?.lastSyncedAt ?? null,
    deviceCount: Number(summary?.deviceCount ?? 0),
    sourceSplit: (split.results ?? []).map((row) => ({
      source: row.source,
      totalTokens: Number(row.totalTokens)
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
        SELECT
          usage_date as usageDate,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(cost_usd), 0) as costUsd
        FROM daily_usage
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
        costUsd: Number(row.costUsd)
      }
    ])
  )

  return eachIsoDate(input.startDate, input.endDate).map(
    (usageDate) => byDate.get(usageDate) ?? { usageDate, totalTokens: 0, costUsd: 0 }
  )
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
