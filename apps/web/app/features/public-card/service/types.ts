import type { UsageSource } from '@tokenboard/usage-core'
import type { PublicCardConfig } from '../config'

export type PublicUsageProfile = {
  slug: string
  displayName: string
  timezone: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  totalCacheReadRate: number
  totalCostUsd: number
  todayTokens: number
  todayTokensWithoutCacheRead: number
  todayCacheReadRate: number
  todayCostUsd: number
  monthTokens: number
  monthTokensWithoutCacheRead: number
  monthCacheReadRate: number
  monthCostUsd: number
  publicCardConfig: PublicCardConfig
  sourceSplit: Array<{
    source: UsageSource
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
  }>
  topModels: Array<{
    model: string
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
    costUsd: number
  }>
}

export type ProfileRow = {
  userId: string
  slug: string
  displayName: string
  timezone: string
  isPublic: number | boolean
  publicCardConfig?: string | null
}

export type TotalsRow = {
  totalTokens: number | null
  totalTokensWithoutCacheRead: number | null
  totalCostUsd: number | null
  todayTokens: number | null
  todayTokensWithoutCacheRead: number | null
  todayCostUsd: number | null
  monthTokens: number | null
  monthTokensWithoutCacheRead: number | null
  monthCostUsd: number | null
  sourceSplit: unknown
  topModels: unknown
}

export type PublicUsageProfileCore = Omit<PublicUsageProfile, 'sourceSplit' | 'topModels'>
