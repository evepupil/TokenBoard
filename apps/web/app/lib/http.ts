import type { Context } from 'hono'
import { ZodError } from 'zod'
import { ApiError } from './errors'
import { markRouteRenderedNotFound } from './not-found'

// Every branch answers `no-store`, matching `publicApiErrorResponse` and
// `modelPricingErrorResponse`: a cached 401 keeps showing a stale failure, and without a
// directive a browser may cache a 404 heuristically. Set here rather than at each call site
// so no error branch can be added without it.
const noStore = { 'Cache-Control': 'no-store' }

// `Headers` compares field names case-insensitively, so an error carrying `Cache-Control`
// merged next to a differently-cased `no-store` key would append into
// `max-age=60, no-store` rather than replace it — leaving the failure cacheable. Route through
// `Headers` to normalize the name, then hand back a plain record: the policy wins whichever
// spelling the error used, while its other headers (`Retry-After`, `WWW-Authenticate`) survive.
export function withNoStore(headers?: Record<string, string>): Record<string, string> {
  const merged = new Headers(headers)
  merged.delete('Cache-Control')
  merged.set('Cache-Control', 'no-store')
  const record: Record<string, string> = {}
  // `@cloudflare/workers-types` declares `Headers` without `entries()`, so `forEach` is the
  // iteration both that type and lib.dom agree on.
  merged.forEach((value, key) => {
    record[key] = value
  })
  return record
}

// RFC 9110 §11.6.1: a 401 SHOULD carry a `WWW-Authenticate` challenge. The app's own 401s are
// the collector's only signal that its upload token is missing or wrong, and without the
// challenge a generic client cannot tell which scheme to use.
export function unauthorizedHeaders(headers?: Record<string, string>): Record<string, string> {
  return { ...withNoStore(headers), 'WWW-Authenticate': 'Bearer' }
}

export function jsonError(c: Context, error: unknown) {
  if (error instanceof ApiError) {
    const headers = error.status === 401 ? unauthorizedHeaders(error.headers) : withNoStore(error.headers)
    // HonoX installs the root `_404` handler as middleware over the whole app, so it rewrites the
    // body of every 404 — including the specific one this route just built (a pairing code that
    // expired, a device with no active installation). Both bodies are JSON, so only the message
    // changed, which is exactly why it went unnoticed. Mark the response so the root handler keeps
    // the route's own `{error:{code,message}}` instead of the generic `Route not found` shell.
    if (error.status === 404) markRouteRenderedNotFound(c)
    return c.json({ error: { code: error.code, message: error.message } }, error.status, headers)
  }

  if (error instanceof ZodError) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } }, 400, noStore)
  }

  // A request body that is not JSON cannot be fixed by trying again, so it is the
  // caller's error. Left on the 500 path it also looks transient to the collector,
  // which then retries a permanently malformed upload instead of reporting it.
  if (error instanceof SyntaxError) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } }, 400, noStore)
  }

  return c.json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } }, 500, noStore)
}
