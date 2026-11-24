import type { NotFoundHandler } from 'hono'
import { SkipLinkTarget } from '../components/skip-link-target'
import { isRouteRenderedNotFound } from '../lib/not-found'

const handler: NotFoundHandler = (c) => {
  c.header('Cache-Control', 'no-store')

  if (isRouteRenderedNotFound(c)) {
    return c.res
  }

  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404)
  }

  c.status(404)
  return c.render(
    <main class="min-h-[70vh] bg-[var(--app-bg)] px-4 py-16 text-[var(--app-text)] sm:px-8">
      <title>404 Not Found - TokenBoard</title>
      <SkipLinkTarget />
      <section class="app-folio-container max-w-3xl border-t border-[var(--app-border-strong)] pt-8">
        <p class="app-folio-kicker">HTTP 404 · NOT FOUND</p>
        <h1 class="app-folio-display mt-3">404 Not Found</h1>
        <p class="mt-4 text-base text-[var(--app-muted)]">请求的页面不存在或已移动。</p>
        <div class="mt-8 flex flex-wrap gap-3">
          <a
            class="inline-flex min-h-11 items-center border border-[var(--app-border-strong)] bg-[var(--app-text)] px-5 py-2.5 text-sm font-bold text-[var(--app-bg)] transition hover:border-[var(--app-accent-bar)] hover:bg-[var(--app-accent-bar)] hover:text-[var(--app-accent-bar-ink)]"
            href="/"
          >
            返回首页 →
          </a>
          <a
            class="inline-flex min-h-11 items-center border border-[var(--app-border-strong)] bg-[var(--app-panel-strong)] px-5 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-text)] hover:text-[var(--app-bg)]"
            href="/leaderboards"
          >
            查看排行榜
          </a>
        </div>
      </section>
    </main>
  )
}

export default handler
