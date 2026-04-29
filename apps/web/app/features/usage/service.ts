import { getDailyUsageTrend, getUsageSummary, type DailyUsageTrendItem, type UsageSummary } from './queries'
import { toIsoDate } from '../../lib/time'
import { usageSourceSchema } from './schema'

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

export type UsageDetailsFilters = {
  source: 'all' | 'claude-code' | 'codex'
  startDate: string
  endDate: string
}

export function parseUsageDetailsFilters(
  query: Record<string, string | undefined>,
  now = new Date()
): UsageDetailsFilters {
  const today = toIsoDate(now)
  const defaultStart = toIsoDate(addUtcDays(now, -29))
  const parsedSource = usageSourceSchema.safeParse(query.source)
  const source = query.source === 'all' || !parsedSource.success ? 'all' : parsedSource.data
  const startDate = readIsoDate(query.startDate, defaultStart)
  const endDate = readIsoDate(query.endDate, today)

  if (startDate > endDate) {
    return {
      source,
      startDate: endDate,
      endDate: startDate
    }
  }

  return {
    source,
    startDate,
    endDate
  }
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function readIsoDate(value: string | undefined, fallback: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
}
