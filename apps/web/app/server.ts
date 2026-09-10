import { showRoutes } from 'hono/dev'
import { createApp } from 'honox/server'
import { backfillUsageSummaryCache, usageSummaryBackfillLimit } from './features/ingest/repository'
import { runDueWebhookNotifications } from './features/notifications/service'
import { modelPricingSyncEnabled, runModelPricingSync } from './features/model-pricing/service'
import { createModelPricingResponse } from './features/model-pricing/http'
import {
  createPublicUsageResponse,
  parsePublicUsagePath,
  publicApiErrorResponse,
  PUBLIC_API_CLIENT_CACHE_CONTROL,
  PUBLIC_API_WORKER_CACHE_CONTROL
} from './features/public-card/http'
import { assertPublicUsageVisible, publicUsageSlugExists } from './features/public-card/service'
import { usageSummaryStrictMode } from './features/usage/deduped-daily-usage'
import type { Bindings } from './lib/db'
import { pruneExpiredRateLimits } from './lib/rate-limit'

const app = createApp()

showRoutes(app)

export default {
  async fetch(request, env, ctx) {
    const publicResponse = await handlePublicApiRequest(request, env, ctx)
    if (publicResponse) return publicResponse

    const response = await app.fetch(request, env, ctx)
    if (response.status === 404 && shouldFetchStaticAsset(request)) {
      return env.ASSETS?.fetch(request) ?? response
    }
    return response
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
    if (url.pathname === '/api/public/model-pricing' && !(await publicUsageSlugExists(env.DB, 'model-pricing'))) {
      return createModelPricingResponse({
        db: env.DB,
        searchParams: url.searchParams,
        requestHeaders: request.headers
      })
    }
    const route = parsePublicUsagePath(url.pathname)
    if (!route) return null

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

async function runScheduledTasks(env: Bindings, now: Date) {
  const results = await Promise.allSettled([
    runUsageSummaryBackfill(env),
    runScheduledNotifications(env, now),
    runRateLimitPrune(env, now),
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

async function runScheduledModelPricing(env: Bindings) {
  try {
    if (!modelPricingSyncEnabled(env)) return
    await runModelPricingSync({ env, now: new Date() })
  } catch (error) {
    console.error(`TokenBoard model pricing sync failed: ${errorMessage(error)}`)
    throw error
  }
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

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}
