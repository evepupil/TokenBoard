import type { Context } from 'hono'
import type { Bindings } from '../../lib/db'
import { createAuth } from './auth'

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

  const body = await response.clone().json<Partial<{ url: string }>>().catch(() => ({ url: undefined }))
  return redirectWithCookies(c, response, body.url ?? '/dashboard')
}

export async function forwardAuthSignOut(c: Context) {
  const response = await postAuth(c, 'sign-out', {})
  return redirectWithCookies(c, response, '/')
}

async function postAuth(c: Context, path: string, body: Record<string, unknown>) {
  const url = new URL(`/api/auth/${path}`, c.req.url)
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: c.req.header('cookie') ?? '',
      origin: new URL(c.req.url).origin
    },
    body: JSON.stringify(body)
  })

  return createAuth(c.env as Bindings, c.req.raw).handler(request)
}

function redirectWithCookies(c: Context, source: Response, location: string) {
  const response = c.redirect(location, 303)
  source.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      response.headers.append('set-cookie', value)
    }
  })
  return response
}
