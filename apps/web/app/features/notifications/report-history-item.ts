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
  detailsParseError?: string | null
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
  const details = parseHistoryDetails(row)
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
    sourceSplit: details.sourceSplit,
    topModels: details.topModels,
    detailsParseError: details.detailsParseError,
    generatedAt: row.generatedAt,
    updatedAt: row.updatedAt
  }
}

export function dailyReportUrl(id: string, origin?: string) {
  const path = `/reports/daily/${encodeURIComponent(id)}`
  return origin ? `${origin.replace(/\/$/, '')}${path}` : path
}

function parseHistoryDetails(row: DailyReportHistoryRow) {
  let detailsParseError: string | null = null
  let sourceSplit: DailyTokenReport['sourceSplit'] = []
  let topModels: DailyTokenReport['topModels'] = []

  try {
    sourceSplit = parseReportHistorySourceSplit(row.sourceSplit)
  } catch {
    detailsParseError = 'Invalid daily report history source_split'
  }

  try {
    topModels = parseReportHistoryTopModels(row.topModels)
  } catch {
    detailsParseError = detailsParseError
      ? `${detailsParseError}; Invalid daily report history top_models`
      : 'Invalid daily report history top_models'
  }

  return { sourceSplit, topModels, detailsParseError }
}
