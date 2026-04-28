import { getUsageSummary } from './queries'
import { toIsoDate } from '../../lib/time'

export async function getDashboardSummary(db: D1Database, userId: string, now = new Date()) {
  const today = toIsoDate(now)
  const monthStart = `${today.slice(0, 8)}01`
  return getUsageSummary(db, { userId, today, monthStart })
}
