import type { DailyTokenReport } from './adapters'
import type { WebhookEnv } from './config'
import { errorMessage } from './delivery-helpers'
import type { DueWebhookSubscription } from './queries'
import {
  prepareDailyReportHistoryShare,
  pruneExpiredDailyReportHistory,
  saveDailyReportHistory
} from './report-history'

async function persistDailyReportHistory(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  report: DailyTokenReport
  scheduleSlot: string
  now: Date
  id?: string
}) {
  return saveDailyReportHistory({
    db: input.env.DB,
    userId: input.subscription.userId,
    report: input.report,
    scheduleSlot: input.scheduleSlot,
    generatedAt: input.now,
    id: input.id,
    origin: input.env.BETTER_AUTH_URL
  })
}

export async function prepareDailyReportHistoryForDelivery(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  report: DailyTokenReport
  scheduleSlot: string
  now: Date
  id?: string
}) {
  return prepareDailyReportHistoryShare({
    db: input.env.DB,
    userId: input.subscription.userId,
    report: input.report,
    scheduleSlot: input.scheduleSlot,
    generatedAt: input.now,
    id: input.id,
    origin: input.env.BETTER_AUTH_URL
  })
}

export type DailyReportHistoryShare = Awaited<ReturnType<typeof prepareDailyReportHistoryForDelivery>>

export function persistDeliveredDailyReportHistory(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  report: DailyTokenReport
  scheduleSlot: string
  now: Date
  share: DailyReportHistoryShare
}) {
  return persistDailyReportHistory({
    env: input.env,
    subscription: input.subscription,
    report: input.report,
    scheduleSlot: input.scheduleSlot,
    now: input.now,
    id: input.share.id
  })
}

function pruneDailyReportHistory(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  report: DailyTokenReport
  retentionDays: number
}) {
  return pruneExpiredDailyReportHistory({
    db: input.env.DB,
    userId: input.subscription.userId,
    reportDate: input.report.reportDate,
    retentionDays: input.retentionDays
  })
}

function deleteDailyReportHistoryShare(input: {
  env: WebhookEnv
  userId: string
  id: string
}) {
  return input.env.DB
    .prepare(
      `
        DELETE FROM daily_report_history
        WHERE user_id = ?
          AND id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM webhook_delivery_logs
            WHERE webhook_delivery_logs.user_id = daily_report_history.user_id
              AND webhook_delivery_logs.report_date = daily_report_history.report_date
              AND webhook_delivery_logs.schedule_slot = daily_report_history.schedule_slot
              AND webhook_delivery_logs.kind = 'daily'
              AND webhook_delivery_logs.status = 'success'
          )
      `
    )
    .bind(input.userId, input.id)
    .run()
}

function canShareDailyReportLink(
  subscription: Pick<DueWebhookSubscription, 'dailyReportShareEnabled'>,
  share: { shareRevokedAt?: string | null }
) {
  return subscription.dailyReportShareEnabled && !share.shareRevokedAt
}

export function canSendDailyReportLink(
  subscription: Pick<DueWebhookSubscription, 'dailyReportShareEnabled'>,
  share: { reportUrl: string; shareRevokedAt?: string | null }
) {
  return canShareDailyReportLink(subscription, share) && isAbsoluteHttpsUrl(share.reportUrl)
}

export async function cleanupNewDailyReportHistoryShare(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  share: DailyReportHistoryShare | null
}) {
  if (!input.share?.isNew) return
  try {
    await deleteDailyReportHistoryShare({
      env: input.env,
      userId: input.subscription.userId,
      id: input.share.id
    })
  } catch (error) {
    console.error(`TokenBoard daily report history cleanup failed for subscription ${input.subscription.id}: ${errorMessage(error)}`)
  }
}

export async function pruneDailyReportHistoryAfterDelivery(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  report: DailyTokenReport
  retentionDays: number
}) {
  try {
    await pruneDailyReportHistory(input)
  } catch (error) {
    console.error(`TokenBoard daily report history prune failed for subscription ${input.subscription.id}: ${errorMessage(error)}`)
  }
}

function isAbsoluteHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:'
  } catch (_) {
    return false
  }
}
