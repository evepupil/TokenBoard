import { describe, expect, test, vi } from 'vitest'
import { forwardAuthSignOut, forwardGithubSignIn } from './service'

// `postAuth` re-issues the request before handing it to Better Auth. Anything it fails to
// copy is invisible to the auth handler, and the rate limiter reads the caller's address
// from a header — so a dropped header silently splits the budget between a per-address
// bucket and the shared `no-trusted-ip` one. That shared bucket is the dangerous half:
// exhausting it locks out every user of that path, not just the caller.
vi.mock('./auth', () => ({
  authBasePath: '/api/auth',
  createAuth: () => ({
    handler: async (request: Request) => {
      captured.push(request)
      return nextAuthResponse()
    }
  })
}))

const captured: Request[] = []

// The default is a successful sign-in handoff. Tests that need a failure (the sign-out
// swallow below) swap it for one request.
let authResponder = () =>
  new Response(JSON.stringify({ url: 'https://github.com/login/oauth/authorize' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

function nextAuthResponse() {
  return authResponder()
}

function contextWith(headers: Record<string, string>) {
  const url = 'https://example.test/auth/sign-in'
  return {
    env: {},
    req: {
      url,
      raw: new Request(url, { method: 'POST', headers }),
      header: (name: string) => headers[name.toLowerCase()]
    },
    redirect: (location: string, status: number) =>
      new Response(null, { status, headers: { location, 'cache-control': 'max-age=0' } })
  }
}

describe('forwardGithubSignIn', () => {
  test('forwards the Cloudflare client address to the auth handler', async () => {
    captured.length = 0
    await forwardGithubSignIn(contextWith({ 'cf-connecting-ip': '203.0.113.7' }) as never)
    expect(captured).toHaveLength(1)
    expect(captured[0].headers.get('cf-connecting-ip')).toBe('203.0.113.7')
  })

  test('still carries the cookie and origin the auth handler needs', async () => {
    captured.length = 0
    await forwardGithubSignIn(
      contextWith({ cookie: 'tb=abc', origin: 'https://example.test', 'cf-connecting-ip': '203.0.113.7' }) as never
    )
    expect(captured[0].headers.get('cookie')).toBe('tb=abc')
    expect(captured[0].headers.get('origin')).toBe('https://example.test')
  })

  test('omits the header entirely when the edge did not supply one', async () => {
    captured.length = 0
    await forwardGithubSignIn(contextWith({}) as never)
    expect(captured[0].headers.get('cf-connecting-ip')).toBeNull()
  })

  // The 303 carries the sign-in `Set-Cookie`, so a shared cache replaying it would hand one
  // visitor's session cookie to the next. `c.redirect` builds a fresh response that does not
  // inherit the `no-store` the auth handler set, so `redirectWithCookies` has to set it again.
  test('marks the sign-in redirect no-store so a shared cache cannot replay the cookie', async () => {
    captured.length = 0
    const response = await forwardGithubSignIn(contextWith({ cookie: 'tb=abc' }) as never)

    expect(response.status).toBe(303)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('location')).toBe('https://github.com/login/oauth/authorize')
  })
})

describe('forwardAuthSignOut', () => {
  // A failed sign-out used to be rewritten into the same 303 a successful one returns, so the
  // browser landed on `/dashboard` showing a signed-out face while the session cookie was still
  // live — the user believes the session is gone and walks away from a machine that is still
  // authenticated. Sign-in already passes a failure through; sign-out has to as well.
  test.each([
    [429, 'RATE_LIMITED'],
    [401, 'UNAUTHORIZED'],
    [500, 'INTERNAL_SERVER_ERROR']
  ])('passes a failed sign-out through as %i instead of redirecting', async (status, code) => {
    authResponder = () => new Response(JSON.stringify({ message: 'nope' }), { status })
    captured.length = 0

    const response = await forwardAuthSignOut(contextWith({ cookie: 'tb=abc' }) as never)
    authResponder = () =>
      new Response(JSON.stringify({ url: 'https://github.com/login/oauth/authorize' }), { status: 200 })

    expect(response.status).toBe(status)
    expect(response.headers.get('location')).toBeNull()
    await expect(response.json()).resolves.toEqual({ error: { code, message: 'nope' } })
  })

  // The successful path still has to redirect, and still has to carry the cleared-session
  // cookie plus `no-store` — a shared cache replaying that redirect would hand one visitor's
  // post-sign-out state to the next.
  test('redirects to the landing page after a successful sign-out', async () => {
    captured.length = 0
    const response = await forwardAuthSignOut(contextWith({ cookie: 'tb=abc' }) as never)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
