import { ApiError } from '../../lib/errors'
import { randomId } from '../../lib/crypto'
import { isValidTimezone } from '../../lib/timezone'
import { encryptSecret } from './crypto'
import {
  maskWebhookUrl,
  parseProviderWebhookUrl,
  hasValidEncryptionKey,
  requireEncryptionKey,
  type WebhookEnv
} from './config'
import {
  getWebhookSubscriptionForUser,
  listWebhookSubscriptions
} from './queries'
import {
  parseWebhookSubscriptionForm,
  scheduleTimesFromForm,
  scheduleWeekdaysFromForm,
  type WebhookSubscriptionSummary,
  type WebhookSubscriptionForm
} from './schema'
import { sendWebhookTest, runDueWebhookNotifications } from './delivery'
import { nextScheduledRunAt } from './time'

export { listWebhookSubscriptions, sendWebhookTest, runDueWebhookNotifications, hasValidEncryptionKey }
export {
  getDailyReportShareSettings,
  parseDailyReportId,
  revokeDailyReportShare,
  updateDailyReportShareSettings
} from './report-share'

export function parseWebhookAction(form: Record<string, unknown>) {
  return String(form.action ?? '')
}

export function parseWebhookId(form: Record<string, unknown>) {
  return String(form.subscriptionId ?? '').trim()
}

export function parseWebhookCreateForm(form: Record<string, unknown>) {
  return parseWebhookFormOrThrow(() => parseWebhookSubscriptionForm(form))
}

export function parseWebhookUpdateForm(form: Record<string, unknown>) {
  const scheduleTimesLocal = parseWebhookFormOrThrow(() => scheduleTimesFromForm(form))
  const scheduleWeekdays = parseWebhookFormOrThrow(() => scheduleWeekdaysFromForm(form))
  return {
    name: String(form.name ?? '').trim(),
    timezone: String(form.timezone ?? '').trim(),
    scheduleTimeLocal: scheduleTimesLocal[0],
    scheduleTimesLocal,
    scheduleWeekdays,
    sendEmptyReport: form.sendEmptyReport === 'on',
    enabled: form.enabled === 'on'
  }
}

export async function createWebhookSubscription(input: {
  env: WebhookEnv
  userId: string
  form: WebhookSubscriptionForm
  now?: Date
}) {
  const secret = requireEncryptionKey(input.env)
  const webhookUrl = parseProviderWebhookUrl(input.form.provider, input.form.webhookUrl)
  const now = input.now ?? new Date()

  await input.env.DB
    .prepare(
      `
        INSERT INTO webhook_subscriptions (
          id,
          user_id,
          name,
          provider,
          webhook_url_encrypted,
          webhook_url_host,
          webhook_url_masked,
          signing_secret_encrypted,
          timezone,
          schedule_time_local,
          schedule_times_local,
          schedule_weekdays,
          send_empty_report,
          enabled,
          next_run_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      randomId('whs'),
      input.userId,
      input.form.name,
      input.form.provider,
      await encryptSecret(webhookUrl.toString(), secret),
      webhookUrl.host,
      maskWebhookUrl(webhookUrl),
      input.form.signingSecret ? await encryptSecret(input.form.signingSecret, secret) : null,
      input.form.timezone,
      input.form.scheduleTimeLocal,
      input.form.scheduleTimesLocal.join(','),
      input.form.scheduleWeekdays.join(','),
      input.form.sendEmptyReport ? 1 : 0,
      input.form.enabled ? 1 : 0,
      nextScheduledRunAt({
        now,
        timezone: input.form.timezone,
        scheduleTimesLocal: input.form.scheduleTimesLocal,
        scheduleWeekdays: input.form.scheduleWeekdays
      }),
      now.toISOString(),
      now.toISOString()
    )
    .run()
}

export async function updateWebhookSubscription(input: {
  env: WebhookEnv
  userId: string
  subscriptionId: string
  form: ReturnType<typeof parseWebhookUpdateForm>
  now?: Date
}) {
  validateUpdateForm(input.form)
  const now = input.now ?? new Date()
  const existing = await getWebhookSubscriptionForUser(input.env.DB, input.userId, input.subscriptionId)
  if (!existing) throw new ApiError('NOT_FOUND', 'Webhook subscription not found', 404)
  const resetsDeliveryState = shouldResetDeliveryState(existing, input.form)
  const nextRunAt = resetsDeliveryState
    ? nextScheduledRunAt({
        now,
        timezone: input.form.timezone,
        scheduleTimesLocal: input.form.scheduleTimesLocal,
        scheduleWeekdays: input.form.scheduleWeekdays
      })
    : null
  const resetFlag = resetsDeliveryState ? 1 : 0

  await input.env.DB
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          name = ?,
          timezone = ?,
          schedule_time_local = ?,
          schedule_times_local = ?,
          schedule_weekdays = ?,
          send_empty_report = ?,
          enabled = ?,
          next_run_at = CASE WHEN ? = 1 THEN ? ELSE next_run_at END,
          pending_report_date = CASE WHEN ? = 1 THEN NULL ELSE pending_report_date END,
          pending_schedule_slot = CASE WHEN ? = 1 THEN NULL ELSE pending_schedule_slot END,
          locked_until = CASE WHEN ? = 1 THEN NULL ELSE locked_until END,
          locked_at = CASE WHEN ? = 1 THEN NULL ELSE locked_at END,
          failure_count = CASE WHEN ? = 1 THEN 0 ELSE failure_count END,
          updated_at = ?
        WHERE user_id = ?
          AND id = ?
      `
    )
    .bind(
      input.form.name,
      input.form.timezone,
      input.form.scheduleTimeLocal,
      input.form.scheduleTimesLocal.join(','),
      input.form.scheduleWeekdays.join(','),
      input.form.sendEmptyReport ? 1 : 0,
      input.form.enabled ? 1 : 0,
      resetFlag,
      nextRunAt,
      resetFlag,
      resetFlag,
      resetFlag,
      resetFlag,
      resetFlag,
      now.toISOString(),
      input.userId,
      input.subscriptionId
    )
    .run()
}

export async function setWebhookSubscriptionEnabled(input: {
  db: D1Database
  userId: string
  subscriptionId: string
  enabled: boolean
  now?: Date
}) {
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  const existing = input.enabled
    ? await getWebhookSubscriptionForUser(input.db, input.userId, input.subscriptionId)
    : null
  if (input.enabled && !existing) {
    throw new ApiError('NOT_FOUND', 'Webhook subscription not found', 404)
  }
  await input.db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          enabled = ?,
          next_run_at = CASE WHEN ? = 1 THEN ? ELSE next_run_at END,
          pending_report_date = NULL,
          pending_schedule_slot = NULL,
          locked_until = NULL,
          locked_at = NULL,
          failure_count = CASE WHEN ? = 1 THEN 0 ELSE failure_count END,
          last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END,
          updated_at = ?
        WHERE user_id = ?
          AND id = ?
      `
    )
    .bind(
      input.enabled ? 1 : 0,
      input.enabled ? 1 : 0,
      existing ? nextScheduledRunAt({
        now,
        timezone: existing.timezone,
        scheduleTimesLocal: existing.scheduleTimesLocal,
        scheduleWeekdays: existing.scheduleWeekdays
      }) : null,
      input.enabled ? 1 : 0,
      input.enabled ? 1 : 0,
      nowIso,
      input.userId,
      input.subscriptionId
    )
    .run()
}

export async function deleteWebhookSubscription(input: {
  db: D1Database
  userId: string
  subscriptionId: string
}) {
  await input.db
    .prepare('DELETE FROM webhook_subscriptions WHERE user_id = ? AND id = ?')
    .bind(input.userId, input.subscriptionId)
    .run()
}

function validateUpdateForm(form: ReturnType<typeof parseWebhookUpdateForm>) {
  if (form.name.length < 1 || form.name.length > 80) {
    throw new ApiError('BAD_REQUEST', 'Invalid webhook name', 400)
  }
  if (form.scheduleTimesLocal.length < 1) {
    throw new ApiError('BAD_REQUEST', 'Invalid schedule time', 400)
  }
  if (!isValidTimezone(form.timezone)) {
    throw new ApiError('BAD_REQUEST', 'Invalid timezone', 400)
  }
}

function shouldResetDeliveryState(
  existing: WebhookSubscriptionSummary,
  form: ReturnType<typeof parseWebhookUpdateForm>
) {
  return existing.enabled !== form.enabled
    || existing.timezone !== form.timezone
    || !sameStringList(existing.scheduleTimesLocal, form.scheduleTimesLocal)
    || !sameNumberList(existing.scheduleWeekdays, form.scheduleWeekdays)
}

function sameStringList(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameNumberList(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function parseWebhookFormOrThrow<T>(parser: () => T) {
  try {
    return parser()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid schedule')) {
      throw new ApiError('BAD_REQUEST', error.message, 400)
    }
    throw error
  }
}
