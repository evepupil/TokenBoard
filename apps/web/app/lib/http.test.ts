import { describe, expect, test } from 'vitest'
import type { Context } from 'hono'
import { jsonError } from './http'
import { ApiError } from './errors'
import { isRouteRenderedNotFound } from './not-found'
import { ZodError } from 'zod'

function fakeContext() {
  const captured: { status?: number; body?: unknown; headers?: Record<string, string> } = {}
  // jsonError now records that a 404 body belongs to the route, so the stub needs the state
  // store a real context has; without it the mark is silently skipped and a test of the marking
  // would pass for the wrong reason.
  const state = new Map<string, unknown>()
  const c = {
    json(body: unknown, status = 200, headers?: Record<string, string>) {
      captured.body = body
      captured.status = status
      // Headers are compared case-insensitively by the runtime, so the fake lower-cases the
      // keys the same way — the assertions then do not depend on the spelling the policy uses.
      const record: Record<string, string> = {}
      new Headers(headers).forEach((value, key) => {
        record[key] = value
      })
      captured.headers = record
      return new Response(JSON.stringify(body), { status })
    },
    set(key: string, value: unknown) {
      state.set(key, value)
    },
    get(key: string) {
      return state.get(key)
    }
  } as unknown as Context
  return { c, captured }
}

describe('jsonError', () => {
  test('maps an ApiError to its own status and code', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new ApiError('NOT_FOUND', 'Profile not found', 404))
    expect(captured.status).toBe(404)
    expect(captured.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Profile not found' } })
  })

  test('maps a ZodError to a 400', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new ZodError([]))
    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } })
  })

  // A body that is not JSON is the caller's mistake, not a server fault. It used
  // to fall through to the 500 branch, which also made the collector treat a
  // permanently malformed request as a transient failure worth retrying.
  test.each([
    ['SyntaxError from body parsing', new SyntaxError('Unexpected token b in JSON at position 0')],
    ['SyntaxError with no message', new SyntaxError()]
  ])('maps %s to a 400 rather than a 500', (_label, error) => {
    const { c, captured } = fakeContext()
    jsonError(c, error)
    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } })
  })

  test('still reports an unexpected error as a 500', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new Error('database is on fire'))
    expect(captured.status).toBe(500)
    expect(captured.body).toEqual({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } })
  })

  // Error responses must not sit in any cache, matching `publicApiErrorResponse` and
  // `modelPricingErrorResponse`: a cached 401 keeps showing a stale failure, and without a
  // directive a browser may cache a 404 heuristically. This helper is the shared exit for
  // every API error branch, so the header is set here rather than at each call site.
  test.each([
    ['an ApiError', new ApiError('NOT_FOUND', 'Profile not found', 404)],
    ['a ZodError', new ZodError([])],
    ['a SyntaxError', new SyntaxError('Unexpected token b in JSON at position 0')],
    ['an unexpected error', new Error('database is on fire')]
  ])('marks %s response as no-store', (_label, error) => {
    const { c, captured } = fakeContext()
    jsonError(c, error)
    expect(captured.headers?.['cache-control']).toBe('no-store')
  })

  test('keeps the error-specific headers next to no-store', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new ApiError('RATE_LIMITED', 'Too many requests', 429, { 'Retry-After': '30' }))
    expect(captured.headers).toEqual({ 'retry-after': '30', 'cache-control': 'no-store' })
  })

  // An error that carries its own `Cache-Control` must not be able to override the no-store
  // policy: a cached 5xx would keep replaying a transient fault. The error's other headers are
  // still kept, so only the directive is forced.
  test('forces no-store over a Cache-Control the error carried', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new ApiError('INTERNAL_SERVER_ERROR', 'boom', 500, { 'Cache-Control': 'max-age=60' }))
    expect(captured.headers).toEqual({ 'cache-control': 'no-store' })
  })

  // RFC 9110: a 401 should carry a challenge so a generic client knows the scheme. The app's
  // 401s are the collector's only signal about its upload token, which is always a bearer token.
  test('marks a 401 with the Bearer challenge', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new ApiError('UNAUTHORIZED', 'Missing upload token', 401))
    expect(captured.headers).toEqual({ 'www-authenticate': 'Bearer', 'cache-control': 'no-store' })
  })

  // HonoX installs the root `_404` handler as a middleware over the whole app, and it rewrites
  // the body of every 404 the app returns — including the specific one this route just built.
  // Both bodies are JSON, so only the message changed: a device's "no active installation"
  // answer reached the collector as the generic `Route not found`. Marking the response keeps
  // the route's own body, exactly as the page routes do for their HTML not-found pages.
  test('marks a 404 response as route-rendered so the root handler keeps its body', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new ApiError('NOT_FOUND', 'Device has no active installation', 404))
    expect(captured.status).toBe(404)
    expect(captured.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Device has no active installation' }
    })
    expect(isRouteRenderedNotFound(c)).toBe(true)
  })

  // Only a 404 is rewritten by the root handler, so only a 404 may claim to have rendered its
  // own body. Marking anything else would let a later change to the root handler believe an
  // error branch already produced a page.
  test.each([
    ['a 400 ApiError', new ApiError('BAD_REQUEST', 'Invalid request', 400)],
    ['a 401 ApiError', new ApiError('UNAUTHORIZED', 'Missing upload token', 401)],
    ['a 429 ApiError', new ApiError('RATE_LIMITED', 'Too many requests', 429)],
    ['a 500 ApiError', new ApiError('INTERNAL_SERVER_ERROR', 'boom', 500)],
    ['a ZodError', new ZodError([])],
    ['an unexpected error', new Error('database is on fire')]
  ])('leaves %s unmarked', (_label, error) => {
    const { c } = fakeContext()
    jsonError(c, error)
    expect(isRouteRenderedNotFound(c)).toBe(false)
  })
})
