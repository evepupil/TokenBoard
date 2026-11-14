import { describe, expect, test } from 'vitest'
import { normalizeAuthErrorResponse } from './error-response'

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

describe('normalizeAuthErrorResponse', () => {
  test('reshapes a Better Auth error into the app error contract', async () => {
    const response = await normalizeAuthErrorResponse(
      jsonResponse({ message: 'Email and password is not enabled', code: 'EMAIL_PASSWORD_DISABLED' }, 400)
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'EMAIL_PASSWORD_DISABLED', message: 'Email and password is not enabled' }
    })
  })

  test('leaves a successful response untouched', async () => {
    const original = jsonResponse({ token: 'abc', user: { id: 'u1' } }, 200, {
      'set-cookie': 'session=xyz; Path=/; HttpOnly'
    })
    const response = await normalizeAuthErrorResponse(original)

    expect(response).toBe(original)
    // The session body and Set-Cookie must survive verbatim: rebuilding a success would
    // risk dropping the header that makes sign-in work.
    expect(response.headers.get('set-cookie')).toBe('session=xyz; Path=/; HttpOnly')
    await expect(response.json()).resolves.toEqual({ token: 'abc', user: { id: 'u1' } })
  })

  // The session body is per-user state and the Better Auth handler sits outside the
  // `requireUser` middleware that sets this for the app's own routes, so it has to be set here.
  test('marks a successful session response no-store without rebuilding it', async () => {
    const original = jsonResponse({ session: { id: 's1' } }, 200, {
      'set-cookie': 'session=xyz; Path=/; HttpOnly'
    })
    const response = await normalizeAuthErrorResponse(original)

    expect(response).toBe(original)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toBe('session=xyz; Path=/; HttpOnly')
  })

  test('marks an auth failure no-store', async () => {
    const response = await normalizeAuthErrorResponse(jsonResponse({ message: 'Unauthorized' }, 401))

    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  test('leaves redirects untouched', async () => {
    const original = new Response(null, { status: 302, headers: { location: 'https://github.com/login' } })
    expect(await normalizeAuthErrorResponse(original)).toBe(original)
  })

  // `Response.redirect` carries immutable headers, so setting Cache-Control on it throws. The
  // no-store boundary has to swallow that — a redirect has no cacheable body — rather than let
  // the sign-in hand-off fail.
  test('does not fail on a redirect whose headers are immutable', async () => {
    const redirect = Response.redirect('https://github.com/login', 302)
    const response = await normalizeAuthErrorResponse(redirect)

    expect(response).toBe(redirect)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://github.com/login')
  })

  test('supplies a code when Better Auth sends only a message', async () => {
    const response = await normalizeAuthErrorResponse(jsonResponse({ message: 'Invalid email' }, 400))
    await expect(response.json()).resolves.toEqual({
      error: { code: 'BAD_REQUEST', message: 'Invalid email' }
    })
  })

  test('maps status to a code for an unmapped failure', async () => {
    const response = await normalizeAuthErrorResponse(jsonResponse({ message: 'nope' }, 429))
    await expect(response.json()).resolves.toEqual({
      error: { code: 'RATE_LIMITED', message: 'nope' }
    })
  })

  test('supplies a message when Better Auth sends only a code', async () => {
    const response = await normalizeAuthErrorResponse(jsonResponse({ code: 'SOMETHING' }, 403))
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SOMETHING', message: 'Request failed' }
    })
  })

  test('does not double-wrap an error already in the app shape', async () => {
    const response = await normalizeAuthErrorResponse(
      jsonResponse({ error: { code: 'X', message: 'already shaped' } }, 400)
    )
    await expect(response.json()).resolves.toEqual({ error: { code: 'X', message: 'already shaped' } })
  })

  test('leaves a non-JSON error body alone', async () => {
    const original = new Response('<html>oops</html>', {
      status: 500,
      headers: { 'content-type': 'text/html' }
    })
    expect(await normalizeAuthErrorResponse(original)).toBe(original)
  })

  test('leaves an unparseable JSON body alone rather than inventing a message', async () => {
    const original = new Response('{not json', {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })
    const response = await normalizeAuthErrorResponse(original)
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('{not json')
  })

  // Better Auth's rate limiter writes a JSON body through `new Response(...)` without
  // setting Content-Type, so it reaches us as `text/plain`. Matching on the header alone
  // therefore skipped exactly the response this adapter exists to reshape.
  test('reshapes a JSON error body that arrived without a JSON content type', async () => {
    const original = new Response(JSON.stringify({ message: 'Too many requests. Please try again later.' }), {
      status: 429,
      headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-retry-after': '8' }
    })
    const response = await normalizeAuthErrorResponse(original)

    expect(response.status).toBe(429)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('retry-after')).toBe('8')
    await expect(response.json()).resolves.toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' }
    })
  })

  test('still leaves a non-JSON body alone even when the content type is missing', async () => {
    const original = new Response('<html>oops</html>', { status: 500 })
    expect(await normalizeAuthErrorResponse(original)).toBe(original)
  })
})
