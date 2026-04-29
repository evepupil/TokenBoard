import { getDailyUsageTrend, getUsageSummary, type DailyUsageTrendItem, type UsageSummary } from './queries'
import { toIsoDate } from '../../lib/time'

export type DashboardSummary = UsageSummary & {
  dailyTrend: DailyUsageTrendItem[]
}

export async function getDashboardSummary(db: D1Database, userId: string, now = new Date()) {
  const today = toIsoDate(now)
  const monthStart = `${today.slice(0, 8)}01`
  const trendStart = toIsoDate(addUtcDays(now, -29))
  const [summary, dailyTrend] = await Promise.all([
    getUsageSummary(db, { userId, today, monthStart }),
    getDailyUsageTrend(db, { userId, startDate: trendStart, endDate: today })
  ])
  return {
    ...summary,
    dailyTrend
  } satisfies DashboardSummary
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}
