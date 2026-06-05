import { randomId } from '../../lib/crypto'
import type { Bindings } from '../../lib/db'
import { toIsoDate } from '../../lib/time'
import type { DailyTokenReport } from './adapters'
import {
  dailyReportUrl,
  toDailyReportHistoryItem,
  type DailyReportHistoryRow
} from './report-history-item'

export const defaultDailyReportHistoryDays = 30
export const maxDailyReportHistoryDays = 31

export type DailyReportHistoryEnv = Pick<Bindings, 'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS'>
export { dailyReportUrl, type DailyReportHistoryItem, type DailyReportHistoryRow } from './report-history-item'

type DailyReportHistorySaveRow = {
  id: string
  shareRevokedAt?: string | null
  isNew: boolean
}

type DailyReportHistoryShareRow = {
  id: string
  shareRevokedAt?: string | null
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
  id?: string
  origin?: string
}) {
  const id = input.id ?? randomId('drr')
  const generatedAt = input.generatedAt.toISOString()

  const row = await insertDailyReportHistory(input, id, generatedAt)
  const saved = row ?? await updateDailyReportHistory(input, generatedAt)

  if (!saved) {
    throw new Error('Daily report history was not persisted')
  }

  return {
    id: saved.id,
    reportUrl: dailyReportUrl(saved.id, input.origin),
    isNew: saved.isNew,
    shareRevokedAt: saved.shareRevokedAt ?? null
  }
}

export async function prepareDailyReportHistoryShare(input: {
  db: D1Database
  userId: string
  report: DailyTokenReport
  scheduleSlot: string
  generatedAt: Date
  id?: string
  origin?: string
}) {
  const id = input.id ?? randomId('drr')
  const generatedAt = input.generatedAt.toISOString()
  const row = await insertDailyReportHistory(input, id, generatedAt)
  const share = row ?? await getDailyReportHistoryShare(input)

  if (!share) {
    throw new Error('Daily report history share was not prepared')
  }

  return {
    id: share.id,
    reportUrl: dailyReportUrl(share.id, input.origin),
    isNew: Boolean(row),
    shareRevokedAt: share.shareRevokedAt ?? null
  }
}

async function insertDailyReportHistory(
  input: {
    db: D1Database
    userId: string
    report: DailyTokenReport
    scheduleSlot: string
  },
  id: string,
  generatedAt: string
) {
  const row = await input.db
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
          share_revoked_at,
          generated_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, report_date, schedule_slot) DO NOTHING
        RETURNING
          id,
          share_revoked_at as shareRevokedAt,
          1 as isNew
      `
    )
    .bind(
      id,
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
      null,
      generatedAt,
      generatedAt
    )
    .first<DailyReportHistorySaveRow>()

  return row ? { ...row, isNew: Boolean(row.isNew) } : null
}

async function updateDailyReportHistory(
  input: {
    db: D1Database
    userId: string
    report: DailyTokenReport
    scheduleSlot: string
  },
  generatedAt: string
) {
  const row = await input.db
    .prepare(
      `
        UPDATE daily_report_history
        SET
          display_name = ?,
          timezone = ?,
          dashboard_url = ?,
          total_tokens = ?,
          total_tokens_without_cache_read = ?,
          cache_read_rate = ?,
          cost_usd = ?,
          session_count = ?,
          source_split = ?,
          top_models = ?,
          generated_at = ?,
          updated_at = ?
        WHERE user_id = ?
          AND report_date = ?
          AND schedule_slot = ?
        RETURNING
          id,
          share_revoked_at as shareRevokedAt,
          0 as isNew
      `
    )
    .bind(
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
      generatedAt,
      input.userId,
      input.report.reportDate,
      input.scheduleSlot
    )
    .first<DailyReportHistorySaveRow>()

  return row ? { ...row, isNew: Boolean(row.isNew) } : null
}

async function getDailyReportHistoryShare(input: {
  db: D1Database
  userId: string
  report: DailyTokenReport
  scheduleSlot: string
}) {
  return input.db
    .prepare(
      `
        SELECT
          id,
          share_revoked_at as shareRevokedAt
        FROM daily_report_history
        WHERE user_id = ?
          AND report_date = ?
          AND schedule_slot = ?
        LIMIT 1
      `
    )
    .bind(input.userId, input.report.reportDate, input.scheduleSlot)
    .first<DailyReportHistoryShareRow>()
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
          share_revoked_at as shareRevokedAt,
          generated_at as generatedAt,
          updated_at as updatedAt
        FROM daily_report_history
        WHERE user_id = ?
        ORDER BY generated_at DESC, schedule_slot DESC
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

function invalidRetentionError() {
  return new Error(`TOKENBOARD_DAILY_REPORT_HISTORY_DAYS must be an integer from 1 to ${maxDailyReportHistoryDays}`)
}
