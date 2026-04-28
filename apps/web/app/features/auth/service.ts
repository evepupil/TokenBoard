import type { Context } from 'hono'
import type { Bindings } from '../../lib/db'
import { createAuth } from './auth'

export async function forwardAuthForm(
  c: Context,
  path: string,
  body: Record<string, unknown>,
  successPath = '/dashboard'
) {
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

  const response = await createAuth(c.env as Bindings, c.req.raw).handler(request)
  if (!response.ok) {
    return response
  }

  return redirectWithCookies(c, response, successPath)
}

export async function forwardAuthSignOut(c: Context) {
  const url = new URL('/api/auth/sign-out', c.req.url)
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: c.req.header('cookie') ?? '',
      origin: new URL(c.req.url).origin
    },
    body: JSON.stringify({})
  })

  const response = await createAuth(c.env as Bindings, c.req.raw).handler(request)
  return redirectWithCookies(c, response, '/')
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
