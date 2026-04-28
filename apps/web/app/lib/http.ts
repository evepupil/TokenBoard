import type { Context } from 'hono'
import { ApiError } from './errors'

export function jsonError(c: Context, error: unknown) {
  if (error instanceof ApiError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status)
  }

  return c.json(
    { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } },
    500
  )
}

