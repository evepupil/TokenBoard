import { randomId } from '../../lib/crypto'
import { insertDeliveryLog, prepareDeliveryLog, type DueWebhookSubscription } from './queries'
import {
  assertBatchSucceeded,
  assertClaimedUpdate,
  nextRunAfterClearedPending,
  nextRunAfterFailure
} from './delivery-state/helpers'

type DeliveryKind = 'daily' | 'test'

const maxAttempts = 3
const successPersistenceAttempts = 3

export async function recordDeliverySuccess(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  kind: DeliveryKind
  now: Date
  reportDate: string
  scheduleSlot: string | null
  attempt: number
  httpStatus: number
  durationMs: number
}) {
  if (input.kind !== 'daily') {
    await insertDeliveryLog(successDeliveryLogInput(input))
    await markSubscriptionTestSuccess(input.db, input.subscription, input.now)
    return { complete: true }
  }

  const errors: unknown[] = []
  for (let attempt = 1; attempt <= successPersistenceAttempts; attempt += 1) {
    try {
      const results = await input.db.batch([
        prepareDeliveryLog(successDeliveryLogInput(input)),
        prepareSubscriptionSuccess(input.db, input.subscription, input.now, input.scheduleSlot)
      ])
      assertBatchSucceeded(results)
      assertClaimedUpdate(results[1])
      return { complete: true }
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length === 1) throw errors[0]
  throw new AggregateError(errors, 'Failed to persist webhook delivery success')
}

function successDeliveryLogInput(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  kind: DeliveryKind
  now: Date
  reportDate: string
  scheduleSlot: string | null
  attempt: number
  httpStatus: number
  durationMs: number
}) {
  return {
    db: input.db,
    id: randomId('whl'),
    subscriptionId: input.subscription.id,
    userId: input.subscription.userId,
    reportDate: input.reportDate,
    scheduleSlot: input.scheduleSlot,
    kind: input.kind,
    status: 'success' as const,
    httpStatus: input.httpStatus,
    attempt: input.attempt,
    durationMs: input.durationMs,
    createdAt: input.now.toISOString(),
    ignoreDuplicateDailySuccess: input.kind === 'daily'
  }
}

export async function recordDeliveryFailure(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  kind: DeliveryKind
  reportDate: string
  scheduleSlot: string | null
  attempt: number
  error: string
  httpStatus: number | null
  durationMs: number
  now: Date
}) {
  await insertDeliveryLog({
    db: input.db,
    id: randomId('whl'),
    subscriptionId: input.subscription.id,
    userId: input.subscription.userId,
    reportDate: input.reportDate,
    scheduleSlot: input.scheduleSlot,
    kind: input.kind,
    status: 'failure',
    httpStatus: input.httpStatus,
    attempt: input.attempt,
    error: input.error,
    durationMs: input.durationMs,
    createdAt: input.now.toISOString()
  })

  if (input.kind === 'daily') {
    await markSubscriptionFailure(input)
  } else {
    await markSubscriptionTestFailure(input)
  }
}

export async function markSubscriptionSkipped(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  now: Date
  reportDate: string
  scheduleSlot: string | null
  reason: string
}) {
  await insertDeliveryLog({
    db: input.db,
    id: randomId('whl'),
    subscriptionId: input.subscription.id,
    userId: input.subscription.userId,
    reportDate: input.reportDate,
    scheduleSlot: input.scheduleSlot,
    kind: 'daily',
    status: 'skipped',
    attempt: input.subscription.failureCount + 1,
    error: input.reason,
    durationMs: 0,
    createdAt: input.now.toISOString()
  })
  await markSubscriptionSkippedState(input.db, input.subscription, input.now, input.scheduleSlot)
}

async function markSubscriptionFailure(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  reportDate: string
  scheduleSlot: string | null
  attempt: number
  error: string
  now: Date
}) {
  const shouldRetry = input.attempt < maxAttempts
  const result = await input.db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          next_run_at = ?,
          pending_report_date = ?,
          pending_schedule_slot = ?,
          locked_until = NULL,
          locked_at = NULL,
          failure_count = ?,
          last_failure_at = ?,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
          AND locked_at = ?
      `
    )
    .bind(
      nextRunAfterFailure(input, shouldRetry),
      shouldRetry ? input.reportDate : null,
      shouldRetry ? input.subscription.pendingScheduleSlot ?? input.scheduleSlot : null,
      shouldRetry ? input.attempt : 0,
      input.now.toISOString(),
      input.error,
      input.now.toISOString(),
      input.subscription.id,
      input.subscription.lockedAt
    )
    .run()
  assertClaimedUpdate(result)
}

function prepareSubscriptionSuccess(
  db: D1Database,
  subscription: DueWebhookSubscription,
  now: Date,
  scheduleSlot: string | null
) {
  return db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          next_run_at = ?,
          pending_report_date = NULL,
          pending_schedule_slot = NULL,
          locked_until = NULL,
          locked_at = NULL,
          failure_count = 0,
          last_success_at = ?,
          last_error = NULL,
          updated_at = ?
        WHERE id = ?
          AND locked_at = ?
      `
    )
    .bind(
      nextRunAfterClearedPending(subscription, now, scheduleSlot),
      now.toISOString(),
      now.toISOString(),
      subscription.id,
      subscription.lockedAt
    )
}

async function markSubscriptionSkippedState(
  db: D1Database,
  subscription: DueWebhookSubscription,
  now: Date,
  scheduleSlot: string | null
) {
  const result = await db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          next_run_at = ?,
          pending_report_date = NULL,
          pending_schedule_slot = NULL,
          locked_until = NULL,
          locked_at = NULL,
          failure_count = 0,
          last_error = NULL,
          updated_at = ?
        WHERE id = ?
          AND locked_at = ?
      `
    )
    .bind(
      nextRunAfterClearedPending(subscription, now, scheduleSlot),
      now.toISOString(),
      subscription.id,
      subscription.lockedAt
    )
    .run()
  assertClaimedUpdate(result)
}

async function markSubscriptionTestFailure(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  error: string
  now: Date
}) {
  await input.db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          last_failure_at = ?,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
      `
    )
    .bind(
      input.now.toISOString(),
      input.error,
      input.now.toISOString(),
      input.subscription.id
    )
    .run()
}

async function markSubscriptionTestSuccess(
  db: D1Database,
  subscription: DueWebhookSubscription,
  now: Date
) {
  await db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          last_success_at = ?,
          last_error = NULL,
          updated_at = ?
        WHERE id = ?
      `
    )
    .bind(now.toISOString(), now.toISOString(), subscription.id)
    .run()
}
