import { ApiError } from '../../../lib/errors'
import { cacheReadRateFromTotals } from '../../../lib/usage-metrics'
import { normalizeTimezone } from '../../../lib/timezone'
import { localDateInTimezone } from '../../notifications/time'
import { canShowPublicProfile } from '../../settings/service'
import { parsePublicCardConfig } from '../config'
import { parseSourceSplit, parseTopModels } from './parse'
import { getPublicTotals } from './totals'
import type { ProfileRow, PublicUsageProfile, PublicUsageProfileCore } from './types'

export async function getPublicUsageProfile(
  db: D1Database,
  slug: string,
  now = new Date(),
  summaryStrict = false
): Promise<PublicUsageProfile> {
  const core = await getPublicUsageProfileCore(db, slug, now, summaryStrict)

  return {
    ...core,
    sourceSplit: core.sourceSplit,
    topModels: core.topModels
  }
}

export async function getPublicUsageProfileCore(
  db: D1Database,
  slug: string,
  now: Date,
  summaryStrict: boolean,
  includeBreakdown = true
): Promise<PublicUsageProfileCore & Pick<PublicUsageProfile, 'sourceSplit' | 'topModels'> & { userId: string }> {
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

  const timezone = normalizeTimezone(profile.timezone)
  const today = localDateInTimezone(now, timezone)
  const monthStart = `${today.slice(0, 8)}01`
  const totals = await getPublicTotals({
    db,
    userId: profile.userId,
    today,
    monthStart,
    summaryStrict,
    includeBreakdown
  })

  return {
    userId: profile.userId,
    slug: profile.slug,
    displayName: profile.displayName,
    timezone,
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
    sourceSplit: parseSourceSplit(totals?.sourceSplit),
    topModels: parseTopModels(totals?.topModels)
  }
}

export async function assertPublicUsageVisible(db: D1Database, slug: string) {
  const profile = await db
    .prepare(
      `
        SELECT
          profiles.user_id as userId,
          profiles.is_public as isPublic,
          profiles.updated_at as updatedAt,
          user_usage_totals.updated_at as usageUpdatedAt,
          (
            SELECT MAX(daily_usage_summary.updated_at)
            FROM daily_usage_summary
            WHERE daily_usage_summary.user_id = profiles.user_id
          ) as summaryUpdatedAt
        FROM profiles
        LEFT JOIN user_usage_totals ON user_usage_totals.user_id = profiles.user_id
        WHERE slug = ?
        LIMIT 1
      `
    )
    .bind(slug)
    .first<{
      userId: string
      isPublic: number | boolean
      updatedAt: string
      usageUpdatedAt: string | null
      summaryUpdatedAt: string | null
    }>()

  if (!profile || !canShowPublicProfile(Boolean(profile.isPublic))) {
    throw new ApiError('NOT_FOUND', 'Public profile not found', 404)
  }

  return {
    userId: profile.userId,
    updatedAt: profile.updatedAt,
    usageUpdatedAt: profile.usageUpdatedAt ?? '',
    summaryUpdatedAt: profile.summaryUpdatedAt ?? ''
  }
}
