import { listDailyLeaderboard } from './queries'

export async function getDailyLeaderboard() {
  return listDailyLeaderboard()
}

