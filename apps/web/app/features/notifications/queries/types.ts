import type { ClaimedWebhookSubscription, WebhookSubscriptionSummary } from '../schema'

export type WebhookSubscriptionRow = Omit<
  WebhookSubscriptionSummary,
  'provider' | 'scheduleTimesLocal' | 'scheduleWeekdays'
> & {
  provider: string
  scheduleTimesLocal?: string | string[] | null
  scheduleWeekdays?: string | number[] | null
}

export type WebhookSubscriptionSecretRow = ClaimedWebhookSubscription & {
  userId: string
  displayName: string
  webhookUrlEncrypted: string
  signingSecretEncrypted: string | null
}

export type WebhookSubscriptionSecretDbRow = WebhookSubscriptionRow & {
  userId: string
  displayName: string
  dailyReportShareEnabled?: number | boolean | null
  webhookUrlEncrypted: string
  signingSecretEncrypted: string | null
  lockedAt: string | null
}

export type DueWebhookSubscription = WebhookSubscriptionSecretRow

export type DeliveryLogInput = {
  db: D1Database
  id: string
  subscriptionId: string
  userId: string
  reportDate: string
  scheduleSlot?: string | null
  kind: 'daily' | 'test'
  status: 'success' | 'failure' | 'skipped'
  httpStatus?: number | null
  attempt: number
  error?: string | null
  durationMs: number
  createdAt: string
  ignoreDuplicateDailySuccess?: boolean
}
