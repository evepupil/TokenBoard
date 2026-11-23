import { renderUsageCardSvg } from '../svg'
import { localShortDateTime, timezoneOffsetLabel } from '../../../lib/time'
import { getPublicUsageProfile, getPublicUsageProfileCore } from './profile'

export async function getPublicUsageJson(db: D1Database, slug: string, now = new Date(), summaryStrict = false) {
  const profile = await getPublicUsageProfile(db, slug, now, summaryStrict)
  return {
    slug: profile.slug,
    displayName: profile.displayName,
    // The full IANA name, unlike the SVG which renders only the offset: a JSON consumer may need
    // to attribute dates itself, and the two surfaces intentionally differ here (see
    // `svg-types.ts`, which explains why the README card keeps the offset only).
    timezone: profile.timezone,
    total: {
      tokens: profile.totalTokens,
      tokensWithoutCacheRead: profile.totalTokensWithoutCacheRead,
      cacheReadRate: profile.totalCacheReadRate,
      costUsd: profile.totalCostUsd,
      costAvailable: profile.totalCostAvailable
    },
    today: {
      tokens: profile.todayTokens,
      tokensWithoutCacheRead: profile.todayTokensWithoutCacheRead,
      cacheReadRate: profile.todayCacheReadRate,
      costUsd: profile.todayCostUsd,
      costAvailable: profile.todayCostAvailable
    },
    month: {
      tokens: profile.monthTokens,
      tokensWithoutCacheRead: profile.monthTokensWithoutCacheRead,
      cacheReadRate: profile.monthCacheReadRate,
      costUsd: profile.monthCostUsd,
      costAvailable: profile.monthCostAvailable
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
  // The SVG renderer only draws totals and configured metrics. Do not compute the JSON-only
  // source split for this path: it adds a real SQL aggregate that the renderer never reads.
  const profile = await getPublicUsageProfileCore(db, slug, now, summaryStrict, false, false)
  return renderUsageCardSvg(
    {
      displayName: profile.displayName,
      publicUrl,
      totalTokens: profile.totalTokens,
      totalTokensWithoutCacheRead: profile.totalTokensWithoutCacheRead,
      totalCacheReadRate: profile.totalCacheReadRate,
      totalCostUsd: profile.totalCostUsd,
      totalCostAvailable: profile.totalCostAvailable,
      monthTokens: profile.monthTokens,
      monthTokensWithoutCacheRead: profile.monthTokensWithoutCacheRead,
      monthCacheReadRate: profile.monthCacheReadRate,
      monthCostUsd: profile.monthCostUsd,
      monthCostAvailable: profile.monthCostAvailable,
      todayTokens: profile.todayTokens,
      todayTokensWithoutCacheRead: profile.todayTokensWithoutCacheRead,
      todayCacheReadRate: profile.todayCacheReadRate,
      todayCostUsd: profile.todayCostUsd,
      todayCostAvailable: profile.todayCostAvailable,
      // `sourceSplit` is deliberately not passed: `renderUsageCardSvg` never reads it, and the
      // JSON path (`getPublicUsageJson`) is where that data is actually consumed.
      // The card is read from anywhere, so it has to say which day its "今日" covers. Read at
      // the instant of rendering rather than cached, because the offset changes with the season.
      timezoneLabel: timezoneOffsetLabel(profile.timezone, now),
      // The stamp names the aggregates' own instant (when the newest row was read),
      // formatted in the owner's zone — not this render's clock: the numbers above it
      // came from the data, and a stamp that moves every fetch would claim freshness
      // the totals do not have. Preview callers pass no totals at all, so they get no
      // label and the renderer shows nothing.
      updatedAtLabel: localShortDateTime(profile.dataUpdatedAt, profile.timezone)
    },
    profile.publicCardConfig
  )
}
