import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { AppNav } from './app-nav'

describe('AppNav', () => {
  test('uses the TokenBoard SVG logo in the brand link', async () => {
    const html = await renderToString(<AppNav isAuthenticated={false} />)

    expect(html).toContain('src="/logo.svg"')
    expect(html).toContain('alt="TokenBoard"')
  })

  test('wraps authenticated navigation without clipping narrow viewports', async () => {
    const html = await renderToString(<AppNav active="dashboard" email="user@example.com" />)

    expect(html).toContain('data-app-nav-scroll="true"')
    expect(html).toContain('flex min-w-0 flex-wrap')
    expect(html).not.toContain('overflow-x-auto')
    expect(html).not.toContain('min-w-max')
    expect(html).toContain('flex min-w-0 items-center justify-between')
    expect(html).toContain('group flex min-w-0 items-center gap-3')
    expect(html).toContain('block truncate text-base')
    expect(html).toContain('<span class="sm:hidden">安装</span>')
    expect(html).toContain('<span class="sm:hidden">资料</span>')
  })

  test('supports compact dashboard navigation density', async () => {
    const html = await renderToString(<AppNav active="dashboard" email="user@example.com" compact />)

    expect(html).toContain('mb-3')
    expect(html).toContain('xl:py-2')
    expect(html).toContain('h-9 w-9')
    expect(html).toContain('px-3 py-2')
    expect(html).not.toContain('xl:px-3 xl:py-2')
  })
})
