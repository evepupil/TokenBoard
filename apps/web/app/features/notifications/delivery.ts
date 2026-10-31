import { ApiError } from '../../lib/errors'
import {
  publicLeaderboardUrl,
  shouldPruneWebhookDeliveryLogs,
  webhookCronBatchSize,
  webhookLogRetentionDays,
  type WebhookEnv
} from './config'
import { recordDeliveryFailure, recordDeliverySuccess } from './delivery-state'
import {
  getWebhookSubscriptionForUser,
  listDueWebhookSubscriptions,
  pruneWebhookDeliveryLogs,
  type DueWebhookSubscription
} from './queries'
import { getDailyTokenReport } from './report-queries'
import { dailyReportHistoryRetentionDays, pruneExpiredDailyReportHistoryForAllUsers } from './report-history'
import {
  canSendDailyReportLink,
  cleanupNewDailyReportHistoryShare,
  prepareDailyReportHistoryForDelivery,
  persistDeliveredDailyReportHistory,
  pruneDailyReportHistoryAfterDelivery,
  type DailyReportHistoryShare
} from './report-history-delivery'
import { usageSummaryStrictMode } from '../usage/deduped-daily-usage'
import { deliveryHttpStatus, sendWebhookRequest } from './webhook-client'
import type { DailyTokenReport } from './adapters'
import {
  claimDueSubscription,
  errorMessage,
  incrementCounts,
  LocalDeliveryStateError,
  markSkippedOrThrow,
  reportDateForDelivery,
  safeWebhookErrorMessage,
  scheduleSlotForDelivery,
  shouldSkipAlreadyDelivered,
  type DeliveryStatus
} from './delivery-helpers'
import type {
  CheckedDeliveryInput,
  DeliverSubscriptionInput,
  Fetcher,
  ReportHistoryDeliveryState
} from './delivery-types'

const defaultWebhookFetcher: Fetcher = (url, init) => globalThis.fetch.call(globalThis, url, init)
const testReportHistoryScheduleSlot = 'test-preview'

class SuccessfulDeliveryPersistenceError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error))
    this.name = 'SuccessfulDeliveryPersistenceError'
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
    fetcher: input.fetcher ?? defaultWebhookFetcher
  })
}

export async function runDueWebhookNotifications(input: {
  env: WebhookEnv
  now?: Date
  limit?: number
  fetcher?: Fetcher
}) {
  const now = input.now ?? new Date()
  const due = await listDueWebhookSubscriptions(
    input.env.DB,
    now.toISOString(),
    input.limit ?? webhookCronBatchSize(input.env)
  )
  const counts = { checked: due.length, sent: 0, failed: 0, skipped: 0 }
  const fetcher = input.fetcher ?? defaultWebhookFetcher

  if (shouldPruneWebhookDeliveryLogs(now)) {
    // Retention is housekeeping; a failed DELETE must not stop this tick's deliveries. The
    // report-history prune below is isolated for the same reason, and a stalled delivery-log
    // table is bounded by the same window that lets it fail once and retry on the next tick.
    try {
      await pruneDeliveryLogs(input.env, now)
    } catch (error) {
      console.error(`TokenBoard webhook delivery log prune failed: ${errorMessage(error)}`)
    }
    // Report history is pruned here as well as after each delivery: a user who disables their
    // webhook stops delivering, and the retention the settings card promises has to hold either
    // way. The gate only runs at 00:00 UTC, when a user west of UTC is still on the previous local
    // day and their per-delivery prune is anchored a day behind this cron's `now`. Passing the UTC
    // day itself would advance the cutoff past that anchor and drop the oldest row one day before
    // their window closes; the previous UTC day is a date no user is ahead of, so a row still
    // inside the window in any timezone is never dropped.
    try {
      await pruneExpiredDailyReportHistoryForAllUsers({
        db: input.env.DB,
        referenceDate: previousUtcIsoDate(now),
        retentionDays: dailyReportHistoryRetentionDays(input.env)
      })
    } catch (error) {
      console.error(`TokenBoard daily report history prune failed: ${errorMessage(error)}`)
    }
  }

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

// The gate that calls this only fires at 00:00 UTC, so the day behind `now` is a date no
// user is ahead of — west-of-UTC users are still on it, and their per-delivery prune is
// anchored there.
function previousUtcIsoDate(now: Date) {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)
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
  console.error(
    `TokenBoard webhook success persistence failed for subscription ${subscription.id}: ${errorMessage(error)}`
  )
}

async function deliverSubscription(input: DeliverSubscriptionInput) {
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
      error: safeWebhookErrorMessage(error),
      httpStatus: deliveryHttpStatus(error),
      durationMs: Date.now() - startedAt,
      now: input.now
    })
    return { status: 'failure' as const }
  }
}

async function deliverSubscriptionChecked(input: CheckedDeliveryInput): Promise<DeliveryStatus> {
  if (await shouldSkipAlreadyDelivered(input)) return 'skipped'
  const report = await reportForDelivery(input)
  if (input.kind === 'daily' && report.totalTokens <= 0 && !input.subscription.sendEmptyReport) {
    await markSkippedOrThrow(input, 'Empty report')
    return 'skipped'
  }

  const reportHistory = await prepareReportHistoryForDelivery(input, report)
  const response = await sendReportOrCleanup(input, report, reportHistory.share)
  await recordSuccessOrThrow(input, report, reportHistory, response)
  return 'success'
}

async function reportForDelivery(input: CheckedDeliveryInput) {
  const report = await getDailyTokenReport({
    db: input.env.DB,
    userId: input.subscription.userId,
    displayName: input.subscription.displayName,
    reportDate: input.reportDate,
    timezone: input.subscription.timezone,
    dashboardUrl: publicLeaderboardUrl(input.env),
    summaryStrict: usageSummaryStrictMode(input.env)
  })
  if (input.kind === 'test') {
    report.previewLabel = '测试预览'
  }
  return report
}

async function prepareReportHistoryForDelivery(
  input: CheckedDeliveryInput,
  report: DailyTokenReport
): Promise<ReportHistoryDeliveryState> {
  const scheduleSlot = reportHistoryScheduleSlot(input)
  const retentionDays = scheduleSlot ? dailyReportHistoryRetentionDays(input.env) : 0
  const share = scheduleSlot
    ? await prepareDailyReportHistoryForDelivery({
        env: input.env,
        subscription: input.subscription,
        report,
        scheduleSlot,
        now: input.now
      })
    : null
  if (share && canSendDailyReportLink(input.subscription, share)) {
    report.reportUrl = share.reportUrl
  }
  return { retentionDays, share }
}

function reportHistoryScheduleSlot(input: CheckedDeliveryInput) {
  if (input.kind === 'daily') return input.scheduleSlot
  return input.subscription.dailyReportShareEnabled ? testReportHistoryScheduleSlot : null
}

async function sendReportOrCleanup(
  input: CheckedDeliveryInput,
  report: DailyTokenReport,
  reportHistoryShare: DailyReportHistoryShare | null
) {
  try {
    return await sendWebhookRequest({ ...input, report })
  } catch (error) {
    await cleanupNewDailyReportHistoryShare({
      env: input.env,
      subscription: input.subscription,
      share: reportHistoryShare
    })
    throw error
  }
}

async function recordSuccessOrThrow(
  input: CheckedDeliveryInput,
  report: DailyTokenReport,
  reportHistory: ReportHistoryDeliveryState,
  response: Awaited<ReturnType<typeof sendWebhookRequest>>
) {
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
      if (!input.scheduleSlot || !reportHistory.share) throw new Error('Missing webhook schedule slot')
      await persistDeliveredDailyReportHistory({
        env: input.env,
        subscription: input.subscription,
        report,
        scheduleSlot: input.scheduleSlot,
        now: input.now,
        share: reportHistory.share
      })
      await pruneDailyReportHistoryAfterDelivery({
        env: input.env,
        subscription: input.subscription,
        report,
        retentionDays: reportHistory.retentionDays
      })
    }
  } catch (error) {
    logSuccessfulDeliveryPersistenceFailure(input.subscription, error)
    throw new SuccessfulDeliveryPersistenceError(error)
  }
}
