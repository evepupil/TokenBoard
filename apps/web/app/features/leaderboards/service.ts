import { listDailyLeaderboard } from './queries'

export async function getDailyLeaderboard(db: D1Database, today = new Date()) {
  return listDailyLeaderboard(db, today.toISOString().slice(0, 10))
}
