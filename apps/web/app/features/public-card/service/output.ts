import { renderUsageCardSvg } from '../svg'
import { getPublicUsageProfile, getPublicUsageProfileCore } from './profile'

export async function getPublicUsageJson(db: D1Database, slug: string, now = new Date(), summaryStrict = false) {
  const profile = await getPublicUsageProfile(db, slug, now, summaryStrict)
  return {
    slug: profile.slug,
    displayName: profile.displayName,
    timezone: profile.timezone,
    total: {
      tokens: profile.totalTokens,
      tokensWithoutCacheRead: profile.totalTokensWithoutCacheRead,
      cacheReadRate: profile.totalCacheReadRate,
      costUsd: profile.totalCostUsd
    },
    today: {
      tokens: profile.todayTokens,
      tokensWithoutCacheRead: profile.todayTokensWithoutCacheRead,
      cacheReadRate: profile.todayCacheReadRate,
      costUsd: profile.todayCostUsd
    },
    month: {
      tokens: profile.monthTokens,
      tokensWithoutCacheRead: profile.monthTokensWithoutCacheRead,
      cacheReadRate: profile.monthCacheReadRate,
      costUsd: profile.monthCostUsd
    },
    sourceSplit: profile.sourceSplit,
    topModels: profile.topModels
  }
}

export async function getPublicUsageCard(
  db: D1Database,
  slug: string,
  now = new Date(),
  publicUrl = 'TokenBoard',
  summaryStrict = false
) {
  const profile = await getPublicUsageProfileCore(db, slug, now, summaryStrict, false)
  return renderUsageCardSvg({
    displayName: profile.displayName,
    publicUrl,
    totalTokens: profile.totalTokens,
    totalTokensWithoutCacheRead: profile.totalTokensWithoutCacheRead,
    totalCacheReadRate: profile.totalCacheReadRate,
    totalCostUsd: profile.totalCostUsd,
    monthTokens: profile.monthTokens,
    monthTokensWithoutCacheRead: profile.monthTokensWithoutCacheRead,
    monthCacheReadRate: profile.monthCacheReadRate,
    monthCostUsd: profile.monthCostUsd,
    todayTokens: profile.todayTokens,
    todayTokensWithoutCacheRead: profile.todayTokensWithoutCacheRead,
    todayCacheReadRate: profile.todayCacheReadRate,
    todayCostUsd: profile.todayCostUsd
  }, profile.publicCardConfig)
}

export function getEmptyPublicCard() {
  return renderUsageCardSvg({
    displayName: 'TokenBoard',
    publicUrl: 'TokenBoard',
    totalTokens: 0,
    totalTokensWithoutCacheRead: 0,
    totalCacheReadRate: 0,
    totalCostUsd: 0,
    monthTokens: 0,
    monthTokensWithoutCacheRead: 0,
    monthCacheReadRate: 0,
    monthCostUsd: 0
  })
}
