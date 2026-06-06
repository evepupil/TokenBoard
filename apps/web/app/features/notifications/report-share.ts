import { defaultDailyReportHistoryDays, retentionCutoffDate } from './report-history'
import {
  toDailyReportHistoryItem,
  type DailyReportHistoryRow
} from './report-history-item'
import { ApiError } from '../../lib/errors'
import { toIsoDate } from '../../lib/time'
import { NotificationFormError } from './errors'

export type DailyReportShareSettings = {
  dailyReportShareEnabled: boolean
}

type DailyReportShareSettingsRow = {
  dailyReportShareEnabled: number | boolean
}

export async function getDailyReportHistoryById(input: {
  db: D1Database
  id: string
  viewerUserId?: string | null
  retentionDays?: number
  now?: Date
}) {
  const cutoffDate = retentionCutoffDate(
    toIsoDate(input.now ?? new Date()),
    input.retentionDays ?? defaultDailyReportHistoryDays
  )
  const row = await input.db
    .prepare(
      `
        SELECT
          daily_report_history.id,
          daily_report_history.user_id as ownerUserId,
          daily_report_history.display_name as displayName,
          daily_report_history.report_date as reportDate,
          daily_report_history.schedule_slot as scheduleSlot,
          daily_report_history.timezone,
          daily_report_history.dashboard_url as dashboardUrl,
          daily_report_history.total_tokens as totalTokens,
          daily_report_history.total_tokens_without_cache_read as totalTokensWithoutCacheRead,
          daily_report_history.cache_read_rate as cacheReadRate,
          daily_report_history.cost_usd as costUsd,
          daily_report_history.session_count as sessionCount,
          daily_report_history.source_split as sourceSplit,
          daily_report_history.top_models as topModels,
          daily_report_history.share_revoked_at as shareRevokedAt,
          profiles.daily_report_share_enabled as shareEnabled,
          daily_report_history.generated_at as generatedAt,
          daily_report_history.updated_at as updatedAt
        FROM daily_report_history
        JOIN profiles ON profiles.user_id = daily_report_history.user_id
        WHERE daily_report_history.id = ?
          AND daily_report_history.report_date >= ?
          AND (
            daily_report_history.user_id = ?
            OR (
              profiles.daily_report_share_enabled = 1
              AND daily_report_history.share_revoked_at IS NULL
            )
          )
        LIMIT 1
      `
    )
    .bind(input.id, cutoffDate, input.viewerUserId ?? null)
    .first<DailyReportHistoryRow>()

  if (!row || !canReadDailyReportHistory(row, input.viewerUserId, cutoffDate)) return null
  return toDailyReportHistoryItem(row)
}

export async function getDailyReportShareSettings(input: {
  db: D1Database
  userId: string
}): Promise<DailyReportShareSettings> {
  const row = await input.db
    .prepare(
      `
        SELECT daily_report_share_enabled as dailyReportShareEnabled
        FROM profiles
        WHERE user_id = ?
        LIMIT 1
      `
    )
    .bind(input.userId)
    .first<DailyReportShareSettingsRow>()

  return {
    dailyReportShareEnabled: row ? Boolean(row.dailyReportShareEnabled) : false
  }
}

export async function updateDailyReportShareSettings(input: {
  db: D1Database
  userId: string
  enabled: boolean
  now?: string
}) {
  const now = input.now ?? new Date().toISOString()
  const result = await input.db
    .prepare(
      `
        UPDATE profiles
        SET
          daily_report_share_enabled = ?,
          updated_at = ?
        WHERE user_id = ?
      `
    )
    .bind(input.enabled ? 1 : 0, now, input.userId)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError('NOT_FOUND', 'Profile not found', 404)
  }
}

export async function revokeDailyReportShare(input: {
  db: D1Database
  userId: string
  reportId: string
  now?: string
}) {
  const now = input.now ?? new Date().toISOString()
  const result = await input.db
    .prepare(
      `
        UPDATE daily_report_history
        SET
          share_revoked_at = ?,
          updated_at = ?
        WHERE user_id = ?
          AND id = ?
          AND share_revoked_at IS NULL
      `
    )
    .bind(now, now, input.userId, input.reportId)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError('NOT_FOUND', 'Daily report not found', 404)
  }
}

export function parseDailyReportId(form: Record<string, unknown>) {
  const id = String(form.reportId ?? '').trim()
  if (!isDailyReportId(id)) {
    throw new NotificationFormError('invalid-daily-report-id')
  }
  return id
}

export function isDailyReportId(id: string) {
  return /^drr_[A-Za-z0-9_-]{32}$/.test(id)
}

function canReadDailyReportHistory(
  row: DailyReportHistoryRow,
  viewerUserId: string | null | undefined,
  cutoffDate: string
) {
  if (row.reportDate < cutoffDate) return false
  if (viewerUserId && viewerUserId === row.ownerUserId) return true
  return Boolean(row.shareEnabled) && !row.shareRevokedAt
}
