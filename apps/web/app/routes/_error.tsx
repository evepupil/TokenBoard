import type { ErrorHandler } from 'hono'
import { ApiError } from '../lib/errors'

const handler: ErrorHandler = (e, c) => {
  if ('getResponse' in e) {
    return e.getResponse()
  }
  if (e instanceof ApiError && e.code === 'UNAUTHORIZED') {
    if (expectsJson(c)) {
      return c.json({ error: { code: e.code, message: e.message } }, e.status)
    }
    return c.redirect('/auth/sign-in')
  }
  if (e instanceof ApiError) {
    c.status(e.status)
    return c.render(e.message)
  }
  console.error(e.message)
  c.status(500)
  return c.render('Internal Server Error')
}

export default handler

function expectsJson(c: Parameters<ErrorHandler>[1]) {
  return c.req.path.startsWith('/api/') ||
    (c.req.header('accept') || '').includes('application/json')
}
