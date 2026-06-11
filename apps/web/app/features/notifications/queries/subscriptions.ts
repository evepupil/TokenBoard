import type { WebhookSubscriptionSummary } from '../schema'
import { normalizeSecretRow, normalizeSettingsSubscriptionSummary } from './normalize'
import type {
  DueWebhookSubscription,
  WebhookSubscriptionRow,
  WebhookSubscriptionSecretDbRow
} from './types'

const subscriptionSummarySelect = `
  SELECT
    id,
    name,
    provider,
    webhook_url_host as webhookUrlHost,
    webhook_url_masked as webhookUrlMasked,
    timezone,
    schedule_time_local as scheduleTimeLocal,
    schedule_times_local as scheduleTimesLocal,
    schedule_weekdays as scheduleWeekdays,
    send_empty_report as sendEmptyReport,
    enabled,
    next_run_at as nextRunAt,
    pending_report_date as pendingReportDate,
    pending_schedule_slot as pendingScheduleSlot,
    failure_count as failureCount,
    last_success_at as lastSuccessAt,
    last_failure_at as lastFailureAt,
    last_error as lastError,
    created_at as createdAt,
    updated_at as updatedAt
  FROM webhook_subscriptions
`

const subscriptionSecretSelect = `
  SELECT
    webhook_subscriptions.id,
    webhook_subscriptions.user_id as userId,
    profiles.display_name as displayName,
    profiles.daily_report_share_enabled as dailyReportShareEnabled,
    webhook_subscriptions.name,
    webhook_subscriptions.provider,
    webhook_subscriptions.webhook_url_encrypted as webhookUrlEncrypted,
    webhook_subscriptions.webhook_url_host as webhookUrlHost,
    webhook_subscriptions.webhook_url_masked as webhookUrlMasked,
    webhook_subscriptions.signing_secret_encrypted as signingSecretEncrypted,
    webhook_subscriptions.timezone,
    webhook_subscriptions.schedule_time_local as scheduleTimeLocal,
    webhook_subscriptions.schedule_times_local as scheduleTimesLocal,
    webhook_subscriptions.schedule_weekdays as scheduleWeekdays,
    webhook_subscriptions.send_empty_report as sendEmptyReport,
    webhook_subscriptions.enabled,
    webhook_subscriptions.next_run_at as nextRunAt,
    webhook_subscriptions.pending_report_date as pendingReportDate,
    webhook_subscriptions.pending_schedule_slot as pendingScheduleSlot,
    webhook_subscriptions.locked_at as lockedAt,
    webhook_subscriptions.failure_count as failureCount,
    webhook_subscriptions.last_success_at as lastSuccessAt,
    webhook_subscriptions.last_failure_at as lastFailureAt,
    webhook_subscriptions.last_error as lastError,
    webhook_subscriptions.created_at as createdAt,
    webhook_subscriptions.updated_at as updatedAt
  FROM webhook_subscriptions
  JOIN profiles ON profiles.user_id = webhook_subscriptions.user_id
`

export async function listWebhookSubscriptions(
  db: D1Database,
  userId: string
): Promise<WebhookSubscriptionSummary[]> {
  const rows = await db
    .prepare(
      `
        ${subscriptionSummarySelect}
        WHERE user_id = ?
        ORDER BY created_at DESC
      `
    )
    .bind(userId)
    .all<WebhookSubscriptionRow>()

  return (rows.results ?? []).map(normalizeSettingsSubscriptionSummary)
}

export async function getWebhookSubscriptionForUser(
  db: D1Database,
  userId: string,
  subscriptionId: string
) {
  const row = await db
    .prepare(
      `
        ${subscriptionSecretSelect}
        WHERE webhook_subscriptions.user_id = ?
          AND webhook_subscriptions.id = ?
        LIMIT 1
      `
    )
    .bind(userId, subscriptionId)
    .first<WebhookSubscriptionSecretDbRow>()

  return row ? normalizeSecretRow(row) : null
}

export async function listDueWebhookSubscriptions(
  db: D1Database,
  nowIso: string,
  limit: number
): Promise<DueWebhookSubscription[]> {
  const rows = await db
    .prepare(
      `
        ${subscriptionSecretSelect}
        WHERE webhook_subscriptions.enabled = 1
          AND webhook_subscriptions.next_run_at <= ?
          AND (
            webhook_subscriptions.locked_until IS NULL
            OR webhook_subscriptions.locked_until <= ?
          )
        ORDER BY webhook_subscriptions.next_run_at ASC
        LIMIT ?
      `
    )
    .bind(nowIso, nowIso, limit)
    .all<WebhookSubscriptionSecretDbRow>()

  return (rows.results ?? []).map(normalizeSecretRow)
}

export async function claimWebhookSubscription(input: {
  db: D1Database
  subscriptionId: string
  nowIso: string
  lockedUntilIso: string
}) {
  const result = await input.db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          locked_until = ?,
          locked_at = ?,
          updated_at = ?
        WHERE id = ?
          AND enabled = 1
          AND next_run_at <= ?
          AND (
            locked_until IS NULL
            OR locked_until <= ?
          )
      `
    )
    .bind(
      input.lockedUntilIso,
      input.nowIso,
      input.nowIso,
      input.subscriptionId,
      input.nowIso,
      input.nowIso
    )
    .run()

  return Number(result.meta?.changes ?? 0) > 0
}
