import type { WebhookEnv } from './config'
import type { DeliveryKind } from './delivery-helpers'
import type { DueWebhookSubscription } from './queries'
import type { DailyReportHistoryShare } from './report-history-delivery'

export type Fetcher = typeof fetch

export type DeliverSubscriptionInput = {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  kind: DeliveryKind
  now: Date
  fetcher: Fetcher
}

export type CheckedDeliveryInput = DeliverSubscriptionInput & {
  reportDate: string
  scheduleSlot: string | null
  attempt: number
  startedAt: number
}

export type ReportHistoryDeliveryState = {
  retentionDays: number
  share: DailyReportHistoryShare | null
}
