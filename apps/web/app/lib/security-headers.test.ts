import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { securityHeaders } from './security-headers'
import { themeScript, themeScriptHash } from './theme-script'

describe('securityHeaders', () => {
  test('sets a policy that blocks framing and inline script', async () => {
    const headers = await securityHeaders()
    const csp = headers['Content-Security-Policy']

    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    // The whole point of hashing the theme script is that no blanket inline allowance is
    // needed. If either of these creeps back in, the policy has stopped protecting much.
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
  })

  // The beacon is edge-injected, so it cannot be hashed like the theme script. It is
  // allowed by exact origin instead — and the allowance must stay narrow: a wildcard here
  // would let any third-party script run on a session-bearing page.
  test('allows exactly the Cloudflare analytics origins the beacon needs', async () => {
    const csp = (await securityHeaders())['Content-Security-Policy']
    expect(csp).toContain('https://static.cloudflareinsights.com')
    expect(csp).toContain('https://cloudflareinsights.com')
    expect(csp).not.toContain('*')
    // A bare scheme source (`https:`) would allow any https origin, which is the thing a
    // wildcard ban is meant to prevent. Match it as a whole source token, since the
    // allowed origins themselves contain the substring.
    expect(csp.split('; ').flatMap((d) => d.split(' '))).not.toContain('https:')
  })

  test('allows the inline theme script by hash rather than by origin', async () => {
    const csp = (await securityHeaders())['Content-Security-Policy']
    expect(csp).toContain("script-src 'self' 'sha256-")
  })

  // The sign-in form posts to /auth/sign-in, which answers with a 303 to
  // github.com/login/oauth/authorize. Chrome and Safari apply `form-action` to that
  // redirect target, so a `'self'`-only policy silently kills sign-in: the browser blocks
  // the redirect, the request shows as ERR_ABORTED, and the button stays on
  // "正在跳转 GitHub..." forever. It shipped that way once (2026-11-24) because nothing in
  // the suite pinned the allowance; this test is that pin.
  test('allows the GitHub OAuth redirect target in form-action', async () => {
    const csp = (await securityHeaders())['Content-Security-Policy']
    const formAction = csp.split('; ').find((directive) => directive.startsWith('form-action '))
    expect(formAction).toBe("form-action 'self' https://github.com")
  })

  test('sets the remaining hardening headers', async () => {
    const headers = await securityHeaders()
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['X-Frame-Options']).toBe('DENY')
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['Strict-Transport-Security']).toContain('max-age=')
    expect(headers['Permissions-Policy']).toContain('camera=()')
  })
})

// `style-src 'self'` is only safe while nothing in the app renders an inline style
// attribute, because a browser drops such an attribute under this policy and no hash can
// allow it ('unsafe-hashes' covers event handlers, not `style=`). That failure is silent:
// the markup still contains the value, only the painted result differs, and it is not
// limited to HTML — the SVG card is served with the same policy, where a lost `max-width`
// stretched it to the full viewport. Two places were already wrong this way: the bar sizes
// in `dashboard-preview.tsx` (now safelisted percent classes) and the SVG root (now fixed
// intrinsic `width`/`height`). This scans the source so a reintroduction anywhere in
// `app/` fails here rather than on a rendered page.
describe('inline style attributes', () => {
  test('no component renders a style attribute', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const root = new URL('../', import.meta.url).pathname

    async function walk(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true })
      const files: string[] = []
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) files.push(...(await walk(path)))
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path)
      }
      return files
    }

    const offenders: string[] = []
    for (const file of await walk(root)) {
      const source = await readFile(file, 'utf8')
      // Matches the JSX attribute `style=`, not the CSS-in-JS `style:` object key or a
      // prose mention of the word. The app sets runtime positions through the CSSOM
      // (`element.style.left = ...`), which is unaffected and deliberately not matched.
      if (/\sstyle=/.test(source)) offenders.push(file.slice(root.length))
    }

    expect(offenders).toEqual([])
  })
})

// `securityHeaders()` runs on every response, so a cached rejected promise would fail the
// entire site permanently — nothing clears the cache. A transient digest failure must not
// be sticky.
describe('script hash caching', () => {
  test('does not cache a rejected digest', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest')
    digest.mockRejectedValueOnce(new Error('transient digest failure'))

    // The module is already loaded by the tests above, so its cache is warm. Clearing the
    // module registry gives this test its own instance without a query-string import,
    // which the type checker cannot resolve.
    vi.resetModules()
    const { securityHeaders: fresh } = await import('./security-headers')

    await expect(fresh()).rejects.toThrow(/transient digest failure/)
    // The retry must recompute rather than replay the cached rejection.
    const recovered = await fresh()
    expect(recovered['Content-Security-Policy']).toContain("'sha256-")
    digest.mockRestore()
  })
})

// The hash is only useful while it matches the script the renderer actually emits. These
// two live in different modules, so without this check an edit to themeScript would
// silently break the page: the browser would refuse the script and the theme would flash.
describe('themeScriptHash', () => {
  test('matches an independent digest of the emitted script', async () => {
    const expected = `'sha256-${createHash('sha256').update(themeScript, 'utf8').digest('base64')}'`
    expect(await themeScriptHash()).toBe(expected)
  })

  test('is the exact digest embedded in the policy', async () => {
    const csp = (await securityHeaders())['Content-Security-Policy']
    expect(csp).toContain(await themeScriptHash())
  })
})
