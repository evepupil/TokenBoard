import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { AppNav } from './app-nav'

describe('AppNav', () => {
  test('uses the TokenBoard SVG logo in the brand link', async () => {
    const html = await renderToString(<AppNav isAuthenticated={false} />)

    expect(html).toContain('src="/logo.svg"')
    expect(html).toContain('alt="TokenBoard"')
  })

  test('keeps authenticated mobile navigation in a horizontal scroll rail', async () => {
    const html = await renderToString(<AppNav active="dashboard" email="user@example.com" />)

    expect(html).toContain('data-app-nav-scroll="true"')
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('xl:overflow-visible')
    expect(html).toContain('min-w-max')
  })

  test('supports compact dashboard navigation density', async () => {
    const html = await renderToString(<AppNav active="dashboard" email="user@example.com" compact />)

    expect(html).toContain('mb-3')
    expect(html).toContain('xl:py-2')
    expect(html).toContain('h-9 w-9')
    expect(html).toContain('px-3 py-2 xl:px-3 xl:py-2')
  })
})
