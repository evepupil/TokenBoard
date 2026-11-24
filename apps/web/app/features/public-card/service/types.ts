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
  totalCostAvailable: boolean
  todayCostAvailable: boolean
  monthCostAvailable: boolean
  /**
   * ISO instant of the freshest data behind the totals: either the cached rollup row's
   * own stamp, or the newest summary row that overrode it. Null when the account has no
   * usage rows at all. Only rendered on the SVG when the config enables `showUpdatedAt`,
   * and deliberately absent from the public JSON — the option governs the visible card,
   * and a JSON consumer that wants freshness can diff the numbers themselves.
   */
  dataUpdatedAt: string | null
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
    costAvailable: boolean
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
  totalCostAvailable: number | null
  todayCostAvailable: number | null
  monthCostAvailable: number | null
  dataUpdatedAt: string | null
  sourceSplit: unknown
  topModels: unknown
  modelCount?: number | null
}

export type PublicUsageProfileCore = Omit<PublicUsageProfile, 'sourceSplit' | 'topModels'>
