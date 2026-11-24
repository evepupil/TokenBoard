import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test, vi } from 'vitest'
import { AppNav } from '../components/app-nav'
import { SkipLinkTarget } from '../components/skip-link-target'
import { clientVersion, serverVersion } from '../lib/version'
import renderer from './_renderer'

// `_renderer` is the `jsxRenderer(...)` middleware: it installs a layout on the context and calls
// `next()`. This fake captures that layout so the shell markup can be rendered and asserted
// without spinning up the whole HonoX route graph.
function renderShell(children: unknown) {
  let layout: ((props: { children: unknown }) => unknown) | null = null
  const c = {
    getLayout: () => undefined,
    setLayout: (value: (props: { children: unknown }) => unknown) => {
      layout = value
    },
    setRenderer: vi.fn()
  }
  ;(renderer as unknown as (c: unknown, next: () => void) => void)(c, () => undefined)
  if (!layout) throw new Error('renderer did not install a layout')
  return renderToString((layout as (props: { children: unknown }) => unknown)({ children }) as never)
}

describe('app renderer shell', () => {
  // Keyboard and screen-reader users need a way past the repeated navigation on every page.
  // The link must be the first focusable element in `<body>` and point at the anchor the nav
  // renders, or the affordance exists but does nothing.
  test('renders a skip link as the first element in the body, targeting the content anchor', async () => {
    const html = await renderShell(<main>content</main>)

    expect(html).toContain('class="app-skip-link"')
    expect(html).toContain('href="#app-content"')
    expect(html).toContain('跳到主要内容')
    // It must precede the page content so a keyboard user reaches it first.
    expect(html.indexOf('app-skip-link')).toBeLessThan(html.indexOf('<main'))
  })

  // The link and the anchor it targets live in different files (the shell and `AppNav`), so a
  // rename on one side would otherwise leave a link that jumps nowhere. Compare the two directly
  // rather than asserting the literal twice, which is exactly the drift this guards against.
  test('points the skip link at the anchor the nav actually renders', async () => {
    const shellHtml = await renderShell(<main>content</main>)
    const navHtml = await renderToString(<AppNav isAuthenticated={false} />)

    const linkTarget = shellHtml.match(/class="app-skip-link"[^>]*href="#([^"]+)"/)?.[1]
    const anchorId = navHtml.match(/id="([^"]+)"[^>]*tabindex="-1"/)?.[1]

    expect(linkTarget).toBeDefined()
    expect(anchorId).toBe(linkTarget)
  })

  // The 404 and error surfaces render no `AppNav`, so they have to render the anchor themselves
  // or the shell's skip link becomes a dead target on exactly those pages. Both the nav and these
  // surfaces use the shared `SkipLinkTarget`, so this pins the component's id to the shell's href.
  test('the fallback anchor for nav-less pages matches the shell skip link', async () => {
    const shellHtml = await renderShell(<main>content</main>)
    const fallbackHtml = await renderToString(<SkipLinkTarget />)

    const linkTarget = shellHtml.match(/class="app-skip-link"[^>]*href="#([^"]+)"/)?.[1]
    const fallbackId = fallbackHtml.match(/id="([^"]+)"[^>]*tabindex="-1"/)?.[1]

    expect(linkTarget).toBeDefined()
    expect(fallbackId).toBe(linkTarget)
  })

  // The footer is the only place the running deployment names itself. Both numbers must come
  // from the shared constants — a literal here would drift from `/api/public/version`, which is
  // the machine-readable twin of this line.
  test('renders the server and client versions in a footer after the page content', async () => {
    const html = await renderShell(<main>content</main>)

    expect(html).toContain(`服务端 v${serverVersion}`)
    expect(html).toContain(`客户端 v${clientVersion}`)
    expect(html).toContain('data-app-version="true"')
    // The line belongs to the page shell, not to any route: it has to come after the content
    // so it reads as a footer rather than a banner.
    expect(html.indexOf('data-app-version')).toBeGreaterThan(html.indexOf('<main'))
  })
})
