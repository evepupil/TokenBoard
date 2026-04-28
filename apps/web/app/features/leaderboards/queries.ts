export type LeaderboardEntry = {
  rank: number
  slug: string
  displayName: string
  totalTokens: number
  costUsd: number
}

export async function listDailyLeaderboard(): Promise<LeaderboardEntry[]> {
  return []
}

