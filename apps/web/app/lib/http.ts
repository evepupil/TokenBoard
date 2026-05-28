import type { Context } from 'hono'
import { ZodError } from 'zod'
import { ApiError } from './errors'

export function jsonError(c: Context, error: unknown) {
  if (error instanceof ApiError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status)
  }

  if (error instanceof ZodError) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } }, 400)
  }

  return c.json(
    { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } },
    500
  )
}
