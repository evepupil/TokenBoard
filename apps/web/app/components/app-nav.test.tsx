import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { AppNav } from './app-nav'

describe('AppNav', () => {
  test('uses the TokenBoard SVG logo in the brand link', async () => {
    const html = await renderToString(<AppNav isAuthenticated={false} />)

    expect(html).toContain('src="/logo.svg"')
    expect(html).toContain('alt="TokenBoard"')
    expect(html).toContain('href="/auth/sign-in"')
    expect(html).toContain('data-login-focus="true"')
  })

  test('wraps authenticated navigation without clipping narrow viewports', async () => {
    const html = await renderToString(<AppNav active="dashboard" email="user@example.com" />)

    expect(html).toContain('flex min-w-0 flex-wrap')
    expect(html).not.toContain('overflow-x-auto')
    expect(html).not.toContain('min-w-max')
    expect(html).toContain('flex min-w-0 items-center justify-between')
    expect(html).toContain('group flex min-w-0 items-center gap-3')
    expect(html).toContain('block truncate text-base')
    expect(html).toContain('<span class="sm:hidden">安装</span>')
    expect(html).toContain('<span class="sm:hidden">资料</span>')
    expect(html).toContain('aria-current="page" href="/dashboard"')
    expect(html).not.toContain('aria-current="page" href="/settings/devices"')
    expect(html).toContain('data-submit-feedback="true"')
    expect(html).toContain('data-submitting-label="正在退出..."')
  })

  // The press feedback is a transform, which browsers ignore on an inline box — this pins
  // both the inline-flex display and the class that carries the scale, so a refactor cannot
  // silently make the nav feel dead again.
  test('nav links carry the press-scale feedback', async () => {
    const html = await renderToString(<AppNav active="dashboard" email="user@example.com" />)

    const link = html.match(/<a[^>]*data-app-nav-link="true"[^>]*>/)?.[0]
    expect(link).toBeDefined()
    expect(link).toContain('inline-flex')
    expect(link).toContain('active:scale-[0.96]')
  })

  test('supports compact dashboard navigation density', async () => {
    const html = await renderToString(<AppNav active="dashboard" email="user@example.com" compact />)

    expect(html).toContain('mb-3')
    expect(html).toContain('xl:py-2')
    expect(html).toContain('h-9 w-9')
    expect(html).toContain('px-3 py-2')
    expect(html).not.toContain('xl:px-3 xl:py-2')
  })

  // Every page has exactly one `<nav>` and one `<main>`, so the nav has to be labelled — an
  // unlabelled nav is a landmark a screen-reader user cannot identify or jump between.
  test('labels the navigation landmark', async () => {
    const html = await renderToString(<AppNav isAuthenticated={false} />)

    expect(html).toContain('aria-label="主导航"')
  })

  // The shell's "skip to content" link targets `#app-content`. On nav-bearing pages the anchor
  // is rendered after the nav (not on `<main>`, which this app wraps around the nav, so an
  // anchor there would land the user before the very navigation they meant to skip). Pages
  // without a nav (404/error) render their own copy — see `skip-link-target.tsx`.
  test('renders the skip-link target just after the nav landmark', async () => {
    const html = await renderToString(<AppNav isAuthenticated={false} />)

    expect(html).toContain('id="app-content"')
    expect(html).toContain('tabindex="-1"')
    expect(html.indexOf('</nav>')).toBeLessThan(html.indexOf('id="app-content"'))
  })
})
