import type { UsageSource } from '@tokenboard/usage-core'

export type UsageSummaryInput = {
  userId: string
  today: string
  monthStart: string
  summaryStrict?: boolean
}

export type UsageSummary = {
  todayTokens: number
  todayTokensWithoutCacheRead: number
  todayCacheReadRate: number
  todayCostUsd: number
  monthTokens: number
  monthTokensWithoutCacheRead: number
  monthCacheReadRate: number
  monthCostUsd: number
  lastSyncedAt: string | null
  deviceCount: number
  sourceSplit: Array<{
    source: UsageSource
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
  }>
}

export type DailyUsageTrendInput = {
  userId: string
  startDate: string
  endDate: string
  summaryStrict?: boolean
}

export type DailyUsageTrendItem = {
  usageDate: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
}

export type UsageDetailsInput = {
  userId: string
  startDate: string
  endDate: string
  source: UsageSource | 'all'
  deviceId?: string
  modelQuery?: string
}

export type UsageDetailsDailyRow = {
  usageDate: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
  sessionCount: number
  sourceSplit: Array<{
    source: UsageSource
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
  }>
  modelRows: UsageDetailsModelRow[]
}

export type UsageDetailsModelRow = {
  usageDate: string
  source: UsageSource
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
  sessionCount: number
}

export type UsageDetails = {
  summary: {
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
    costUsd: number
    sessionCount: number
    activeDays: number
  }
  dailyRows: UsageDetailsDailyRow[]
  modelRows: UsageDetailsModelRow[]
}
