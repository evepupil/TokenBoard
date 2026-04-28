import type { Context } from 'hono'
import { ApiError } from '../../lib/errors'
import type { Bindings } from '../../lib/db'
import { sha256Hex } from '../../lib/crypto'
import { createAuth } from './auth'

export type SessionUser = {
  id: string
  email: string
  name: string
  image?: string | null
}

export type AuthenticatedUser = {
  id: string
  uploadTokenHash: string
  deviceId: string | null
}

export async function requireUser(c: Context): Promise<SessionUser> {
  const session = await getOptionalUser(c)
  if (!session) {
    throw new ApiError('UNAUTHORIZED', 'Authentication required', 401)
  }

  await ensureProfile(c.env.DB, session)
  return session
}

export async function getOptionalUser(c: Context): Promise<SessionUser | null> {
  const session = await createAuth(c.env as Bindings, c.req.raw).api.getSession({
    headers: c.req.raw.headers
  })

  if (!session?.user) {
    return null
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image
  }
}

export async function verifyUploadToken(
  env: Pick<Bindings, 'DB'>,
  authorization: string | null,
  hash: (value: string) => Promise<string> = sha256Hex
): Promise<AuthenticatedUser> {
  if (!authorization) {
    throw new ApiError('UNAUTHORIZED', 'Missing upload token', 401)
  }

  const token = parseBearerToken(authorization)
  if (!token) {
    throw new ApiError('UNAUTHORIZED', 'Invalid upload token format', 401)
  }

  const tokenHash = await hash(token)
  const row = await env.DB
    .prepare(
      `
        SELECT user_id as userId, device_id as deviceId
        FROM upload_tokens
        WHERE token_hash = ?
          AND revoked_at IS NULL
        LIMIT 1
      `
    )
    .bind(tokenHash)
    .first<{ userId: string; deviceId: string | null }>()

  if (row) {
    return { id: row.userId, uploadTokenHash: tokenHash, deviceId: row.deviceId ?? null }
  }

  throw new ApiError('UNAUTHORIZED', 'Invalid upload token', 401)
}

async function ensureProfile(db: D1Database, user: SessionUser) {
  const now = new Date().toISOString()
  await db
    .prepare(
      `
        INSERT INTO profiles (
          user_id,
          slug,
          display_name,
          timezone,
          is_public,
          participates_in_leaderboards,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, 'UTC', 0, 0, ?, ?)
        ON CONFLICT(user_id) DO NOTHING
      `
    )
    .bind(user.id, profileSlug(user), user.name || user.email, now, now)
    .run()
}

function profileSlug(user: SessionUser) {
  const base = (user.name || user.email.split('@')[0] || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return `${base || 'user'}-${user.id.slice(0, 8).toLowerCase()}`
}

function parseBearerToken(authorization: string) {
  const match = /^Bearer\s+(\S+)$/.exec(authorization)
  return match?.[1] ?? null
}
