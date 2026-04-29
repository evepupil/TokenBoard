import { listDailyLeaderboard, listLeaderboard } from './queries'
import { leaderboardMetricSchema, leaderboardPeriodSchema } from './schema'

export type LeaderboardOptions = {
  period?: unknown
  metric?: unknown
}

export async function getDailyLeaderboard(db: D1Database, today = new Date()) {
  return listDailyLeaderboard(db, today.toISOString().slice(0, 10))
}

export async function getLeaderboard(
  db: D1Database,
  options: LeaderboardOptions = {},
  now = new Date()
) {
  const period = leaderboardPeriodSchema.catch('daily').parse(options.period)
  const metric = leaderboardMetricSchema.catch('tokens').parse(options.metric)
  const today = now.toISOString().slice(0, 10)
  const range =
    period === 'monthly'
      ? currentMonthRange(now)
      : { startDate: today, endDateExclusive: addUtcDaysIso(today, 1) }

  return listLeaderboard(db, {
    period,
    metric,
    startDate: range.startDate,
    endDateExclusive: range.endDateExclusive,
    limit: 50
  })
}

function currentMonthRange(date: Date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
  return {
    startDate: start.toISOString().slice(0, 10),
    endDateExclusive: end.toISOString().slice(0, 10)
  }
}

function addUtcDaysIso(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
