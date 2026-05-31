import type { UsageSource } from '@tokenboard/usage-core'
import { ApiError } from '../../lib/errors'
import { toIsoDate } from '../../lib/time'
import { canShowPublicProfile } from '../settings/service'
import { dedupedDailyUsageCte } from '../usage/deduped-daily-usage'
import { cacheReadRateFromTotals } from '../../lib/usage-metrics'
import { parsePublicCardConfig, type PublicCardConfig } from './config'
import { renderUsageCardSvg } from './svg'

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

type ProfileRow = {
  userId: string
  slug: string
  displayName: string
  timezone: string
  isPublic: number | boolean
  publicCardConfig?: string | null
}

type TotalsRow = {
  totalTokens: number | null
  totalTokensWithoutCacheRead: number | null
  totalCostUsd: number | null
  todayTokens: number | null
  todayTokensWithoutCacheRead: number | null
  todayCostUsd: number | null
  monthTokens: number | null
  monthTokensWithoutCacheRead: number | null
  monthCostUsd: number | null
}

export async function getPublicUsageProfile(
  db: D1Database,
  slug: string,
  now = new Date()
): Promise<PublicUsageProfile> {
  const profile = await db
    .prepare(
      `
        SELECT
          user_id as userId,
          slug,
          display_name as displayName,
          timezone,
          public_card_config as publicCardConfig,
          is_public as isPublic
        FROM profiles
        WHERE slug = ?
        LIMIT 1
      `
    )
    .bind(slug)
    .first<ProfileRow>()

  if (!profile || !canShowPublicProfile(Boolean(profile.isPublic))) {
    throw new ApiError('NOT_FOUND', 'Public profile not found', 404)
  }

  const today = toIsoDate(now)
  const monthStart = `${today.slice(0, 8)}01`
  const totals = await getPublicTotals(db, profile.userId, today, monthStart)
  const sourceSplit = await getSourceSplit(db, profile.userId, monthStart)
  const topModels = await getTopModels(db, profile.userId, monthStart)

  return {
    slug: profile.slug,
    displayName: profile.displayName,
    timezone: profile.timezone,
    totalTokens: Number(totals?.totalTokens ?? 0),
    totalTokensWithoutCacheRead: Number(totals?.totalTokensWithoutCacheRead ?? 0),
    totalCacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(totals?.totalTokens ?? 0),
      totalTokensWithoutCacheRead: Number(totals?.totalTokensWithoutCacheRead ?? 0)
    }),
    totalCostUsd: Number(totals?.totalCostUsd ?? 0),
    todayTokens: Number(totals?.todayTokens ?? 0),
    todayTokensWithoutCacheRead: Number(totals?.todayTokensWithoutCacheRead ?? 0),
    todayCacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(totals?.todayTokens ?? 0),
      totalTokensWithoutCacheRead: Number(totals?.todayTokensWithoutCacheRead ?? 0)
    }),
    todayCostUsd: Number(totals?.todayCostUsd ?? 0),
    monthTokens: Number(totals?.monthTokens ?? 0),
    monthTokensWithoutCacheRead: Number(totals?.monthTokensWithoutCacheRead ?? 0),
    monthCacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(totals?.monthTokens ?? 0),
      totalTokensWithoutCacheRead: Number(totals?.monthTokensWithoutCacheRead ?? 0)
    }),
    monthCostUsd: Number(totals?.monthCostUsd ?? 0),
    publicCardConfig: parsePublicCardConfig(profile.publicCardConfig),
    sourceSplit,
    topModels
  }
}

export async function getPublicUsageJson(db: D1Database, slug: string, now = new Date()) {
  const profile = await getPublicUsageProfile(db, slug, now)
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
  publicUrl = 'TokenBoard'
) {
  const profile = await getPublicUsageProfile(db, slug, now)
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

export function normalizePublicSlug(slug: string, extension: 'json' | 'svg') {
  return slug.endsWith(`.${extension}`) ? slug.slice(0, -1 * (`.${extension}`.length)) : slug
}

export function getPublicRouteSlug(
  params: Record<string, string | undefined>,
  extension: 'json' | 'svg'
) {
  return normalizePublicSlug(
    params.slug ?? params[`slug.${extension}`] ?? '',
    extension
  )
}

async function getPublicTotals(db: D1Database, userId: string, today: string, monthStart: string) {
  return db
    .prepare(
      `
        WITH ${dedupedDailyUsageCte}
        SELECT
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(cost_usd), 0) as totalCostUsd,
          COALESCE(SUM(CASE WHEN usage_date = ? THEN total_tokens ELSE 0 END), 0) as todayTokens,
          COALESCE(SUM(CASE WHEN usage_date = ? THEN input_tokens + output_tokens + cache_creation_tokens ELSE 0 END), 0) as todayTokensWithoutCacheRead,
          COALESCE(SUM(CASE WHEN usage_date = ? THEN cost_usd ELSE 0 END), 0) as todayCostUsd,
          COALESCE(SUM(CASE WHEN usage_date >= ? THEN total_tokens ELSE 0 END), 0) as monthTokens,
          COALESCE(SUM(CASE WHEN usage_date >= ? THEN input_tokens + output_tokens + cache_creation_tokens ELSE 0 END), 0) as monthTokensWithoutCacheRead,
          COALESCE(SUM(CASE WHEN usage_date >= ? THEN cost_usd ELSE 0 END), 0) as monthCostUsd
        FROM deduped_daily_usage
        WHERE user_id = ?
      `
    )
    .bind(today, today, today, monthStart, monthStart, monthStart, userId)
    .first<TotalsRow>()
}

async function getSourceSplit(db: D1Database, userId: string, monthStart: string) {
  const rows = await db
    .prepare(
      `
        WITH ${dedupedDailyUsageCte}
        SELECT
          source,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens), 0) as totalTokensWithoutCacheRead
        FROM deduped_daily_usage
        WHERE user_id = ?
          AND usage_date >= ?
        GROUP BY source
        ORDER BY totalTokens DESC
      `
    )
    .bind(userId, monthStart)
    .all<{ source: UsageSource; totalTokens: number; totalTokensWithoutCacheRead: number }>()

  return (rows.results ?? []).map((row) => ({
    source: row.source,
    totalTokens: Number(row.totalTokens),
    totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
    cacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
    })
  }))
}

async function getTopModels(db: D1Database, userId: string, monthStart: string) {
  const rows = await db
    .prepare(
      `
        WITH ${dedupedDailyUsageCte}
        SELECT
          model,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(cost_usd), 0) as costUsd
        FROM deduped_daily_usage
        WHERE user_id = ?
          AND usage_date >= ?
        GROUP BY model
        ORDER BY totalTokens DESC
        LIMIT 5
      `
    )
    .bind(userId, monthStart)
    .all<{ model: string; totalTokens: number; totalTokensWithoutCacheRead: number; costUsd: number }>()

  return (rows.results ?? []).map((row) => ({
    model: row.model,
    totalTokens: Number(row.totalTokens),
    totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
    cacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
    }),
    costUsd: Number(row.costUsd)
  }))
}
