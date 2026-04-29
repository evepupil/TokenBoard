export type LeaderboardEntry = {
  rank: number
  slug: string
  displayName: string
  totalTokens: number
  costUsd: number
}

export type LeaderboardQuery = {
  period: 'daily' | 'monthly'
  metric: 'tokens' | 'cost'
  startDate: string
  endDateExclusive: string
  limit?: number
}

export async function listDailyLeaderboard(
  db: D1Database,
  usageDate: string,
  limit = 50
): Promise<LeaderboardEntry[]> {
  return listLeaderboard(db, {
    period: 'daily',
    metric: 'tokens',
    startDate: usageDate,
    endDateExclusive: nextIsoDate(usageDate),
    limit
  })
}

export async function listLeaderboard(
  db: D1Database,
  input: LeaderboardQuery
): Promise<LeaderboardEntry[]> {
  const orderBy =
    input.metric === 'cost'
      ? 'ORDER BY costUsd DESC, totalTokens DESC'
      : 'ORDER BY totalTokens DESC, costUsd DESC'

  const rows = await db
    .prepare(
      `
        SELECT
          profiles.slug as slug,
          profiles.display_name as displayName,
          COALESCE(SUM(daily_usage.total_tokens), 0) as totalTokens,
          COALESCE(SUM(daily_usage.cost_usd), 0) as costUsd
        FROM profiles
        JOIN daily_usage ON daily_usage.user_id = profiles.user_id
        WHERE profiles.is_public = 1
          AND profiles.participates_in_leaderboards = 1
          AND daily_usage.usage_date >= ?
          AND daily_usage.usage_date < ?
        GROUP BY profiles.user_id, profiles.slug, profiles.display_name
        ${orderBy}
        LIMIT ?
      `
    )
    .bind(input.startDate, input.endDateExclusive, input.limit ?? 50)
    .all<Omit<LeaderboardEntry, 'rank'>>()

  return (rows.results ?? []).map((row, index) => ({
    rank: index + 1,
    slug: row.slug,
    displayName: row.displayName,
    totalTokens: Number(row.totalTokens),
    costUsd: Number(row.costUsd)
  }))
}

function nextIsoDate(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}
