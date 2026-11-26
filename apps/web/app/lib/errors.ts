import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_SERVER_ERROR'

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: ContentfulStatusCode = 400,
    readonly headers?: Record<string, string>,
    // Machine-readable per-item detail for a validation failure. Stays opaque to this module:
    // each feature builds its own shape, and `jsonError` only serializes it. `truncated`
    // marks that the producer capped the list.
    readonly details?: { details: ApiErrorDetail[]; truncated: boolean }
  ) {
    super(message)
  }
}

export type ApiErrorDetail = {
  index?: number
  path: string
  code: string
}
