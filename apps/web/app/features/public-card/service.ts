import type { UsageSource } from '@tokenboard/usage-core'
import { ApiError } from '../../lib/errors'
import { canShowPublicProfile } from '../settings/service'
import { cacheReadRateFromTotals } from '../../lib/usage-metrics'
import { normalizeTimezone } from '../../lib/timezone'
import { localDateInTimezone } from '../notifications/time'
import {
  effectiveDailyUsageSummaryWith,
  usageSummaryScopeSql,
  usageSummaryParam
} from '../usage/deduped-daily-usage'
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
  sourceSplit: unknown
  topModels: unknown
}

type PublicUsageProfileCore = Omit<PublicUsageProfile, 'sourceSplit' | 'topModels'>

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

async function getPublicUsageProfileCore(
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

async function getPublicTotals(input: {
  db: D1Database
  userId: string
  today: string
  monthStart: string
  summaryStrict: boolean
  includeBreakdown: boolean
}) {
  return input.db
    .prepare(
      `
        WITH params(user_id, today, month_start) AS (SELECT ?, ?, ?),
        ${effectiveDailyUsageSummaryWith({
          filter: usageSummaryScopeSql({
            userId: usageSummaryParam('userId')
          }),
          summaryStrict: input.summaryStrict
        })},
        month_usage AS (
          SELECT
            effective_daily_usage_summary.*
          FROM effective_daily_usage_summary
          JOIN params ON params.user_id = effective_daily_usage_summary.user_id
          WHERE effective_daily_usage_summary.usage_date >= params.month_start
        )
        ${publicBreakdownCtes(input.includeBreakdown)}
        ,
        effective_totals AS (
          SELECT
            user_usage_totals.user_id,
            user_usage_totals.total_tokens,
            user_usage_totals.total_tokens_without_cache_read,
            user_usage_totals.cost_usd
          FROM user_usage_totals
          JOIN params ON params.user_id = user_usage_totals.user_id
          WHERE NOT EXISTS (
            SELECT 1
            FROM effective_daily_usage_summary
            WHERE effective_daily_usage_summary.user_id = params.user_id
              AND effective_daily_usage_summary.updated_at > user_usage_totals.updated_at
          )
          UNION ALL
          SELECT
            params.user_id,
            COALESCE(SUM(effective_daily_usage_summary.total_tokens), 0),
            COALESCE(SUM(effective_daily_usage_summary.total_tokens_without_cache_read), 0),
            COALESCE(SUM(effective_daily_usage_summary.cost_usd), 0)
          FROM params
          LEFT JOIN effective_daily_usage_summary
            ON effective_daily_usage_summary.user_id = params.user_id
          WHERE NOT EXISTS (
            SELECT 1
            FROM user_usage_totals
            WHERE user_usage_totals.user_id = params.user_id
              AND NOT EXISTS (
                SELECT 1
                FROM effective_daily_usage_summary
                WHERE effective_daily_usage_summary.user_id = params.user_id
                  AND effective_daily_usage_summary.updated_at > user_usage_totals.updated_at
              )
          )
        )
        SELECT
          COALESCE(MAX(effective_totals.total_tokens), 0) as totalTokens,
          COALESCE(MAX(effective_totals.total_tokens_without_cache_read), 0) as totalTokensWithoutCacheRead,
          COALESCE(MAX(effective_totals.cost_usd), 0) as totalCostUsd,
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.total_tokens ELSE 0 END), 0) as todayTokens,
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.total_tokens_without_cache_read ELSE 0 END), 0) as todayTokensWithoutCacheRead,
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.cost_usd ELSE 0 END), 0) as todayCostUsd,
          COALESCE(SUM(month_usage.total_tokens), 0) as monthTokens,
          COALESCE(SUM(month_usage.total_tokens_without_cache_read), 0) as monthTokensWithoutCacheRead,
          COALESCE(SUM(month_usage.cost_usd), 0) as monthCostUsd
          ${publicBreakdownSelect(input.includeBreakdown)}
        FROM params
        LEFT JOIN effective_totals ON effective_totals.user_id = params.user_id
        LEFT JOIN month_usage ON month_usage.user_id = params.user_id
      `
    )
    .bind(input.userId, input.today, input.monthStart)
    .first<TotalsRow>()
}

function publicBreakdownCtes(includeBreakdown: boolean) {
  if (!includeBreakdown) return ''
  return `,
        source_usage AS (
          SELECT
            source,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(total_tokens_without_cache_read), 0) as total_tokens_without_cache_read
          FROM month_usage
          GROUP BY source
        ),
        model_usage AS (
          SELECT
            model,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(total_tokens_without_cache_read), 0) as total_tokens_without_cache_read,
            COALESCE(SUM(cost_usd), 0) as cost_usd
          FROM month_usage
          GROUP BY model
        )`
}

function publicBreakdownSelect(includeBreakdown: boolean) {
  if (!includeBreakdown) return `,
          '[]' as sourceSplit,
          '[]' as topModels`
  return `,
          (
            SELECT COALESCE(json_group_array(json_object(
              'source', ordered_sources.source,
              'totalTokens', ordered_sources.total_tokens,
              'totalTokensWithoutCacheRead', ordered_sources.total_tokens_without_cache_read
            )), '[]')
            FROM (
              SELECT
                source,
                total_tokens,
                total_tokens_without_cache_read
              FROM source_usage
              ORDER BY total_tokens_without_cache_read DESC, total_tokens DESC
            ) AS ordered_sources
          ) as sourceSplit,
          (
            SELECT COALESCE(json_group_array(json_object(
              'model', ordered_models.model,
              'totalTokens', ordered_models.total_tokens,
              'totalTokensWithoutCacheRead', ordered_models.total_tokens_without_cache_read,
              'costUsd', ordered_models.cost_usd
            )), '[]')
            FROM (
              SELECT
                model,
                total_tokens,
                total_tokens_without_cache_read,
                cost_usd
              FROM model_usage
              ORDER BY total_tokens_without_cache_read DESC, total_tokens DESC
              LIMIT 5
            ) AS ordered_models
          ) as topModels`
}

function parseSourceSplit(value: unknown) {
  return parseJsonRows(value, 'sourceSplit').map((row) => {
    const source = readString(row, 'sourceSplit.source')
    const totalTokens = readNumber(row, 'sourceSplit.totalTokens')
    const totalTokensWithoutCacheRead = readNumber(row, 'sourceSplit.totalTokensWithoutCacheRead')
    return {
      source: source as UsageSource,
      totalTokens,
      totalTokensWithoutCacheRead,
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens,
        totalTokensWithoutCacheRead
      })
    }
  })
}

function parseTopModels(value: unknown) {
  return parseJsonRows(value, 'topModels').map((row) => {
    const totalTokens = readNumber(row, 'topModels.totalTokens')
    const totalTokensWithoutCacheRead = readNumber(row, 'topModels.totalTokensWithoutCacheRead')
    return {
      model: readString(row, 'topModels.model'),
      totalTokens,
      totalTokensWithoutCacheRead,
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens,
        totalTokensWithoutCacheRead
      }),
      costUsd: readNumber(row, 'topModels.costUsd')
    }
  })
}

function parseJsonRows(value: unknown, column: string) {
  if (!value) return []
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`Invalid public usage ${column}`)
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid public usage ${column}`)
  }
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid public usage ${column}`)
    }
    return item as Record<string, unknown>
  })
}

function readString(row: Record<string, unknown>, column: string) {
  const value = row[column.slice(column.lastIndexOf('.') + 1)]
  if (typeof value !== 'string') {
    throw new Error(`Invalid public usage ${column}`)
  }
  return value
}

function readNumber(row: Record<string, unknown>, column: string) {
  const value = Number(row[column.slice(column.lastIndexOf('.') + 1)] ?? 0)
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid public usage ${column}`)
  }
  return value
}
