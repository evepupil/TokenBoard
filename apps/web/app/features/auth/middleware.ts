import { ApiError } from '../../lib/errors'
import type { Bindings } from '../../lib/db'
import { sha256Hex } from '../../lib/crypto'

export type AuthenticatedUser = {
  id: string
  uploadTokenHash: string
  deviceId: string | null
}

export async function requireUser() {
  throw new ApiError('UNAUTHORIZED', 'Authentication is not configured yet', 401)
}

export async function getOptionalUser() {
  return null
}

export async function verifyUploadToken(
  env: Pick<Bindings, 'SEED_USER_ID' | 'SEED_UPLOAD_TOKEN_SHA256'> & Partial<Pick<Bindings, 'DB'>>,
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
  if (tokenHash === env.SEED_UPLOAD_TOKEN_SHA256) {
    return { id: env.SEED_USER_ID, uploadTokenHash: tokenHash, deviceId: null }
  }

  if (env.DB) {
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
  }

  throw new ApiError('UNAUTHORIZED', 'Invalid upload token', 401)
}

function parseBearerToken(authorization: string) {
  const match = /^Bearer\s+(\S+)$/.exec(authorization)
  return match?.[1] ?? null
}
