import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { AppNav } from './app-nav'

describe('AppNav', () => {
  test('uses the TokenBoard SVG logo in the brand link', async () => {
    const html = await renderToString(<AppNav isAuthenticated={false} />)

    expect(html).toContain('src="/logo.svg"')
    expect(html).toContain('alt="TokenBoard"')
  })
})
