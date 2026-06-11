import type { DueWebhookSubscription } from '../queries'
import { nextScheduledRunAt, zonedTimeToUtc } from '../time'

const retryDelayMinutes = [5, 30]

export function nextRunAfterClearedPending(
  subscription: DueWebhookSubscription,
  now: Date,
  scheduleSlot: string | null
) {
  if (subscription.pendingScheduleSlot && subscription.failureCount === 0) {
    return subscription.nextRunAt
  }
  return nextScheduledRunAt({
    now: scheduledSlotDate(subscription, scheduleSlot) ?? now,
    timezone: subscription.timezone,
    scheduleTimesLocal: subscription.scheduleTimesLocal,
    scheduleWeekdays: subscription.scheduleWeekdays
  })
}

export function nextRunAfterFailure(input: {
  subscription: DueWebhookSubscription
  scheduleSlot: string | null
  attempt: number
  now: Date
}, shouldRetry: boolean) {
  if (shouldRetry) {
    return addMinutes(
      input.now,
      retryDelayMinutes[input.attempt - 1] ?? retryDelayMinutes.at(-1) ?? 30
    ).toISOString()
  }
  return nextScheduledRunAt({
    now: scheduledSlotDate(input.subscription, input.scheduleSlot) ?? input.now,
    timezone: input.subscription.timezone,
    scheduleTimesLocal: input.subscription.scheduleTimesLocal,
    scheduleWeekdays: input.subscription.scheduleWeekdays
  })
}

export function assertBatchSucceeded(results: D1Result<unknown>[]) {
  const batchResults = results as Array<{ success?: boolean; error?: string }>
  const failedIndex = batchResults.findIndex((result) => result.success === false)
  if (failedIndex < 0) return

  const error = batchResults[failedIndex]?.error
  throw new Error(
    `D1 batch statement ${failedIndex + 1} failed${error ? `: ${error}` : ''}`
  )
}

export function assertClaimedUpdate(result: D1Result<unknown>) {
  if (Number(result.meta?.changes ?? 0) <= 0) {
    throw new Error('Webhook subscription claim is no longer current')
  }
}

function scheduledSlotDate(subscription: DueWebhookSubscription, scheduleSlot: string | null) {
  if (!scheduleSlot) return null
  const match = scheduleSlot.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/)
  if (!match) return null
  return zonedTimeToUtc(match[1], match[2], subscription.timezone)
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000)
}
