import { ApiError } from '../../lib/errors'
import type { Bindings } from '../../lib/db'

export type AuthenticatedUser = {
  id: string
}

export async function requireUser() {
  throw new ApiError('UNAUTHORIZED', 'Authentication is not configured yet', 401)
}

export async function getOptionalUser() {
  return null
}

export async function verifyUploadToken(
  env: Pick<Bindings, 'SEED_USER_ID' | 'SEED_UPLOAD_TOKEN_SHA256'>,
  authorization: string | null
): Promise<AuthenticatedUser> {
  if (!authorization) {
    throw new ApiError('UNAUTHORIZED', 'Missing upload token', 401)
  }

  const token = parseBearerToken(authorization)
  if (!token) {
    throw new ApiError('UNAUTHORIZED', 'Invalid upload token format', 401)
  }

  const tokenHash = await sha256Hex(token)
  if (tokenHash !== env.SEED_UPLOAD_TOKEN_SHA256) {
    throw new ApiError('UNAUTHORIZED', 'Invalid upload token', 401)
  }

  return { id: env.SEED_USER_ID }
}

function parseBearerToken(authorization: string) {
  const match = /^Bearer\s+(\S+)$/.exec(authorization)
  return match?.[1] ?? null
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
