import { ApiError } from '../../lib/errors'
import { dashboardUrl, webhookLogRetentionDays, type WebhookEnv } from './config'
import {
  recordDeliveryFailure,
  recordDeliverySuccess,
  markSubscriptionSkipped
} from './delivery-state'
import {
  claimWebhookSubscription,
  getWebhookSubscriptionForUser,
  hasSuccessfulDailyDelivery,
  listDueWebhookSubscriptions,
  pruneWebhookDeliveryLogs,
  type DueWebhookSubscription
} from './queries'
import { getDailyTokenReport } from './report-queries'
import { dailyReportHistoryRetentionDays, persistDailyReportHistory } from './report-history-delivery'
import { localDateInTimezone, localTimeInTimezone } from './time'
import { deliveryHttpStatus, sendWebhookRequest } from './webhook-client'

type Fetcher = typeof fetch
type DeliveryKind = 'daily' | 'test'
type DeliveryStatus = 'success' | 'failure' | 'skipped'

const maxCronBatchSize = 50
const lockLeaseMinutes = 10

class SuccessfulDeliveryPersistenceError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error))
    this.name = 'SuccessfulDeliveryPersistenceError'
  }
}

class LocalDeliveryStateError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error))
    this.name = 'LocalDeliveryStateError'
  }
}

export async function sendWebhookTest(input: {
  env: WebhookEnv
  userId: string
  subscriptionId: string
  now?: Date
  fetcher?: Fetcher
}) {
  const subscription = await getWebhookSubscriptionForUser(input.env.DB, input.userId, input.subscriptionId)
  if (!subscription) throw new ApiError('NOT_FOUND', 'Webhook subscription not found', 404)

  return deliverSubscription({
    env: input.env,
    subscription,
    kind: 'test',
    now: input.now ?? new Date(),
    fetcher: input.fetcher ?? fetch
  })
}

export async function runDueWebhookNotifications(input: {
  env: WebhookEnv
  now?: Date
  limit?: number
  fetcher?: Fetcher
}) {
  const now = input.now ?? new Date()
  const due = await listDueWebhookSubscriptions(input.env.DB, now.toISOString(), input.limit ?? maxCronBatchSize)
  const counts = { checked: due.length, sent: 0, failed: 0, skipped: 0 }
  const fetcher = input.fetcher ?? fetch

  await pruneDeliveryLogs(input.env, now)

  for (const subscription of due) {
    try {
      const status = await processDueSubscription({
        env: input.env,
        subscription,
        now,
        fetcher
      })
      incrementCounts(counts, status)
    } catch (error) {
      counts.failed += 1
      logCronSubscriptionFailure(subscription, error)
    }
  }

  return counts
}

async function pruneDeliveryLogs(env: WebhookEnv, now: Date) {
  const retentionDays = webhookLogRetentionDays(env)
  const cutoff = new Date(now)
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)
  await pruneWebhookDeliveryLogs({
    db: env.DB,
    cutoffIso: cutoff.toISOString()
  })
}

async function processDueSubscription(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  now: Date
  fetcher: Fetcher
}): Promise<DeliveryStatus> {
  const claimed = await claimDueSubscription(input.env.DB, input.subscription, input.now)
  if (!claimed) return 'skipped'
  const subscription = { ...input.subscription, lockedAt: input.now.toISOString() }

  const result = await deliverSubscription({
    env: input.env,
    subscription,
    kind: 'daily',
    now: input.now,
    fetcher: input.fetcher
  })
  return result.status
}

function logCronSubscriptionFailure(subscription: DueWebhookSubscription, error: unknown) {
  console.error(`TokenBoard webhook cron failed for subscription ${subscription.id}: ${errorMessage(error)}`)
}

function logSuccessfulDeliveryPersistenceFailure(subscription: DueWebhookSubscription, error: unknown) {
  console.error(`TokenBoard webhook success persistence failed for subscription ${subscription.id}: ${errorMessage(error)}`)
}

async function claimDueSubscription(db: D1Database, subscription: DueWebhookSubscription, now: Date) {
  return claimWebhookSubscription({
    db,
    subscriptionId: subscription.id,
    nowIso: now.toISOString(),
    lockedUntilIso: addMinutes(now, lockLeaseMinutes).toISOString()
  })
}

async function deliverSubscription(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  kind: DeliveryKind
  now: Date
  fetcher: Fetcher
}) {
  const startedAt = Date.now()
  const reportDate = reportDateForDelivery(input.kind, input.subscription, input.now)
  const scheduleSlot = scheduleSlotForDelivery(input.kind, input.subscription, reportDate)
  const attempt = input.kind === 'daily' ? input.subscription.failureCount + 1 : 1

  try {
    const status = await deliverSubscriptionChecked({ ...input, reportDate, scheduleSlot, attempt, startedAt })
    return { status }
  } catch (error) {
    if (error instanceof SuccessfulDeliveryPersistenceError || error instanceof LocalDeliveryStateError) {
      throw error
    }
    await recordDeliveryFailure({
      db: input.env.DB,
      subscription: input.subscription,
      kind: input.kind,
      reportDate,
      scheduleSlot,
      attempt,
      error: errorMessage(error),
      httpStatus: deliveryHttpStatus(error),
      durationMs: Date.now() - startedAt,
      now: input.now
    })
    return { status: 'failure' as const }
  }
}

async function deliverSubscriptionChecked(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  kind: DeliveryKind
  now: Date
  fetcher: Fetcher
  reportDate: string
  scheduleSlot: string | null
  attempt: number
  startedAt: number
}): Promise<DeliveryStatus> {
  if (await shouldSkipAlreadyDelivered(input)) return 'skipped'
  const report = await getDailyTokenReport({
    db: input.env.DB,
    userId: input.subscription.userId,
    displayName: input.subscription.displayName,
    reportDate: input.reportDate,
    timezone: input.subscription.timezone,
    dashboardUrl: dashboardUrl(input.env)
  })
  if (input.kind === 'test') {
    report.previewLabel = '测试预览'
  }
  if (input.kind === 'daily' && report.totalTokens <= 0 && !input.subscription.sendEmptyReport) {
    await markSkippedOrThrow(input, 'Empty report')
    return 'skipped'
  }

  const reportHistoryRetentionDays = input.kind === 'daily'
    ? dailyReportHistoryRetentionDays(input.env)
    : 0
  const response = await sendWebhookRequest({ ...input, report })
  try {
    const persistence = await recordDeliverySuccess({
      db: input.env.DB,
      subscription: input.subscription,
      kind: input.kind,
      now: input.now,
      reportDate: input.reportDate,
      scheduleSlot: input.scheduleSlot,
      attempt: input.attempt,
      httpStatus: response.status,
      durationMs: Date.now() - input.startedAt
    })
    if (!persistence.complete) {
      logSuccessfulDeliveryPersistenceFailure(
        input.subscription,
        new Error('Webhook delivery success was only partially persisted')
      )
    }
    if (input.kind === 'daily') {
      if (!input.scheduleSlot) throw new Error('Missing webhook schedule slot')
      await persistDailyReportHistory({
        env: input.env,
        subscription: input.subscription,
        report,
        scheduleSlot: input.scheduleSlot,
        now: input.now,
        retentionDays: reportHistoryRetentionDays
      })
    }
  } catch (error) {
    logSuccessfulDeliveryPersistenceFailure(input.subscription, error)
    throw new SuccessfulDeliveryPersistenceError(error)
  }
  return 'success'
}

async function shouldSkipAlreadyDelivered(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  kind: DeliveryKind
  now: Date
  reportDate: string
  scheduleSlot: string | null
}) {
  if (input.kind !== 'daily') return false
  if (!input.scheduleSlot) throw new Error('Missing webhook schedule slot')
  const delivered = await hasSuccessfulDailyDelivery({
    db: input.env.DB,
    subscriptionId: input.subscription.id,
    reportDate: input.reportDate,
    scheduleSlot: input.scheduleSlot
  })
  if (!delivered) return false
  await markSkippedOrThrow(input, 'Already delivered')
  return true
}

async function markSkippedOrThrow(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  now: Date
  reportDate: string
  scheduleSlot: string | null
}, reason: string) {
  try {
    await markSubscriptionSkipped({
      db: input.env.DB,
      subscription: input.subscription,
      now: input.now,
      reportDate: input.reportDate,
      scheduleSlot: input.scheduleSlot,
      reason
    })
  } catch (error) {
    throw new LocalDeliveryStateError(error)
  }
}

function reportDateForDelivery(kind: DeliveryKind, subscription: DueWebhookSubscription, now: Date) {
  if (kind === 'daily') {
    return subscription.pendingReportDate ?? localDateInTimezone(new Date(subscription.nextRunAt), subscription.timezone)
  }
  return localDateInTimezone(now, subscription.timezone)
}

function scheduleSlotForDelivery(
  kind: DeliveryKind,
  subscription: DueWebhookSubscription,
  reportDate: string
) {
  if (kind !== 'daily') return null
  return subscription.pendingScheduleSlot ??
    `${reportDate}T${localTimeInTimezone(new Date(subscription.nextRunAt), subscription.timezone)}`
}

function incrementCounts(
  counts: { sent: number; failed: number; skipped: number },
  status: DeliveryStatus
) {
  if (status === 'success') counts.sent += 1
  if (status === 'failure') counts.failed += 1
  if (status === 'skipped') counts.skipped += 1
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000)
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 500)
  return String(error).slice(0, 500)
}
