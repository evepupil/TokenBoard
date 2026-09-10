import {
  getDailyUsageTrend,
  getUsageSummary,
  type DailyUsageTrendItem,
  type UsageDetails,
  type UsageSummary
} from './queries'
import { toIsoDate } from '../../lib/time'
import { usageSourceSchema } from './schema'
import { normalizeDeviceFilter, usageSummaryStrictMode } from './deduped-daily-usage'
import type { Bindings } from '../../lib/db'
import { isCostUnavailableSource, type UsageSource } from '@tokenboard/usage-core'

export type DashboardSummary = UsageSummary & {
  dailyTrend: DailyUsageTrendItem[]
}

export async function getDashboardSummary(
  db: D1Database,
  userId: string,
  now = new Date(),
  env: Pick<Bindings, 'TOKENBOARD_USAGE_SUMMARY_STRICT'> = {}
) {
  const today = toIsoDate(now)
  const monthStart = `${today.slice(0, 8)}01`
  const trendStart = toIsoDate(addUtcDays(now, -29))
  const summaryStrict = usageSummaryStrictMode(env)
  const [summary, dailyTrend] = await Promise.all([
    getUsageSummary(db, { userId, today, monthStart, summaryStrict }),
    getDailyUsageTrend(db, { userId, startDate: trendStart, endDate: today, summaryStrict })
  ])
  return {
    ...summary,
    dailyTrend
  } satisfies DashboardSummary
}

export type UsageDetailsFilters = {
  source: 'all' | UsageSource
  startDate: string
  endDate: string
  deviceId: string
  modelQuery: string
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
  const deviceId = normalizeDeviceFilter(query.device)
  const modelQuery = String(query.model ?? '').trim()

  if (startDate > endDate) {
    return {
      source,
      startDate: endDate,
      endDate: startDate,
      deviceId,
      modelQuery
    }
  }

  return {
    source,
    startDate,
    endDate,
    deviceId,
    modelQuery
  }
}

export function usageDetailsToCsv(details: UsageDetails) {
  const header = [
    'date',
    'source',
    'model',
    'input_tokens',
    'output_tokens',
    'cache_creation_tokens',
    'cache_read_tokens',
    'cache_read_rate',
    'total_tokens_without_cache_read',
    'total_tokens',
    'cost_usd',
    'cost_available',
    'session_count'
  ]

  const rows = details.modelRows.map((row) => {
    const costAvailable = !isCostUnavailableSource(row.source)
    return [
      row.usageDate,
      row.source,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheCreationTokens,
      row.cacheReadTokens,
      row.cacheReadRate,
      row.totalTokensWithoutCacheRead,
      row.totalTokens,
      costAvailable ? row.costUsd : '',
      costAvailable,
      row.sessionCount
    ]
  })

  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function readIsoDate(value: string | undefined, fallback: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
}

function csvCell(value: string | number | boolean) {
  const text = String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }
  return text
}
