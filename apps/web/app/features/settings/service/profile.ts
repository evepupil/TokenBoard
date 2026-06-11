import { ApiError } from '../../../lib/errors'
import { defaultTimezone, normalizeTimezone } from '../../../lib/timezone'
import {
  parsePublicCardConfig,
  stringifyPublicCardConfig
} from '../../public-card/config'
import { publicProfileSchema, type PublicProfileInput } from '../schema'
import {
  profileTimezoneSource,
  type ProfileDisplayNameRow,
  type ProfilePageInput,
  type ProfileRow,
  type ProfileSettings,
  type ProfileTimezoneRow,
  type ProfileTimezoneSettings
} from './types'

export async function getProfileSettings(
  db: D1Database,
  userId: string,
  origin: string
): Promise<ProfileSettings> {
  const row = await db
    .prepare(
      `
        SELECT
          user_id as userId,
          slug,
          display_name as displayName,
          timezone,
          COALESCE(timezone_source, 'default') as timezoneSource,
          public_card_config as publicCardConfig,
          is_public as isPublic,
          participates_in_leaderboards as participatesInLeaderboards,
          created_at as createdAt,
          updated_at as updatedAt
        FROM profiles
        WHERE user_id = ?
        LIMIT 1
      `
    )
    .bind(userId)
    .first<ProfileRow>()

  if (!row) {
    throw new ApiError('NOT_FOUND', 'Profile not found', 404)
  }

  return toProfileSettings(row, origin)
}

export async function getProfileTimezoneSettings(
  db: D1Database,
  userId: string
): Promise<ProfileTimezoneSettings> {
  const row = await db
    .prepare(
      `
        SELECT
          user_id as userId,
          timezone,
          COALESCE(timezone_source, 'default') as timezoneSource
        FROM profiles
        WHERE user_id = ?
        LIMIT 1
      `
    )
    .bind(userId)
    .first<ProfileTimezoneRow>()

  if (!row) {
    throw new ApiError('NOT_FOUND', 'Profile not found', 404)
  }

  return toProfileTimezoneSettings(row)
}

export async function getProfileDisplayName(
  db: D1Database,
  userId: string,
  fallback?: string | null
) {
  const row = await db
    .prepare('SELECT display_name as displayName FROM profiles WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<ProfileDisplayNameRow>()

  const displayName = row?.displayName?.trim()
  return displayName || fallback || undefined
}

export async function updateProfileSettings(
  db: D1Database,
  userId: string,
  input: PublicProfileInput,
  now = new Date().toISOString()
) {
  await assertSlugAvailable(db, input.slug, userId)

  const isPublic = input.isPublic || input.participatesInLeaderboards

  await db
    .prepare(
      `
        UPDATE profiles
        SET
          slug = ?,
          display_name = ?,
          timezone = ?,
          timezone_source = 'user',
          is_public = ?,
          participates_in_leaderboards = ?,
          updated_at = ?
        WHERE user_id = ?
      `
    )
    .bind(
      input.slug,
      input.displayName,
      input.timezone,
      isPublic ? 1 : 0,
      input.participatesInLeaderboards ? 1 : 0,
      now,
      userId
    )
    .run()
}

export async function updateProfilePageSettings(
  db: D1Database,
  userId: string,
  input: ProfilePageInput,
  now = new Date().toISOString()
) {
  await assertSlugAvailable(db, input.profile.slug, userId)

  const isPublic = input.profile.isPublic || input.profile.participatesInLeaderboards
  const cardConfig = input.publicCardConfig ? stringifyPublicCardConfig(input.publicCardConfig) : null

  await db
    .prepare(
      `
        UPDATE profiles
        SET
          slug = ?,
          display_name = ?,
          timezone = ?,
          timezone_source = 'user',
          public_card_config = ?,
          is_public = ?,
          participates_in_leaderboards = ?,
          updated_at = ?
        WHERE user_id = ?
      `
    )
    .bind(
      input.profile.slug,
      input.profile.displayName,
      input.profile.timezone,
      cardConfig,
      isPublic ? 1 : 0,
      input.profile.participatesInLeaderboards ? 1 : 0,
      now,
      userId
    )
    .run()
}

async function assertSlugAvailable(db: D1Database, slug: string, userId: string) {
  const conflict = await db
    .prepare('SELECT user_id as userId FROM profiles WHERE slug = ? AND user_id <> ? LIMIT 1')
    .bind(slug, userId)
    .first<{ userId: string }>()

  if (conflict) {
    throw new ApiError('BAD_REQUEST', 'Slug is already taken', 400)
  }
}

function toProfileSettings(row: ProfileRow, origin: string): ProfileSettings {
  const { profile, needsRepair } = normalizePublicProfileRow(row)
  const publicSvgUrl = `${origin}/api/public/${profile.slug}.svg`

  return {
    ...profile,
    publicCardConfig: parsePublicCardConfig(row.publicCardConfig),
    shouldUseBrowserTimezoneDefault:
      profile.timezone === defaultTimezone &&
      (row.timezoneSource ?? profileTimezoneSource.default) === profileTimezoneSource.default,
    profileNeedsRepair: needsRepair,
    publicJsonUrl: `${origin}/api/public/${profile.slug}.json`,
    publicSvgUrl,
    publicMarkdown: `[![TokenBoard](${publicSvgUrl})](${origin})`
  }
}

function toProfileTimezoneSettings(row: ProfileTimezoneRow): ProfileTimezoneSettings {
  const timezone = normalizeTimezone(row.timezone)
  return {
    timezone,
    shouldUseBrowserTimezoneDefault:
      timezone === defaultTimezone &&
      (row.timezoneSource ?? profileTimezoneSource.default) === profileTimezoneSource.default,
    profileNeedsRepair: timezone !== row.timezone
  }
}

function normalizePublicProfileRow(row: ProfileRow) {
  const rawProfile = {
    slug: row.slug,
    displayName: row.displayName,
    timezone: row.timezone,
    isPublic: Boolean(row.isPublic),
    participatesInLeaderboards: Boolean(row.participatesInLeaderboards)
  }
  const normalizedProfile = {
    ...rawProfile,
    slug: normalizeStoredSlug(row.slug, row.displayName, row.userId),
    displayName: normalizeDisplayName(row.displayName),
    timezone: normalizeTimezone(row.timezone)
  }

  return {
    profile: publicProfileSchema.parse(normalizedProfile),
    needsRepair:
      !publicProfileSchema.safeParse(rawProfile).success ||
      rawProfile.slug !== normalizedProfile.slug ||
      rawProfile.displayName !== normalizedProfile.displayName ||
      rawProfile.timezone !== normalizedProfile.timezone
  }
}

function normalizeDisplayName(value: unknown) {
  const trimmed = String(value ?? '').trim()
  return (trimmed || 'TokenBoard User').slice(0, 80)
}

function normalizeStoredSlug(slug: unknown, displayName: unknown, userId: unknown) {
  const candidates = [
    slug,
    displayName,
    userId
  ].map(slugCandidate)

  return candidates.find((candidate) => candidate.length >= 3)?.slice(0, 32) ?? 'user'
}

function slugCandidate(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
