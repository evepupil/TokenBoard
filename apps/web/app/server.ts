import { showRoutes } from 'hono/dev'
import { createApp } from 'honox/server'
import { backfillUsageSummaryCache, usageSummaryBackfillLimit } from './features/ingest/repository'
import { runDueWebhookNotifications } from './features/notifications/service'
import { webhookDiagnostic } from './features/notifications/config'
import { modelPricingSyncEnabled, runModelPricingSync } from './features/model-pricing/service'
import { createCachedModelPricingResponse } from './features/model-pricing/http'
import {
  createPublicUsageResponse,
  parsePublicUsagePath,
  publicApiErrorResponse,
  PUBLIC_API_CLIENT_CACHE_CONTROL,
  PUBLIC_API_WORKER_CACHE_CONTROL
} from './features/public-card/http'
import { assertPublicUsageVisible } from './features/public-card/service'
import { pruneDeviceRetention } from './features/device/retention'
import { usageSummaryStrictMode } from './features/usage/deduped-daily-usage'
import type { Bindings } from './lib/db'
import {
  clientIpRateLimitSubject,
  enforceRateLimit,
  pruneExpiredRateLimits,
  readRateLimitPolicies
} from './lib/rate-limit'
import { securityHeaders } from './lib/security-headers'

const app = createApp()

showRoutes(app)

export default {
  async fetch(request, env, ctx) {
    const headers = await securityHeaders()
    const redirect = httpsRedirect(request)
    if (redirect) return withSecurityHeaders(redirect, headers)

    const publicResponse = await handlePublicApiRequest(request, env, ctx)
    if (publicResponse) return withResponsePolicies(withSecurityHeaders(publicResponse, headers), request)

    const response = await app.fetch(request, env, ctx)
    if (response.status === 404 && shouldFetchStaticAsset(request)) {
      const asset = await env.ASSETS?.fetch(request)
      // The assets binding answers a missing file with an empty 404 — no body, no content-type —
      // and `?? response` only covers a missing binding, not a present one. That empty answer would
      // replace the app's own 404 (HTML for pages, `{error}` JSON for the API), so every path ending
      // in an extension (robots.txt, sitemap.xml, …) lost the stable error shape `_404` exists to
      // give. A found asset is used as-is; anything else falls back to the app's 404, which
      // `withResponsePolicies` already forces to no-store below.
      return withResponsePolicies(
        withSecurityHeaders(asset && asset.status !== 404 ? asset : response, headers),
        request
      )
    }
    return withResponsePolicies(withSecurityHeaders(response, headers), request)
  },
  scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime)
    ctx.waitUntil(runScheduledTasks(env, now))
  }
} satisfies ExportedHandler<Bindings>

async function handlePublicApiRequest(request: Request, env: Bindings, ctx: ExecutionContext) {
  if (request.method !== 'GET') return null

  try {
    const url = new URL(request.url)
    if (url.pathname === '/api/public/model-pricing') {
      // The Worker cache only stores 200s, so a request that misses it — a novel
      // `?cursor=`, a rejected limit — reaches D1 every time. Without a ceiling that
      // is an unbounded anonymous read path; `/api/v1/model-pricing` and the public
      // card route both cap at 120/60s, and this is the same shape of endpoint.
      await enforceRateLimit(env.DB, {
        policy: readRateLimitPolicies.publicModelPricingRead,
        subject: clientIpRateLimitSubject(request.headers)
      })
      return createCachedModelPricingResponse({
        db: env.DB,
        url,
        requestHeaders: request.headers,
        waitUntil: ctx.waitUntil.bind(ctx)
      })
    }
    // Paths that fail to parse (a bad extension, malformed encoding) throw before any D1 read,
    // so they stay free; the ceiling belongs exactly where the slug lookup starts reading.
    const route = parsePublicUsagePath(url.pathname)
    if (!route) return null

    // This entrypoint answers before the HonoX route does, so the ceiling has to live here as
    // well; capping only the route would guard a path the worker never reaches. The 404 and
    // private answers are `no-store` and never cached, so every anonymous probe reaches D1.
    await enforceRateLimit(env.DB, {
      policy: readRateLimitPolicies.publicCardRead,
      subject: clientIpRateLimitSubject(request.headers)
    })

    const summaryStrict = usageSummaryStrictMode(env)
    const cache = publicApiCache()
    const subject = await assertPublicUsageVisible(env.DB, route.slug)
    const cacheKey = cache && subject ? await publicApiCacheKey(url, route, subject, summaryStrict) : null
    if (cache && cacheKey) {
      const cached = await cache.match(cacheKey)
      if (cached) return publicApiClientCacheResponse(cached)
    }

    const response = await createPublicUsageResponse({
      db: env.DB,
      route,
      configuredOrigin: env.BETTER_AUTH_URL,
      requestOrigin: url.origin,
      summaryStrict
    })
    if (cache && cacheKey && response.ok) {
      ctx.waitUntil(cache.put(cacheKey, publicApiWorkerCacheResponse(response)))
    }
    return response
  } catch (error) {
    return publicApiErrorResponse(error)
  }
}

type PublicApiSubject = {
  userId: string
  updatedAt: string
  usageUpdatedAt: string
  summaryUpdatedAt: string
}

async function publicApiCacheKey(
  url: URL,
  route: { slug: string; format: 'json' | 'svg' },
  subject: PublicApiSubject,
  summaryStrict: boolean
) {
  const cacheUrl = new URL(`${url.origin}/api/public/${encodeURIComponent(route.slug)}.${route.format}`)
  cacheUrl.searchParams.set(
    '__tokenboard_public_subject',
    await sha256Hex(
      `${subject.userId}:${subject.updatedAt}:${subject.usageUpdatedAt}:${subject.summaryUpdatedAt}:${summaryStrict ? 'strict' : 'fallback'}`
    )
  )
  return new Request(cacheUrl.toString())
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function publicApiCache() {
  const workerCaches = typeof caches === 'undefined' ? null : (caches as unknown as { default?: Cache })
  return workerCaches?.default ?? null
}

function publicApiWorkerCacheResponse(response: Response) {
  return publicApiCacheControlResponse(response.clone(), PUBLIC_API_WORKER_CACHE_CONTROL)
}

function publicApiClientCacheResponse(response: Response) {
  return publicApiCacheControlResponse(response, PUBLIC_API_CLIENT_CACHE_CONTROL)
}

function publicApiCacheControlResponse(response: Response, cacheControl: string) {
  const headers = new Headers(response.headers)
  headers.set('cache-control', cacheControl)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

function shouldFetchStaticAsset(request: Request) {
  const { pathname } = new URL(request.url)
  if (pathname.startsWith('/api/')) return false
  return pathname.startsWith('/static/') || /\.[a-z0-9][a-z0-9-]*$/i.test(pathname)
}

// The zone may answer plaintext HTTP when Always Use HTTPS is off, which would let session
// cookies and the ingest bearer token travel in the clear; this closes that gap in the Worker
// itself instead of depending on a dashboard setting. The scheme comes from `cf-visitor`,
// which Cloudflare sets per request to the client-facing scheme — `request.url` cannot be
// trusted for this, since Cloudflare may already have rewritten it to the zone's configured
// scheme. Trusting the header alone is also what keeps this loop-free: the browser reconnects
// over https, and that request carries `{"scheme":"https"}`, so no second redirect fires. 308
// rather than 301, so an ingest POST keeps its method and body across the redirect. A missing
// or unparseable header means local `wrangler dev` or a non-Cloudflare runtime, where serving
// the request plainly is correct.
function httpsRedirect(request: Request): Response | null {
  const visitor = request.headers.get('cf-visitor')
  if (!visitor) return null
  let scheme: unknown
  try {
    scheme = (JSON.parse(visitor) as { scheme?: unknown }).scheme
  } catch {
    return null
  }
  if (scheme !== 'http') return null
  const url = new URL(request.url)
  url.protocol = 'https:'
  return Response.redirect(url.href, 308)
}

async function runScheduledTasks(env: Bindings, now: Date) {
  const dailyMaintenance = isDailyMaintenanceWindow(now)
  const results = await Promise.allSettled([
    runUsageSummaryBackfill(env),
    runScheduledNotifications(env, now),
    dailyMaintenance ? runRateLimitPrune(env, now) : Promise.resolve(),
    dailyMaintenance ? runDeviceRetentionPrune(env, now) : Promise.resolve(),
    runScheduledModelPricing(env)
  ])
  const reasons = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (reasons.length === 0) return
  for (const reason of reasons) {
    console.error(`TokenBoard scheduled task failed: ${errorMessage(reason)}`)
  }
  if (reasons.length === 1) throw reasons[0]
  throw new AggregateError(reasons, 'TokenBoard scheduled tasks failed')
}

/**
 * The cron fires every 15 minutes, but a DELETE that matches nothing still costs a scheduled
 * query. The once-per-day prunes (rate limits, device retention) therefore run only in the
 * first tick of the UTC day; a missed tick just delays them to the next UTC day, which is
 * fine for retention windows measured in days. This predicate assumes the cron interval is
 * at least 15 minutes — a tighter schedule would re-enter the window within hour 0.
 */
function isDailyMaintenanceWindow(now: Date) {
  return now.getUTCHours() === 0 && now.getUTCMinutes() < 15
}

async function runScheduledModelPricing(env: Bindings) {
  try {
    if (!modelPricingSyncEnabled(env)) return
    const result = await runModelPricingSync({ env, now: new Date() })
    if (result.status === 'success' && result.zeroFlips.length > 0) {
      console.error(
        `TokenBoard model pricing sync: ${result.zeroFlips.length} model(s) flipped to a zero price by the source — ` +
          'a legitimate free launch or an upstream regression; verify before trusting the affected costs: ' +
          result.zeroFlips.join(', ')
      )
    }
    // A source payload that lost most of the catalogue is the same failure class as the
    // zero-price flips above, one order of magnitude larger: every removed model is
    // deactivated, collectors fall back to $0 costs for them, and every cursor and ETag is
    // invalidated by the new generation. The source has changed shape before (0025/0038
    // were the patches for it), so this is reported loudly rather than left to the next
    // day's successful sync.
    if (result.status === 'success' && isCatalogueCollapse(result)) {
      console.error(
        `TokenBoard model pricing sync: the source deactivated ${result.removalCount} of ` +
          `${result.storedModelCount} served model(s) in one sync — verify the upstream payload before ` +
          'trusting the catalogue; collectors will bill the removed models at $0 until it recovers'
      )
    }
  } catch (error) {
    console.error(`TokenBoard model pricing sync failed: ${errorMessage(error)}`)
    throw error
  }
}

// isCatalogueCollapse reports a sync that removed the majority of the catalogue. A real
// upstream retirement is a handful of models a day; losing more than half in one payload
// means the response was truncated or reshaped.
export function isCatalogueCollapse(result: { removalCount?: number; storedModelCount?: number }): boolean {
  const removed = result.removalCount ?? 0
  const stored = result.storedModelCount ?? 0
  return stored > 0 && removed * 2 > stored
}

async function runScheduledNotifications(env: Bindings, now: Date) {
  try {
    await runDueWebhookNotifications({ env, now })
  } catch (error) {
    console.error(`TokenBoard scheduled notifications failed: ${errorMessage(error)}`)
    throw error
  }
}

async function runUsageSummaryBackfill(env: Bindings) {
  try {
    await backfillUsageSummaryCache({
      db: env.DB,
      limit: usageSummaryBackfillLimit(env)
    })
  } catch (error) {
    console.error(`TokenBoard usage summary backfill failed: ${errorMessage(error)}`)
    throw error
  }
}

async function runRateLimitPrune(env: Bindings, now: Date) {
  try {
    await pruneExpiredRateLimits(env.DB, now)
  } catch (error) {
    console.error(`TokenBoard rate limit cleanup failed: ${errorMessage(error)}`)
    throw error
  }
}

async function runDeviceRetentionPrune(env: Bindings, now: Date) {
  try {
    await pruneDeviceRetention(env.DB, now)
  } catch (error) {
    console.error(`TokenBoard device retention cleanup failed: ${errorMessage(error)}`)
    throw error
  }
}

// These strings go to the Worker log, not to a response body: the HTTP boundary keeps the
// user-facing message generic (`WebhookConfigurationError`), so the log is the one place the
// actionable detail — e.g. that WEBHOOK_ENCRYPTION_KEY is unconfigured — has to survive.
function errorMessage(error: unknown) {
  return webhookDiagnostic(error) ?? (error instanceof Error ? error.message : String(error))
}

// Applied at the single response boundary rather than per route, so a new route cannot
// ship without them. Existing headers win: a route that sets its own Cache-Control or
// Content-Type must not have it clobbered by a blanket default.
function withSecurityHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers)
  for (const [name, value] of Object.entries(headers)) {
    if (!merged.has(name)) merged.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged
  })
}

// Cache policy for the Worker's own responses, decided at the same boundary. Three
// decisions are forced, and they must outrank whatever directive arrived:
//
// - 404 always ends up `no-store`. The assets binding serves a missing file with its own
//   revalidation directive, and the zone's cache-by-extension list covers `.js`-style paths,
//   so the edge could keep serving a 404 after the file is deployed. The honox `_404`
//   handler sets `no-store` for framework 404s; forcing it here covers the assets fallback,
//   which bypasses that handler.
// - A build-emitted content-hashed filename (`client-<hash>.js`, `style-<hash>.css`) is
//   immutable: its bytes cannot change under that URL, so it is marked
//   `public, max-age=31536000, immutable` — outranking the assets binding's default
//   `public, max-age=0, must-revalidate`, which would otherwise cost a revalidation per
//   load. (Docs: headers on the Response object returned to the client take precedence over
//   the binding's default, which is why a forced set here works.)
// - HTML without a directive gets `no-store`: a cache hit on a shared machine must not
//   show the previous user's account. Page routes already set it; this keeps a future
//   route honest.
//
// Everything else keeps its directive: route and platform headers pass through untouched —
// especially public API and non-hashed assets, whose explicit revalidation policies are
// safer than pretending an unhashed logo is immutable.
//
// Deliberately not delegated to a Cloudflare `_headers` file: the immutable rule is
// conditional on a verified Vite filename shape, must not become a broad `/static` rule,
// and `_headers` does not apply to responses this Worker returns. `run_worker_first` means
// the assets binding path already reaches this boundary in this deployment.
function withResponsePolicies(response: Response, request: Request): Response {
  const headers = new Headers(response.headers)

  if (response.status === 404) {
    headers.set('Cache-Control', 'no-store')
  } else if ((response.status === 200 || response.status === 304) && isImmutableHashedAsset(request.url)) {
    // A conditional request for a hashed asset answers 304, whose `ok` is false but which carries
    // no body of its own — RFC 9111 §4.3.4 has the client refresh the stored entry's headers from
    // it. Leaving the assets binding's `must-revalidate` here would downgrade a cached immutable
    // asset on its first revalidation, so the immutable directive has to cover 304 as well as 200.
    headers.set('Cache-Control', immutableCacheControl)
  } else if (headers.has('Cache-Control')) {
    return response
  } else if (response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
    headers.set('Cache-Control', 'no-store')
  } else {
    // No directive and not HTML: leave it to the platform's default (or lack of one)
    // rather than inventing a policy at the boundary.
    return response
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

const immutableCacheControl = 'public, max-age=31536000, immutable'

// Only the build's content-hashed filenames are immutable. A bare `/static/` prefix would also
// match an unhashed file dropped there later, and the extension fallback would match any
// extension path — neither is covered by a hash. Vite appends an eight-character content hash
// (`client-v68nPwkR.js`, `style-D6bcQK7w.css`); a name like `hand-written-page.html` must not
// be mistaken for one, so the hash is matched exactly rather than by a length floor.
function isImmutableHashedAsset(url: string) {
  const { pathname } = new URL(url)
  return pathname.startsWith('/static/') && /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/i.test(pathname)
}
