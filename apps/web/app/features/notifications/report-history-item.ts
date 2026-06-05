import type { DailyTokenReport } from './adapters'
import {
  parseReportHistorySourceSplit,
  parseReportHistoryTopModels
} from './report-history-parser'

export type DailyReportHistoryItem = DailyTokenReport & {
  id: string
  scheduleSlot: string
  reportUrl: string
  shareRevokedAt: string | null
  generatedAt: string
  updatedAt: string
}

export type DailyReportHistoryRow = {
  id: string
  ownerUserId?: string
  displayName: string
  reportDate: string
  scheduleSlot: string
  timezone: string
  dashboardUrl: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
  sessionCount: number
  sourceSplit: string
  topModels: string
  shareRevokedAt?: string | null
  shareEnabled?: number | boolean | null
  generatedAt: string
  updatedAt: string
}

export function toDailyReportHistoryItem(row: DailyReportHistoryRow): DailyReportHistoryItem {
  return {
    id: row.id,
    displayName: row.displayName,
    reportDate: row.reportDate,
    scheduleSlot: row.scheduleSlot,
    reportUrl: dailyReportUrl(row.id),
    shareRevokedAt: row.shareRevokedAt ?? null,
    timezone: row.timezone,
    dashboardUrl: row.dashboardUrl,
    totalTokens: Number(row.totalTokens),
    totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
    cacheReadRate: Number(row.cacheReadRate),
    costUsd: Number(row.costUsd),
    sessionCount: Number(row.sessionCount),
    sourceSplit: parseReportHistorySourceSplit(row.sourceSplit),
    topModels: parseReportHistoryTopModels(row.topModels),
    generatedAt: row.generatedAt,
    updatedAt: row.updatedAt
  }
}

export function dailyReportUrl(id: string, origin?: string) {
  const path = `/reports/daily/${encodeURIComponent(id)}`
  return origin ? `${origin.replace(/\/$/, '')}${path}` : path
}
