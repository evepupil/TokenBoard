import type { DailyTokenReport } from './adapters'
import type { WebhookEnv } from './config'
import type { DueWebhookSubscription } from './queries'
import {
  dailyReportHistoryRetentionDays,
  pruneExpiredDailyReportHistory,
  saveDailyReportHistory
} from './report-history'

export { dailyReportHistoryRetentionDays }

export async function persistDailyReportHistory(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  report: DailyTokenReport
  scheduleSlot: string
  now: Date
  retentionDays: number
}) {
  await saveDailyReportHistory({
    db: input.env.DB,
    userId: input.subscription.userId,
    report: input.report,
    scheduleSlot: input.scheduleSlot,
    generatedAt: input.now
  })
  await pruneExpiredDailyReportHistory({
    db: input.env.DB,
    userId: input.subscription.userId,
    reportDate: input.report.reportDate,
    retentionDays: input.retentionDays
  })
}
