import { ApiError } from '../../lib/errors'
import { publicProfileSchema, type PublicProfileInput } from './schema'

export type ProfileSettings = PublicProfileInput & {
  publicJsonUrl: string
  publicSvgUrl: string
}

type ProfileRow = {
  slug: string
  displayName: string
  timezone: string
  isPublic: number | boolean
  participatesInLeaderboards: number | boolean
}

export function canShowPublicProfile(isPublic: boolean) {
  return isPublic
}

export function getCanonicalPublicOrigin(input: {
  configuredOrigin?: string | null
  requestOrigin: string
}) {
  return (input.configuredOrigin || input.requestOrigin).replace(/\/$/, '')
}

export function parseProfileForm(form: Record<string, unknown>): PublicProfileInput {
  return publicProfileSchema.parse({
    slug: String(form.slug || ''),
    displayName: String(form.displayName || ''),
    timezone: String(form.timezone || 'UTC'),
    isPublic: form.isPublic === 'on',
    participatesInLeaderboards: form.participatesInLeaderboards === 'on'
  })
}

export async function getProfileSettings(
  db: D1Database,
  userId: string,
  origin: string
): Promise<ProfileSettings> {
  const row = await db
    .prepare(
      `
        SELECT
          slug,
          display_name as displayName,
          timezone,
          is_public as isPublic,
          participates_in_leaderboards as participatesInLeaderboards
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

export async function updateProfileSettings(
  db: D1Database,
  userId: string,
  input: PublicProfileInput,
  now = new Date().toISOString()
) {
  const conflict = await db
    .prepare('SELECT user_id as userId FROM profiles WHERE slug = ? AND user_id <> ? LIMIT 1')
    .bind(input.slug, userId)
    .first<{ userId: string }>()

  if (conflict) {
    throw new ApiError('BAD_REQUEST', 'Slug is already taken', 400)
  }

  const isPublic = input.isPublic || input.participatesInLeaderboards

  await db
    .prepare(
      `
        UPDATE profiles
        SET
          slug = ?,
          display_name = ?,
          timezone = ?,
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

function toProfileSettings(row: ProfileRow, origin: string): ProfileSettings {
  const profile = publicProfileSchema.parse({
    slug: row.slug,
    displayName: row.displayName,
    timezone: row.timezone,
    isPublic: Boolean(row.isPublic),
    participatesInLeaderboards: Boolean(row.participatesInLeaderboards)
  })

  return {
    ...profile,
    publicJsonUrl: `${origin}/api/public/${profile.slug}.json`,
    publicSvgUrl: `${origin}/api/public/${profile.slug}.svg`
  }
}
