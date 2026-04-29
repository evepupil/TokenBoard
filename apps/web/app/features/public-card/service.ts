import type { UsageSource } from '@tokenboard/usage-core'
import { ApiError } from '../../lib/errors'
import { toIsoDate } from '../../lib/time'
import { canShowPublicProfile } from '../settings/service'
import { renderUsageCardSvg } from './svg'

export type PublicUsageProfile = {
  slug: string
  displayName: string
  timezone: string
  todayTokens: number
  todayCostUsd: number
  monthTokens: number
  monthCostUsd: number
  sourceSplit: Array<{ source: UsageSource; totalTokens: number }>
  topModels: Array<{ model: string; totalTokens: number; costUsd: number }>
}

type ProfileRow = {
  userId: string
  slug: string
  displayName: string
  timezone: string
  isPublic: number | boolean
}

type TotalsRow = {
  todayTokens: number | null
  todayCostUsd: number | null
  monthTokens: number | null
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
    todayTokens: Number(totals?.todayTokens ?? 0),
    todayCostUsd: Number(totals?.todayCostUsd ?? 0),
    monthTokens: Number(totals?.monthTokens ?? 0),
    monthCostUsd: Number(totals?.monthCostUsd ?? 0),
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
    today: {
      tokens: profile.todayTokens,
      costUsd: profile.todayCostUsd
    },
    month: {
      tokens: profile.monthTokens,
      costUsd: profile.monthCostUsd
    },
    sourceSplit: profile.sourceSplit,
    topModels: profile.topModels
  }
}

export async function getPublicUsageCard(db: D1Database, slug: string, now = new Date()) {
  const profile = await getPublicUsageProfile(db, slug, now)
  return renderUsageCardSvg({
    displayName: profile.displayName,
    todayTokens: profile.todayTokens,
    monthCostUsd: profile.monthCostUsd
  })
}

export function getEmptyPublicCard() {
  return renderUsageCardSvg({
    displayName: 'TokenBoard',
    todayTokens: 0,
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
        SELECT
          COALESCE(SUM(CASE WHEN usage_date = ? THEN total_tokens ELSE 0 END), 0) as todayTokens,
          COALESCE(SUM(CASE WHEN usage_date = ? THEN cost_usd ELSE 0 END), 0) as todayCostUsd,
          COALESCE(SUM(CASE WHEN usage_date >= ? THEN total_tokens ELSE 0 END), 0) as monthTokens,
          COALESCE(SUM(CASE WHEN usage_date >= ? THEN cost_usd ELSE 0 END), 0) as monthCostUsd
        FROM daily_usage
        WHERE user_id = ?
      `
    )
    .bind(today, today, monthStart, monthStart, userId)
    .first<TotalsRow>()
}

async function getSourceSplit(db: D1Database, userId: string, monthStart: string) {
  const rows = await db
    .prepare(
      `
        SELECT source, COALESCE(SUM(total_tokens), 0) as totalTokens
        FROM daily_usage
        WHERE user_id = ?
          AND usage_date >= ?
        GROUP BY source
        ORDER BY totalTokens DESC
      `
    )
    .bind(userId, monthStart)
    .all<{ source: UsageSource; totalTokens: number }>()

  return (rows.results ?? []).map((row) => ({
    source: row.source,
    totalTokens: Number(row.totalTokens)
  }))
}

async function getTopModels(db: D1Database, userId: string, monthStart: string) {
  const rows = await db
    .prepare(
      `
        SELECT
          model,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(cost_usd), 0) as costUsd
        FROM daily_usage
        WHERE user_id = ?
          AND usage_date >= ?
        GROUP BY model
        ORDER BY totalTokens DESC
        LIMIT 5
      `
    )
    .bind(userId, monthStart)
    .all<{ model: string; totalTokens: number; costUsd: number }>()

  return (rows.results ?? []).map((row) => ({
    model: row.model,
    totalTokens: Number(row.totalTokens),
    costUsd: Number(row.costUsd)
  }))
}
