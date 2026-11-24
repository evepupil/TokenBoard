import type { ErrorHandler } from 'hono'
import { SkipLinkTarget } from '../components/skip-link-target'
import { ApiError } from '../lib/errors'

const handler: ErrorHandler = (e, c) => {
  if ('getResponse' in e) {
    return e.getResponse()
  }
  if (e instanceof ApiError && e.code === 'UNAUTHORIZED') {
    if (expectsJson(c)) {
      return c.json({ error: { code: e.code, message: e.message } }, e.status, e.headers)
    }
    return c.redirect('/auth/sign-in')
  }
  if (e instanceof ApiError) {
    if (expectsJson(c)) {
      return c.json({ error: { code: e.code, message: e.message } }, e.status, e.headers)
    }
    for (const [name, value] of Object.entries(e.headers ?? {})) c.header(name, value)
    c.status(e.status)
    return c.render(
      <main class="min-h-[70vh] bg-[var(--app-bg)] px-4 py-16 text-[var(--app-text)] sm:px-8">
        <SkipLinkTarget />
        <section class="app-folio-container max-w-3xl border-t border-[var(--app-border-strong)] pt-8">
          <p class="app-folio-kicker">HTTP {e.status} · {e.code}</p>
          <h1 class="app-folio-h2 mt-3">{e.message}</h1>
        </section>
      </main>
    )
  }
  if (expectsJson(c)) {
    console.error(e.message)
    return c.json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } }, 500, {
      'Cache-Control': 'no-store'
    })
  }
  console.error(e.message)
  c.status(500)
  return c.render(
    <main class="min-h-[70vh] bg-[var(--app-bg)] px-4 py-16 text-[var(--app-text)] sm:px-8">
      <SkipLinkTarget />
      <section class="app-folio-container max-w-3xl border-t border-[var(--app-border-strong)] pt-8">
        <p class="app-folio-kicker">HTTP 500 · SYSTEM FAULT</p>
        <h1 class="app-folio-h2 mt-3">Internal Server Error</h1>
      </section>
    </main>
  )
}

export default handler

function expectsJson(c: Parameters<ErrorHandler>[1]) {
  return c.req.path.startsWith('/api/') || (c.req.header('accept') || '').includes('application/json')
}
