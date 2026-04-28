import { ApiError } from '../../lib/errors'

export async function requireUser() {
  throw new ApiError('UNAUTHORIZED', 'Authentication is not configured yet', 401)
}

export async function getOptionalUser() {
  return null
}

export async function verifyUploadToken(token: string | null) {
  if (!token) {
    throw new ApiError('UNAUTHORIZED', 'Missing upload token', 401)
  }

  throw new ApiError('UNAUTHORIZED', 'Upload token verification is not configured yet', 401)
}

