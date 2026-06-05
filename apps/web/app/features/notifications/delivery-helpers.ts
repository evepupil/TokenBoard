import type { WebhookEnv } from './config'
import { markSubscriptionSkipped } from './delivery-state'
import {
  claimWebhookSubscription,
  hasSuccessfulDailyDelivery,
  type DueWebhookSubscription
} from './queries'
import { localDateInTimezone, localTimeInTimezone } from './time'

export type DeliveryKind = 'daily' | 'test'
export type DeliveryStatus = 'success' | 'failure' | 'skipped'

const lockLeaseMinutes = 10

export class LocalDeliveryStateError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error))
    this.name = 'LocalDeliveryStateError'
  }
}

export async function claimDueSubscription(db: D1Database, subscription: DueWebhookSubscription, now: Date) {
  return claimWebhookSubscription({
    db,
    subscriptionId: subscription.id,
    nowIso: now.toISOString(),
    lockedUntilIso: addMinutes(now, lockLeaseMinutes).toISOString()
  })
}

export async function shouldSkipAlreadyDelivered(input: {
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

export async function markSkippedOrThrow(input: {
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

export function reportDateForDelivery(kind: DeliveryKind, subscription: DueWebhookSubscription, now: Date) {
  if (kind === 'daily') {
    return subscription.pendingReportDate ?? localDateInTimezone(new Date(subscription.nextRunAt), subscription.timezone)
  }
  return localDateInTimezone(now, subscription.timezone)
}

export function scheduleSlotForDelivery(
  kind: DeliveryKind,
  subscription: DueWebhookSubscription,
  reportDate: string
) {
  if (kind !== 'daily') return null
  return subscription.pendingScheduleSlot ??
    `${reportDate}T${localTimeInTimezone(new Date(subscription.nextRunAt), subscription.timezone)}`
}

export function incrementCounts(
  counts: { sent: number; failed: number; skipped: number },
  status: DeliveryStatus
) {
  if (status === 'success') counts.sent += 1
  if (status === 'failure') counts.failed += 1
  if (status === 'skipped') counts.skipped += 1
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 500)
  return String(error).slice(0, 500)
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000)
}
