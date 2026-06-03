import { randomId } from '../../lib/crypto'
import type { Bindings } from '../../lib/db'
import { toIsoDate } from '../../lib/time'
import type { DailyTokenReport } from './adapters'

export const defaultDailyReportHistoryDays = 30
export const maxDailyReportHistoryDays = 31

export type DailyReportHistoryEnv = Pick<Bindings, 'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS'>

export type DailyReportHistoryItem = DailyTokenReport & {
  id: string
  scheduleSlot: string
  generatedAt: string
  updatedAt: string
}

type DailyReportHistoryRow = {
  id: string
  displayName: string
  reportDate: string
  scheduleSlot: string
  timezone: string
  dashboardUrl: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
  sessionCount: number
  sourceSplit: string
  topModels: string
  generatedAt: string
  updatedAt: string
}

export function dailyReportHistoryRetentionDays(env: DailyReportHistoryEnv) {
  if (env.TOKENBOARD_DAILY_REPORT_HISTORY_DAYS === undefined) return defaultDailyReportHistoryDays
  const raw = env.TOKENBOARD_DAILY_REPORT_HISTORY_DAYS.trim()
  if (!raw) throw invalidRetentionError()
  if (!/^\d+$/.test(raw)) throw invalidRetentionError()

  const days = Number(raw)
  if (!Number.isSafeInteger(days) || days < 1 || days > maxDailyReportHistoryDays) {
    throw invalidRetentionError()
  }
  return days
}

export async function saveDailyReportHistory(input: {
  db: D1Database
  userId: string
  report: DailyTokenReport
  scheduleSlot: string
  generatedAt: Date
}) {
  const generatedAt = input.generatedAt.toISOString()

  await input.db
    .prepare(
      `
        INSERT INTO daily_report_history (
          id,
          user_id,
          report_date,
          schedule_slot,
          display_name,
          timezone,
          dashboard_url,
          total_tokens,
          total_tokens_without_cache_read,
          cache_read_rate,
          cost_usd,
          session_count,
          source_split,
          top_models,
          generated_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, report_date, schedule_slot) DO UPDATE SET
          display_name = excluded.display_name,
          timezone = excluded.timezone,
          dashboard_url = excluded.dashboard_url,
          total_tokens = excluded.total_tokens,
          total_tokens_without_cache_read = excluded.total_tokens_without_cache_read,
          cache_read_rate = excluded.cache_read_rate,
          cost_usd = excluded.cost_usd,
          session_count = excluded.session_count,
          source_split = excluded.source_split,
          top_models = excluded.top_models,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
      `
    )
    .bind(
      randomId('drr'),
      input.userId,
      input.report.reportDate,
      input.scheduleSlot,
      input.report.displayName,
      input.report.timezone,
      input.report.dashboardUrl,
      input.report.totalTokens,
      input.report.totalTokensWithoutCacheRead,
      input.report.cacheReadRate ?? 0,
      input.report.costUsd,
      input.report.sessionCount,
      JSON.stringify(input.report.sourceSplit),
      JSON.stringify(input.report.topModels),
      generatedAt,
      generatedAt
    )
    .run()
}

export async function listDailyReportHistory(input: {
  db: D1Database
  userId: string
  limit?: number
}) {
  const rows = await input.db
    .prepare(
      `
        SELECT
          id,
          display_name as displayName,
          report_date as reportDate,
          schedule_slot as scheduleSlot,
          timezone,
          dashboard_url as dashboardUrl,
          total_tokens as totalTokens,
          total_tokens_without_cache_read as totalTokensWithoutCacheRead,
          cache_read_rate as cacheReadRate,
          cost_usd as costUsd,
          session_count as sessionCount,
          source_split as sourceSplit,
          top_models as topModels,
          generated_at as generatedAt,
          updated_at as updatedAt
        FROM daily_report_history
        WHERE user_id = ?
        ORDER BY schedule_slot DESC
        LIMIT ?
      `
    )
    .bind(input.userId, input.limit ?? maxDailyReportHistoryDays)
    .all<DailyReportHistoryRow>()

  return (rows.results ?? []).map(toDailyReportHistoryItem)
}

export async function pruneExpiredDailyReportHistory(input: {
  db: D1Database
  userId: string
  reportDate: string
  retentionDays: number
}) {
  const cutoffDate = retentionCutoffDate(input.reportDate, input.retentionDays)
  await input.db
    .prepare('DELETE FROM daily_report_history WHERE user_id = ? AND report_date < ?')
    .bind(input.userId, cutoffDate)
    .run()
}

export function retentionCutoffDate(reportDate: string, retentionDays: number) {
  const cutoff = new Date(`${reportDate}T00:00:00.000Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays + 1)
  return toIsoDate(cutoff)
}

function toDailyReportHistoryItem(row: DailyReportHistoryRow): DailyReportHistoryItem {
  return {
    id: row.id,
    displayName: row.displayName,
    reportDate: row.reportDate,
    scheduleSlot: row.scheduleSlot,
    timezone: row.timezone,
    dashboardUrl: row.dashboardUrl,
    totalTokens: Number(row.totalTokens),
    totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
    cacheReadRate: Number(row.cacheReadRate),
    costUsd: Number(row.costUsd),
    sessionCount: Number(row.sessionCount),
    sourceSplit: parseHistoryArray(row.sourceSplit, 'source_split', parseSourceSplitItem),
    topModels: parseHistoryArray(row.topModels, 'top_models', parseTopModelItem),
    generatedAt: row.generatedAt,
    updatedAt: row.updatedAt
  }
}

function parseHistoryArray<T>(
  value: string,
  column: string,
  parseItem: (value: unknown, column: string) => T
) {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error(`Invalid daily report history ${column}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid daily report history ${column}`)
  }
  return parsed.map((item) => parseItem(item, column))
}

function parseSourceSplitItem(value: unknown, column: string): DailyTokenReport['sourceSplit'][number] {
  const item = historyRecord(value, column)
  return {
    source: historyString(item.source, column),
    totalTokens: historyNumber(item.totalTokens, column),
    totalTokensWithoutCacheRead: historyNumber(item.totalTokensWithoutCacheRead, column),
    cacheReadRate: optionalHistoryNumber(item.cacheReadRate, column)
  }
}

function parseTopModelItem(value: unknown, column: string): DailyTokenReport['topModels'][number] {
  const item = historyRecord(value, column)
  return {
    model: historyString(item.model, column),
    totalTokens: historyNumber(item.totalTokens, column),
    totalTokensWithoutCacheRead: historyNumber(item.totalTokensWithoutCacheRead, column),
    cacheReadRate: optionalHistoryNumber(item.cacheReadRate, column),
    costUsd: historyNumber(item.costUsd, column)
  }
}

function historyRecord(value: unknown, column: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid daily report history ${column}`)
  }
  return value as Record<string, unknown>
}

function historyString(value: unknown, column: string) {
  if (typeof value !== 'string') {
    throw new Error(`Invalid daily report history ${column}`)
  }
  return value
}

function historyNumber(value: unknown, column: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid daily report history ${column}`)
  }
  return value
}

function optionalHistoryNumber(value: unknown, column: string) {
  if (value === undefined) return undefined
  return historyNumber(value, column)
}

function invalidRetentionError() {
  return new Error(`TOKENBOARD_DAILY_REPORT_HISTORY_DAYS must be an integer from 1 to ${maxDailyReportHistoryDays}`)
}
