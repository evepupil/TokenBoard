import { themeScriptHash } from './theme-script'

// The app had no application-level security headers at all: every response carried only
// what Cloudflare injects at the edge. They are set in one place, at the response
// boundary, so a new route cannot silently ship without them.
//
// Content-Security-Policy is the only non-obvious one. The theme script must run before
// first paint, so it stays inline and is allowlisted by hash rather than by a blanket
// inline allowance — a hash keeps injected script blocked, which is the point of the
// header.
//
// `style-src` carries no inline allowance, and none is possible for a style *attribute*:
// 'unsafe-hashes' covers event-handler attributes, not `style=`, so an element that sizes
// itself inline is silently dropped by the browser. Every style the app sets therefore has
// to be a class, a presentation attribute, or a runtime CSSOM assignment (which this
// directive does not govern). Two places were relying on a style attribute and now are
// not: the dashboard bar sizes in `dashboard-preview.tsx` are safelisted percent utilities
// in `app/style.css`, and the SVG card's root declares a fixed intrinsic size instead of
// `max-width`. `security-headers.test.ts` fails the build if either pattern returns.
//
// frame-ancestors is 'none' rather than the SAMEORIGIN default of X-Frame-Options: the
// dashboard has no reason to be framed, and clickjacking a session-bearing page is the
// risk being closed.
// Cloudflare's Web Analytics beacon is injected into HTML at the edge, not by this Worker,
// so it is not in the source and no hash can cover it. Leaving it blocked is the stricter
// posture but silently disables the zone's analytics — a real loss for a header whose
// purpose is to constrain this app, not to break the platform it runs on. The allowance is
// pinned to the two exact origins the beacon uses: the script it loads and the endpoint it
// reports to. It is not a wildcard, so no other third-party script becomes loadable.
const cloudflareAnalyticsScriptOrigin = 'https://static.cloudflareinsights.com'
const cloudflareAnalyticsConnectOrigin = 'https://cloudflareinsights.com'

// The sign-in form posts to this origin's /auth/sign-in, which answers with a 303 to
// github.com's OAuth authorize endpoint. Chrome and Safari evaluate `form-action` against
// the redirect target of a form submission, not just the submitted URL, so a
// `'self'`-only policy blocks the whole sign-in in those browsers — silently, with the
// request reported as aborted and the button stuck on its submitting label. The origin is
// pinned exactly; this is the only cross-origin target a form submission in this app can
// redirect to (sign-out redirects to '/').
const githubOAuthOrigin = 'https://github.com'

// The script hash is derived from a module-level constant, so it is computed once and
// reused. Every response goes through here — including API responses, static assets and
// 304s — and rehashing per request would be pure waste. The promise is cached rather than
// the resolved value so concurrent first requests share one digest computation.
//
// Only a *successful* digest is kept. Caching the promise unconditionally would make one
// transient failure permanent: `securityHeaders()` runs on every response, so a rejected
// promise left in the cache would fail the whole site from then on, with nothing to clear
// it. Dropping the rejection lets the next request retry.
let scriptHashPromise: Promise<string> | undefined

function cachedThemeScriptHash() {
  if (!scriptHashPromise) {
    scriptHashPromise = themeScriptHash().catch((error: unknown) => {
      scriptHashPromise = undefined
      throw error
    })
  }
  return scriptHashPromise
}

const viteDevClientScriptHash = "'sha256-skbsb8aC0J3t64Itv3lSwl9/M7LOJglCR99BjSMntzI='"

export async function securityHeaders(options?: { allowDevIframe?: boolean }): Promise<Record<string, string>> {
  const scriptHash = await cachedThemeScriptHash()
  const allowDevIframe = options?.allowDevIframe === true
  const scriptSources = allowDevIframe
    ? `'self' ${scriptHash} ${viteDevClientScriptHash} ${cloudflareAnalyticsScriptOrigin}`
    : `'self' ${scriptHash} ${cloudflareAnalyticsScriptOrigin}`

  const cspDirectives = [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${cloudflareAnalyticsConnectOrigin}`,
    `form-action 'self' ${githubOAuthOrigin}`,
    "base-uri 'self'",
    "object-src 'none'"
  ]
  if (!allowDevIframe) {
    cspDirectives.push("frame-ancestors 'none'")
  }

  const headers: Record<string, string> = {
    'Content-Security-Policy': cspDirectives.join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
  }
  if (!allowDevIframe) {
    headers['X-Frame-Options'] = 'DENY'
  }
  return headers
}
