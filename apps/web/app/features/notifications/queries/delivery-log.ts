import type { DeliveryLogInput } from './types'

export async function hasSuccessfulDailyDelivery(input: {
  db: D1Database
  subscriptionId: string
  reportDate: string
  scheduleSlot: string
}) {
  const row = await input.db
    .prepare(
      `
        SELECT id
        FROM webhook_delivery_logs
        WHERE subscription_id = ?
          AND report_date = ?
          AND schedule_slot = ?
          AND kind = 'daily'
          AND status = 'success'
        LIMIT 1
      `
    )
    .bind(input.subscriptionId, input.reportDate, input.scheduleSlot)
    .first<{ id: string }>()

  return Boolean(row)
}

export async function insertDeliveryLog(input: DeliveryLogInput) {
  await prepareDeliveryLog(input).run()
}

export function prepareDeliveryLog(input: DeliveryLogInput) {
  return input.db
    .prepare(
      `
        INSERT INTO webhook_delivery_logs (
          id,
          subscription_id,
          user_id,
          report_date,
          schedule_slot,
          kind,
          status,
          http_status,
          attempt,
          error,
          duration_ms,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ${input.ignoreDuplicateDailySuccess ? "ON CONFLICT(subscription_id, report_date, kind, schedule_slot) WHERE status = 'success' AND kind = 'daily' AND schedule_slot IS NOT NULL DO NOTHING" : ''}
      `
    )
    .bind(
      input.id,
      input.subscriptionId,
      input.userId,
      input.reportDate,
      input.scheduleSlot ?? null,
      input.kind,
      input.status,
      input.httpStatus ?? null,
      input.attempt,
      input.error ?? null,
      input.durationMs,
      input.createdAt
    )
}

export async function pruneWebhookDeliveryLogs(input: {
  db: D1Database
  cutoffIso: string
}) {
  await input.db
    .prepare('DELETE FROM webhook_delivery_logs WHERE created_at < ?')
    .bind(input.cutoffIso)
    .run()
}
