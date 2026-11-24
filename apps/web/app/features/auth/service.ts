import type { Context } from 'hono'
import type { Bindings } from '../../lib/db'
import { createAuth } from './auth'
import { normalizeAuthErrorResponse } from './error-response'

export async function forwardGithubSignIn(c: Context) {
  const response = await postAuth(c, 'sign-in/social', {
    provider: 'github',
    callbackURL: new URL('/dashboard', c.req.url).toString(),
    newUserCallbackURL: new URL('/dashboard', c.req.url).toString(),
    errorCallbackURL: new URL('/auth/sign-in?error=github', c.req.url).toString()
  })

  if (!response.ok) {
    return response
  }

  const body = await response
    .clone()
    .json<Partial<{ url: string }>>()
    .catch(() => ({ url: undefined }))
  return redirectWithCookies(c, response, body.url ?? '/dashboard')
}

export async function forwardAuthSignOut(c: Context) {
  const response = await postAuth(c, 'sign-out', {})
  // A failed sign-out is not a sign-out. Redirecting regardless left the browser on the
  // signed-out page while the session cookie was still valid — precisely the state a user
  // signs out to leave behind. Sign-in already passes failures through (see above); this
  // path has to as well, and `postAuth` has already put the error into the app's shape.
  //
  // Covered: the auth handler refusing the request (its rate limiter's 429, a 401, a 500).
  // NOT covered, and not coverable from here: better-auth's own sign-out catches a failed
  // `deleteSession` and still answers `{success:true}`
  // (`better-auth/dist/api/routes/sign-out.mjs`), so a D1 write failure reaches this function
  // as a 200. The browser still has its session cookie cleared — `deleteSessionCookie` runs
  // either way — so the user is signed out on this device; what survives is the server-side
  // session row, which a stolen copy of the old cookie could still use until it expires. The
  // library does log that case (`Failed to delete session from database`), so it is visible in
  // `wrangler tail`; detecting it here would mean unsigning the cookie and re-reading the
  // session table after every sign-out, which is a worse trade than leaving it to the library.
  if (!response.ok) {
    return response
  }
  return redirectWithCookies(c, response, '/')
}

async function postAuth(c: Context, path: string, body: Record<string, unknown>) {
  const url = new URL(`/api/auth/${path}`, c.req.url)
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: c.req.header('cookie') ?? '',
      origin: new URL(c.req.url).origin,
      // Better Auth's rate limiter resolves the caller from this header. Dropping it here
      // made the app's own sign-in route — the one the form actually posts to — fall into
      // the shared `no-trusted-ip` bucket while the same endpoint reached directly counted
      // against the real address. The two buckets split the budget, and the shared one is
      // the worse half: whoever exhausts it locks out every user on that path. The value
      // is Cloudflare's own, overwritten at the edge, so forwarding it is not trusting the
      // caller.
      ...(c.req.header('cf-connecting-ip') ? { 'cf-connecting-ip': c.req.header('cf-connecting-ip')! } : {})
    },
    body: JSON.stringify(body)
  })

  // Normalized here rather than at each call site: every caller funnels through this
  // function, so a failure answers in the app's error shape wherever it surfaces.
  return normalizeAuthErrorResponse(await createAuth(c.env as Bindings, c.req.raw).handler(request))
}

function redirectWithCookies(c: Context, source: Response, location: string) {
  const response = c.redirect(location, 303)
  source.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      response.headers.append('set-cookie', value)
    }
  })
  // The redirect is built fresh, so the `no-store` the auth handler set on the response it
  // replaces is gone. The 303 carries the sign-in/sign-out `Set-Cookie`, and a shared cache
  // replaying it would hand one visitor's session cookie to the next.
  response.headers.set('Cache-Control', 'no-store')
  return response
}
