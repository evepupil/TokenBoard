export type LeaderboardEntry = {
  rank: number
  slug: string
  displayName: string
  totalTokens: number
  costUsd: number
}

export async function listDailyLeaderboard(
  db: D1Database,
  usageDate: string,
  limit = 50
): Promise<LeaderboardEntry[]> {
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
          AND daily_usage.usage_date = ?
        GROUP BY profiles.user_id, profiles.slug, profiles.display_name
        ORDER BY totalTokens DESC, costUsd DESC
        LIMIT ?
      `
    )
    .bind(usageDate, limit)
    .all<Omit<LeaderboardEntry, 'rank'>>()

  return (rows.results ?? []).map((row, index) => ({
    rank: index + 1,
    slug: row.slug,
    displayName: row.displayName,
    totalTokens: Number(row.totalTokens),
    costUsd: Number(row.costUsd)
  }))
}
