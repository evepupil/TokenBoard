import { afterEach, describe, expect, test, vi } from 'vitest'
import { getModelPricing, runModelPricingSync } from './features/model-pricing/service'
import worker from './server'

vi.mock('./features/model-pricing/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./features/model-pricing/service')>()
  return {
    ...actual,
    getModelPricing: vi.fn(),
    runModelPricingSync: vi.fn(actual.runModelPricingSync)
  }
})

const mockedGetModelPricing = vi.mocked(getModelPricing)
const mockedRunModelPricingSync = vi.mocked(runModelPricingSync)

const originalCaches = globalThis.caches

afterEach(() => {
  globalThis.caches = originalCaches
})

describe('worker server', () => {
  afterEach(() => {
    mockedGetModelPricing.mockReset()
    mockedRunModelPricingSync.mockClear()
  })

  test('serves public model pricing before dynamic public slug handling', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const env = createEnv()

    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/model-pricing?limit=2'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ models: [], nextCursor: null })
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: env.DB,
      provider: undefined,
      includeInactive: false,
      limit: 2,
      cursor: undefined
    })
  })

  test('caches public model pricing and serves a conditional hit without rereading the catalogue', async () => {
    const cache = createCache()
    globalThis.caches = { default: cache } as unknown as CacheStorage
    mockedGetModelPricing.mockResolvedValue({
      state: { activeGeneration: 'generation-one' },
      models: [],
      nextCursor: null
    } as never)
    const env = createEnv()
    const firstContext = createExecutionContext()
    const url = 'https://tokenboard.example/api/public/model-pricing?limit=2'

    const firstResponse = await worker.fetch(workerRequest(url), env, firstContext)
    await Promise.all(firstContext.waitUntilPromises)
    const etag = firstResponse.headers.get('etag')
    const secondResponse = await worker.fetch(
      workerRequest(url, { headers: { 'if-none-match': etag ?? '' } }),
      env,
      createExecutionContext()
    )

    expect(firstResponse.status).toBe(200)
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)
    expect(secondResponse.status).toBe(304)
    expect(secondResponse.headers.get('etag')).toBe(etag)
    expect(secondResponse.headers.get('x-cache-test')).toBe('hit')
    expect(mockedGetModelPricing).toHaveBeenCalledOnce()
    expect(cache.match).toHaveBeenCalledTimes(2)
    expect(cache.put).toHaveBeenCalledOnce()
  })

  test('serves public model pricing even when a legacy slug is occupied', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const env = createEnv({ publicProfile: true, profileSlug: 'model-pricing' })

    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/model-pricing'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ models: [], nextCursor: null })
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: env.DB,
      provider: undefined,
      includeInactive: false,
      limit: undefined,
      cursor: undefined
    })
  })

  test('serves the versioned model-pricing alias when the legacy slug is occupied', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const env = createEnv({ publicProfile: true, profileSlug: 'model-pricing' })

    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/v1/model-pricing?limit=2'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ models: [], nextCursor: null })
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: env.DB,
      provider: undefined,
      includeInactive: false,
      limit: 2,
      cursor: undefined
    })
  })

  test('serves public model pricing when an existing legacy profile is private', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const env = createEnv({ profileSlug: 'model-pricing', profileExists: true })

    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/model-pricing'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ models: [], nextCursor: null })
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: env.DB,
      provider: undefined,
      includeInactive: false,
      limit: undefined,
      cursor: undefined
    })
  })

  test.each(['/api/public/model-pricing.json', '/api/public/model-pricing.svg', '/api/public/%6dodel-pricing'])(
    'does not route reserved pricing slug variant %s through public profiles',
    async (pathname) => {
      const env = createEnv({ publicProfile: true, profileSlug: 'model-pricing' })

      const response = await worker.fetch(
        workerRequest(`https://tokenboard.example${pathname}`),
        env,
        createExecutionContext()
      )

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Public route not found'
        }
      })
      expect(mockedGetModelPricing).not.toHaveBeenCalled()
    }
  )

  test('serves public SVG cards through the worker entrypoint', async () => {
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      createEnv({ publicProfile: true }),
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(await response.text()).toContain('<svg')
  })

  test('serves percent-encoded public SVG extensions through the worker entrypoint', async () => {
    const env = createEnv({ publicProfile: true })
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve%2Esvg'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(await response.text()).toContain('<svg')
    expect(env.boundValues[0]).toEqual(['eve'])
  })

  test('serves percent-encoded public JSON extensions through the worker entrypoint', async () => {
    const env = createEnv({ publicProfile: true })
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve%2Ejson'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toMatchObject({
      slug: 'eve',
      displayName: 'Eve'
    })
    expect(env.boundValues[0]).toEqual(['eve'])
  })

  test('serves cached public responses after rechecking visibility', async () => {
    const cache = createCache()
    globalThis.caches = { default: cache } as unknown as CacheStorage
    const env = createEnv({ publicProfile: true })
    const ctx = createExecutionContext()
    const request = workerRequest('https://tokenboard.example/api/public/eve.svg')

    const firstResponse = await worker.fetch(request, env, ctx)
    await Promise.all(ctx.waitUntilPromises)
    const secondResponse = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      env,
      createExecutionContext()
    )

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.headers.get('x-cache-test')).toBe('hit')
    expect(secondResponse.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(await secondResponse.text()).toContain('<svg')
    expect(env.DB.prepare).toHaveBeenCalledTimes(4)
    expect(cache.match).toHaveBeenCalledTimes(2)
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  test('serves cached public responses with immutable response headers', async () => {
    const cache = createImmutableMatchCache()
    globalThis.caches = { default: cache } as unknown as CacheStorage
    const env = createEnv({ publicProfile: true })
    const ctx = createExecutionContext()
    const request = workerRequest('https://tokenboard.example/api/public/eve.svg')

    const firstResponse = await worker.fetch(request, env, ctx)
    await Promise.all(ctx.waitUntilPromises)
    const secondResponse = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      env,
      createExecutionContext()
    )

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(secondResponse.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(secondResponse.headers.get('content-type')).toContain('image/svg+xml')
    expect(await secondResponse.text()).toContain('<svg')
    expect(cache.match).toHaveBeenCalledTimes(2)
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  test('uses canonical public cache keys without caller query parameters', async () => {
    const cache = createCache()
    globalThis.caches = { default: cache } as unknown as CacheStorage
    const env = createEnv({ publicProfile: true })
    const ctx = createExecutionContext()

    const firstResponse = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg?utm=one'),
      env,
      ctx
    )
    await Promise.all(ctx.waitUntilPromises)
    const secondResponse = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg?utm=two'),
      env,
      createExecutionContext()
    )
    const cachePutRequest = cache.put.mock.calls
      .map((call) => call[0] as Request)
      .find((request) => request.url.includes('__tokenboard_public_subject='))

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.headers.get('x-cache-test')).toBe('hit')
    expect(cachePutRequest?.url).toMatch(
      /^https:\/\/tokenboard\.example\/api\/public\/eve\.svg\?__tokenboard_public_subject=/
    )
    expect(cachePutRequest?.url).not.toContain('utm=')
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  test('does not reuse cached public responses after slug ownership changes', async () => {
    const clock = { now: 0 }
    const cache = createCache(clock)
    globalThis.caches = { default: cache } as unknown as CacheStorage
    const env = createEnv({ publicProfile: true, profileUserId: 'user_1' })
    const ctx = createExecutionContext()
    const request = workerRequest('https://tokenboard.example/api/public/eve.svg')

    const firstResponse = await worker.fetch(request, env, ctx)
    await Promise.all(ctx.waitUntilPromises)
    env.profileUserId = 'user_2'
    const secondResponse = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      env,
      createExecutionContext()
    )

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(secondResponse.headers.get('x-cache-test')).toBeNull()
    expect(await secondResponse.text()).toContain('<svg')
    expect(env.DB.prepare).toHaveBeenCalledTimes(6)
    expect(cache.put).toHaveBeenCalledTimes(2)
  })

  test('does not reuse cached public responses after the same profile changes', async () => {
    const clock = { now: 0 }
    const cache = createCache(clock)
    globalThis.caches = { default: cache } as unknown as CacheStorage
    const env = createEnv({ publicProfile: true, profileUpdatedAt: '2026-04-29T01:00:00.000Z' })
    const ctx = createExecutionContext()
    const request = workerRequest('https://tokenboard.example/api/public/eve.svg')

    const firstResponse = await worker.fetch(request, env, ctx)
    await Promise.all(ctx.waitUntilPromises)
    env.profileUpdatedAt = '2026-04-29T02:00:00.000Z'
    const secondResponse = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      env,
      createExecutionContext()
    )

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(secondResponse.headers.get('x-cache-test')).toBeNull()
    expect(await secondResponse.text()).toContain('<svg')
    expect(cache.put).toHaveBeenCalledTimes(2)
  })

  test('does not reuse cached public responses after usage totals change', async () => {
    const clock = { now: 0 }
    const cache = createCache(clock)
    globalThis.caches = { default: cache } as unknown as CacheStorage
    const env = createEnv({ publicProfile: true, usageUpdatedAt: '2026-04-29T01:00:00.000Z' })
    const ctx = createExecutionContext()

    const firstResponse = await worker.fetch(workerRequest('https://tokenboard.example/api/public/eve.svg'), env, ctx)
    await Promise.all(ctx.waitUntilPromises)
    env.usageUpdatedAt = '2026-04-29T01:05:00.000Z'
    const secondResponse = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      env,
      createExecutionContext()
    )

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(secondResponse.headers.get('x-cache-test')).toBeNull()
    expect(await secondResponse.text()).toContain('<svg')
    expect(cache.put).toHaveBeenCalledTimes(2)
  })

  test('does not reuse cached public responses after summary-only usage changes', async () => {
    const clock = { now: 0 }
    const cache = createCache(clock)
    globalThis.caches = { default: cache } as unknown as CacheStorage
    const env = createEnv({
      publicProfile: true,
      usageUpdatedAt: '2026-04-29T01:00:00.000Z',
      summaryUpdatedAt: '2026-04-29T01:00:00.000Z'
    })
    const ctx = createExecutionContext()

    const firstResponse = await worker.fetch(workerRequest('https://tokenboard.example/api/public/eve.svg'), env, ctx)
    await Promise.all(ctx.waitUntilPromises)
    env.summaryUpdatedAt = '2026-04-29T01:05:00.000Z'
    const secondResponse = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      env,
      createExecutionContext()
    )

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(secondResponse.headers.get('x-cache-test')).toBeNull()
    expect(await secondResponse.text()).toContain('<svg')
    expect(cache.put).toHaveBeenCalledTimes(2)
  })

  test('does not reuse cached public responses after summary strict mode changes', async () => {
    const cache = createCache()
    globalThis.caches = { default: cache } as unknown as CacheStorage
    const env = createEnv({ publicProfile: true })
    const ctx = createExecutionContext()
    const request = workerRequest('https://tokenboard.example/api/public/eve.svg')

    const firstResponse = await worker.fetch(request, env, ctx)
    await Promise.all(ctx.waitUntilPromises)
    env.TOKENBOARD_USAGE_SUMMARY_STRICT = 'true'
    const secondResponse = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      env,
      createExecutionContext()
    )

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(secondResponse.headers.get('x-cache-test')).toBeNull()
    expect(await secondResponse.text()).toContain('<svg')
    expect(cache.put).toHaveBeenCalledTimes(2)
  })

  test('rechecks public sharing before serving cached public responses', async () => {
    const cache = createCache()
    globalThis.caches = { default: cache } as unknown as CacheStorage
    const env = createEnv({ publicProfile: true })
    const ctx = createExecutionContext()
    const request = workerRequest('https://tokenboard.example/api/public/eve.svg')

    const firstResponse = await worker.fetch(request, env, ctx)
    await Promise.all(ctx.waitUntilPromises)
    env.publicProfile = false
    const secondResponse = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      env,
      createExecutionContext()
    )

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(404)
    expect(secondResponse.headers.get('x-cache-test')).toBeNull()
    await expect(secondResponse.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Public profile not found'
      }
    })
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  test('does not serve public content for unsupported public API methods', async () => {
    const env = createEnv({ publicProfile: true })
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.json', { method: 'POST' }),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found'
      }
    })
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })

  test('returns JSON 404 for missing public profiles', async () => {
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/missing-user.json'),
      createEnv(),
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Public profile not found'
      }
    })
  })

  test('rejects unsupported public API extensions with JSON', async () => {
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/missing-user.txt'),
      createEnv(),
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Public route not found'
      }
    })
  })

  test('rejects malformed public API path encoding with JSON', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/%E0%A4%A.json'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Public route not found'
      }
    })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  test('falls back to the assets binding for static 404 responses', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/static/style.css'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('asset response')
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce()
  })

  test('falls back to assets for extension static files outside static directory', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/manifest.json'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('asset response')
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce()
  })

  // The fallback serves a missing static file with the assets binding's default revalidate
  // directive (and the zone's cache-by-extension list covers `.js`-style paths), so the edge
  // could cache the 404 and keep serving it after the file is deployed. The honox `_404`
  // handler sets `no-store`; this branch bypasses it, so the boundary forces it over whatever
  // directive arrived.
  test('marks a static asset fallback 404 as no-store', async () => {
    const env = createEnv()
    env.ASSETS.fetch.mockResolvedValueOnce(
      new Response('not found', {
        status: 404,
        headers: { 'cache-control': 'public, max-age=0, must-revalidate' }
      })
    )
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/static/definitely-missing.js'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  // The assets binding answers a missing file with an empty 404 (no body, no content-type), and
  // that answer used to replace the app's own 404 for every extension path — so `/robots.txt`
  // lost the stable error shape `_404` gives a plain path. A missing asset must fall back to the
  // app's 404; only a real asset is served.
  test('falls back to the app 404 when the assets binding has no such file', async () => {
    const env = createEnv()
    env.ASSETS.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/robots.txt'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    // The app's 404 carries a body and a type; the empty asset 404 carries neither.
    expect(await response.text()).not.toBe('')
    expect(response.headers.get('content-type')).not.toBeNull()
  })

  // The build emits content-hashed filenames under `/static/` (`client-<hash>.js`), so a
  // given URL's bytes cannot change: those may be cached immutably instead of the assets
  // binding's `public, max-age=0, must-revalidate`, which costs a revalidation per load.
  // The mock carries the binding's real default header — a header-less mock let this test
  // pass while production kept the revalidation directive, because the platform default is
  // attached upstream of the Worker's own `withResponsePolicies` boundary.
  test.each([
    ['https://tokenboard.example/static/client-v68nPwkR.js', 'public, max-age=31536000, immutable'],
    ['https://tokenboard.example/static/runtime-CTavEsGH.js', 'public, max-age=31536000, immutable'],
    ['https://tokenboard.example/static/style-D6bcQK7w.css', 'public, max-age=31536000, immutable']
  ])('caches the hashed asset %s as immutable', async (url, cacheControl) => {
    const env = createEnv()
    env.ASSETS.fetch.mockResolvedValue(
      new Response('asset response', {
        status: 200,
        headers: { 'cache-control': 'public, max-age=0, must-revalidate' }
      })
    )
    const response = await worker.fetch(workerRequest(url), env, createExecutionContext())

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(cacheControl)
  })

  // A conditional request for a hashed asset answers 304 with no body. RFC 9111 §4.3.4 has the
  // client refresh the stored entry from that response's headers, so a `must-revalidate` here
  // would downgrade the cached immutable asset and cost a revalidation per navigation after a
  // hard refresh. The immutable directive has to cover 304 as well as 200.
  test('keeps the hashed asset immutable on a 304 revalidation', async () => {
    const env = createEnv()
    env.ASSETS.fetch.mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: { 'cache-control': 'public, max-age=0, must-revalidate', etag: '"abc123"' }
      })
    )
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/static/client-v68nPwkR.js', {
        headers: { 'if-none-match': '"abc123"' }
      }),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(304)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  // A `/static/` prefix or an extension alone is not a content hash — a file dropped there
  // without one can change under its own URL, so it must not be cached immutably. The
  // assets binding's own revalidation directive passes through untouched.
  test.each([
    'https://tokenboard.example/static/unhashed.js',
    'https://tokenboard.example/static/style.css',
    'https://tokenboard.example/manifest.json',
    'https://tokenboard.example/logo.svg'
  ])('does not mark the unhashed asset %s immutable', async (url) => {
    const env = createEnv()
    env.ASSETS.fetch.mockResolvedValue(
      new Response('asset response', {
        status: 200,
        headers: { 'cache-control': 'public, max-age=0, must-revalidate' }
      })
    )
    const response = await worker.fetch(workerRequest(url), env, createExecutionContext())

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  // A route's own directive must survive the boundary: the public card revalidates on the
  // caller's side, and the caching public API path decides its own window.
  test('keeps a route Cache-Control header over the boundary default', async () => {
    const env = createEnv({ publicProfile: true })
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  // No page route leaves HTML without a directive today (the auth boundary and each page set
  // `no-store`), but the boundary is what keeps that true: the `_error` 500 page renders HTML
  // with no directive of its own, and a page that forgets one must not become browser-cacheable.
  test('marks HTML with no explicit directive as no-store', async () => {
    const env = createEnv()
    env.ASSETS.fetch.mockResolvedValueOnce(
      new Response('<!doctype html><title>page</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' }
      })
    )
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/static/landing-page.html'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  // The Worker is reachable over plaintext HTTP, and a zone without Always Use HTTPS answers
  // it directly — cookies and the ingest bearer token would travel in the clear. A Worker-level
  // redirect closes that without depending on the zone setting. The scheme comes from the
  // `cf-visitor` header, which Cloudflare sets to the client-facing scheme: `request.url` is
  // already rewritten to the zone's configured scheme, so it cannot be used here.
  test('redirects a plaintext HTTP request to HTTPS', async () => {
    const env = createEnv()
    for (const url of [
      'https://tokenboard.example/dashboard?tab=month',
      'http://tokenboard.example/dashboard?tab=month'
    ]) {
      const response = await worker.fetch(
        workerRequest(url, { headers: { 'cf-visitor': '{"scheme":"http"}' } }),
        env,
        createExecutionContext()
      )

      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://tokenboard.example/dashboard?tab=month')
      expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    }
  })

  // 308 keeps the method and body, which matters for the ingest POST: a 301 would let clients
  // downgrade it to a GET and silently drop the snapshot.
  test('keeps the method on the HTTPS redirect', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      workerRequest('http://tokenboard.example/api/v1/ingest', {
        method: 'POST',
        headers: { 'cf-visitor': '{"scheme":"http"}' }
      }),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('https://tokenboard.example/api/v1/ingest')
  })

  // Requests without the header come from local `wrangler dev` (plain HTTP by design) or a
  // non-Cloudflare runtime; the redirect must not fire there. A malformed header is treated
  // the same way rather than guessing a scheme.
  test('serves HTTPS, missing and malformed cf-visitor requests normally', async () => {
    const env = createEnv()
    for (const headers of [{ 'cf-visitor': '{"scheme":"https"}' }, { 'cf-visitor': 'not json' }, undefined]) {
      const response = await worker.fetch(
        workerRequest('http://localhost:8787/static/app.js', headers ? { headers } : undefined),
        env,
        createExecutionContext()
      )

      expect(response.status).toBe(200)
    }
  })

  test('does not use assets fallback for API 404 responses', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/v1/missing.json'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found'
      }
    })
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })

  test('scheduled handler runs usage summary backfill alongside webhook delivery', async () => {
    const env = createEnv({ dueSubscription: false, usageSummaryBackfillLimit: '75' })
    const ctx = createExecutionContext()

    worker.scheduled?.(
      {
        scheduledTime: Date.parse('2026-04-29T10:00:00.000Z'),
        cron: '*/15 * * * *',
        noRetry() {}
      },
      env,
      ctx
    )
    expect(ctx.waitUntilPromises).toHaveLength(1)
    await Promise.all(ctx.waitUntilPromises)

    const statements = env.sqlStatements.join('\n')
    expect(statements).toContain('FROM usage_summary_backfill_state')
    expect(statements).toContain('GROUP BY user_id, usage_date, source, model')
    expect(statements).toContain('INSERT INTO daily_usage_summary')
    expect(statements).toContain('FROM webhook_subscriptions')
    // The 10:00 run is outside the daily maintenance window, so the retention prunes and the
    // rate-limit cleanup stay idle: they only run once per UTC day.
    expect(statements).not.toContain('DELETE FROM api_rate_limits')
    expect(statements).not.toContain('DELETE FROM pairing_codes')
    expect(statements).not.toContain('DELETE FROM audit_logs')
    expect(statements).not.toContain('aggregate_usage AS')
    expect(env.boundValues.some((values) => values.includes('2026-04-29T10:00:00.000Z'))).toBe(true)
    expect(env.boundValues.some((values) => values.at(-1) === 76)).toBe(true)
    // One batch from the summary backfill; rate-limit cleanup, device retention and the empty
    // webhook queue do not call D1 batch outside the daily window.
    expect(env.DB.batch).toHaveBeenCalledTimes(1)
  })

  test('scheduled handler runs the daily prunes in the first maintenance window of the UTC day', async () => {
    const env = createEnv({ dueSubscription: false })
    const ctx = createExecutionContext()

    worker.scheduled?.(
      {
        scheduledTime: Date.parse('2026-04-29T00:00:00.000Z'),
        cron: '*/15 * * * *',
        noRetry() {}
      },
      env,
      ctx
    )
    expect(ctx.waitUntilPromises).toHaveLength(1)
    await Promise.all(ctx.waitUntilPromises)

    const statements = env.sqlStatements.join('\n')
    expect(statements).toContain('DELETE FROM api_rate_limits')
    expect(statements).toContain('DELETE FROM pairing_codes')
    expect(statements).toContain('DELETE FROM audit_logs')
  })

  test('the daily maintenance window is skipped on later ticks of the same hour', async () => {
    const env = createEnv({ dueSubscription: false })
    const ctx = createExecutionContext()

    worker.scheduled?.(
      {
        scheduledTime: Date.parse('2026-04-29T00:30:00.000Z'),
        cron: '*/15 * * * *',
        noRetry() {}
      },
      env,
      ctx
    )
    await Promise.all(ctx.waitUntilPromises)

    const statements = env.sqlStatements.join('\n')
    expect(statements).not.toContain('DELETE FROM api_rate_limits')
    expect(statements).not.toContain('DELETE FROM pairing_codes')
  })

  test('scheduled handler refreshes the model pricing catalogue when enabled', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(modelPricingFixture()), { status: 200 }))
    try {
      const env = createEnv({ modelPricingSyncEnabled: 'true' })
      const ctx = createExecutionContext()

      worker.scheduled?.(
        {
          scheduledTime: Date.parse('2026-04-29T10:00:00.000Z'),
          cron: '*/15 * * * *',
          noRetry() {}
        },
        env,
        ctx
      )
      await Promise.all(ctx.waitUntilPromises)

      expect(globalThis.fetch).toHaveBeenCalledOnce()
      expect(env.sqlStatements.join('\n')).toContain('model_pricing_sync_state')
      // 10:00 is outside the daily maintenance window, so the retention prunes stay idle.
      expect(env.sqlStatements.join('\n')).not.toContain('DELETE FROM pairing_codes')
      // Publish batch + the separate post-publish staging cleanup batch.
      expect(env.DB.batch).toHaveBeenCalledTimes(4)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('scheduled model pricing sync uses execution time for a delayed cron event', async () => {
    const executionTime = new Date('2026-04-29T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(executionTime)
    mockedRunModelPricingSync.mockImplementationOnce(async () => ({
      status: 'success',
      modelCount: 1,
      sourceUpdatedAt: null,
      completedAt: executionTime.toISOString(),
      zeroFlips: []
    }))

    try {
      const env = createEnv({ modelPricingSyncEnabled: 'true' })
      const ctx = createExecutionContext()

      worker.scheduled?.(
        {
          scheduledTime: Date.parse('2026-04-29T10:00:00.000Z'),
          cron: '*/15 * * * *',
          noRetry() {}
        },
        env,
        ctx
      )
      await Promise.all(ctx.waitUntilPromises)

      expect(mockedRunModelPricingSync).toHaveBeenCalledWith({
        env,
        now: executionTime
      })
    } finally {
      vi.useRealTimers()
    }
  })

  test('scheduled model pricing sync reports a catalogue collapse', async () => {
    const logged: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line))
    })
    mockedRunModelPricingSync.mockImplementationOnce(async () => ({
      status: 'success',
      modelCount: 40,
      sourceUpdatedAt: null,
      completedAt: new Date('2026-04-29T10:00:00.000Z').toISOString(),
      zeroFlips: [],
      removalCount: 8_260,
      storedModelCount: 8_300
    }))

    try {
      const env = createEnv({ modelPricingSyncEnabled: 'true' })
      const ctx = createExecutionContext()

      worker.scheduled?.(
        {
          scheduledTime: Date.parse('2026-04-29T10:00:00.000Z'),
          cron: '*/15 * * * *',
          noRetry() {}
        },
        env,
        ctx
      )
      await Promise.all(ctx.waitUntilPromises)

      expect(logged.some((line) => line.includes('8260 of 8300'))).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('scheduled model pricing sync stays quiet for routine removals', async () => {
    const logged: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line))
    })
    mockedRunModelPricingSync.mockImplementationOnce(async () => ({
      status: 'success',
      modelCount: 8_297,
      sourceUpdatedAt: null,
      completedAt: new Date('2026-04-29T10:00:00.000Z').toISOString(),
      zeroFlips: [],
      removalCount: 3,
      storedModelCount: 8_300
    }))

    try {
      const env = createEnv({ modelPricingSyncEnabled: 'true' })
      const ctx = createExecutionContext()

      worker.scheduled?.(
        {
          scheduledTime: Date.parse('2026-04-29T10:00:00.000Z'),
          cron: '*/15 * * * *',
          noRetry() {}
        },
        env,
        ctx
      )
      await Promise.all(ctx.waitUntilPromises)

      expect(logged.some((line) => line.includes('deactivated'))).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('scheduled usage summary backfill exposes invalid limit configuration', async () => {
    const originalFetch = globalThis.fetch
    let pricingCompleted = false
    globalThis.fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      pricingCompleted = true
      return new Response(JSON.stringify(modelPricingFixture()), { status: 200 })
    })
    const env = createEnv({
      dueSubscription: false,
      usageSummaryBackfillLimit: '0',
      modelPricingSyncEnabled: 'true'
    })
    const ctx = createExecutionContext()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      worker.scheduled?.(
        {
          scheduledTime: Date.parse('2026-04-29T10:00:00.000Z'),
          cron: '*/15 * * * *',
          noRetry() {}
        },
        env,
        ctx
      )

      await expect(Promise.all(ctx.waitUntilPromises)).rejects.toThrow(
        'TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to 500'
      )
      expect(consoleError).toHaveBeenCalledWith(
        'TokenBoard usage summary backfill failed: TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to 500'
      )
      expect(globalThis.fetch).toHaveBeenCalledOnce()
      expect(pricingCompleted).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      consoleError.mockRestore()
    }
  })

  test('propagates all scheduled task failures after every task settles', async () => {
    const env = createEnv({
      usageSummaryBackfillLimit: '0',
      modelPricingSyncEnabled: 'true',
      modelPricingSyncIntervalHours: '0'
    })
    const ctx = createExecutionContext()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      worker.scheduled?.(
        {
          scheduledTime: Date.parse('2026-04-29T10:00:00.000Z'),
          cron: '*/15 * * * *',
          noRetry() {}
        },
        env,
        ctx
      )

      await expect(Promise.all(ctx.waitUntilPromises)).rejects.toMatchObject({
        errors: expect.arrayContaining([
          expect.objectContaining({
            message: 'TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to 500'
          }),
          expect.objectContaining({
            message: 'TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS must be an integer from 1 to 168'
          })
        ])
      })
      expect(consoleError).toHaveBeenCalledWith(
        'TokenBoard usage summary backfill failed: TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to 500'
      )
      expect(consoleError).toHaveBeenCalledWith(
        'TokenBoard model pricing sync failed: TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS must be an integer from 1 to 168'
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})

function createEnv(
  options: {
    publicProfile?: boolean
    profileExists?: boolean
    profileSlug?: string
    dueSubscription?: boolean
    profileUserId?: string
    profileUpdatedAt?: string
    usageUpdatedAt?: string
    summaryUpdatedAt?: string
    usageSummaryBackfillLimit?: string
    usageSummaryStrict?: string
    modelPricingSyncEnabled?: string
    modelPricingSyncIntervalHours?: string
  } = {}
) {
  const boundValues: unknown[][] = []
  const sqlStatements: string[] = []
  const env = {
    ASSETS: {
      fetch: vi.fn(async () => new Response('asset response', { status: 200 }))
    },
    BETTER_AUTH_URL: 'https://tokenboard.example',
    boundValues,
    sqlStatements,
    publicProfile: Boolean(options.publicProfile),
    profileExists: options.profileExists ?? Boolean(options.publicProfile),
    profileSlug: options.profileSlug ?? 'eve',
    profileUserId: options.profileUserId ?? 'user_1',
    profileUpdatedAt: options.profileUpdatedAt ?? '2026-04-29T00:00:00.000Z',
    usageUpdatedAt: options.usageUpdatedAt ?? '2026-04-29T00:00:00.000Z',
    summaryUpdatedAt: options.summaryUpdatedAt ?? '2026-04-29T00:00:00.000Z',
    TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT: options.usageSummaryBackfillLimit,
    TOKENBOARD_USAGE_SUMMARY_STRICT: options.usageSummaryStrict,
    TOKENBOARD_MODEL_PRICING_SYNC_ENABLED: options.modelPricingSyncEnabled,
    TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: options.modelPricingSyncIntervalHours ?? '24',
    TOKENBOARD_MODEL_PRICING_SOURCE_URL: 'https://models.dev/api.json',
    dueSubscription: options.dueSubscription
  }
  return Object.assign(env, {
    DB: createDb(env, boundValues, sqlStatements)
  })
}

function createDb(
  options: {
    publicProfile?: boolean
    profileExists?: boolean
    profileSlug?: string
    dueSubscription?: boolean
    profileUserId?: string
    profileUpdatedAt?: string
    usageUpdatedAt?: string
    summaryUpdatedAt?: string
  } = {},
  boundValues: unknown[][] = [],
  sqlStatements: string[] = []
) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...values: unknown[]) => {
        sqlStatements.push(sql)
        boundValues.push(values)
        return {
          first: vi.fn(async () => {
            // The read-side rate limit reads and increments a counter row on every request.
            // Without an answer here the increment falls back to "over the ceiling" and every
            // request 429s, so this stub reports a fresh, far-from-limit counter.
            if (sql.includes('api_rate_limits')) {
              return { count: 1, resetAt: '2099-01-01T00:00:00.000Z' }
            }
            if (sql.includes('FROM profiles')) {
              if (!(options.profileExists ?? options.publicProfile)) return null
              return {
                userId: options.profileUserId ?? 'user_1',
                slug: options.profileSlug ?? 'eve',
                displayName: 'Eve',
                timezone: 'UTC',
                publicCardConfig: null,
                isPublic: options.publicProfile ? 1 : 0,
                updatedAt: options.profileUpdatedAt ?? '2026-04-29T00:00:00.000Z',
                usageUpdatedAt: options.usageUpdatedAt ?? '2026-04-29T00:00:00.000Z',
                summaryUpdatedAt: options.summaryUpdatedAt ?? '2026-04-29T00:00:00.000Z'
              }
            }

            return {
              totalTokens: 1200,
              totalTokensWithoutCacheRead: 900,
              totalCostUsd: 3.75,
              todayTokens: 100,
              todayTokensWithoutCacheRead: 70,
              todayCostUsd: 0.2,
              monthTokens: 500,
              monthTokensWithoutCacheRead: 380,
              monthCostUsd: 1.5
            }
          }),
          all: vi.fn(async () => {
            if (sql.includes('FROM daily_usage') && !sql.includes('daily_usage_summary')) {
              return {
                results: [
                  {
                    userId: 'user_1',
                    usageDate: '2026-04-28',
                    source: 'codex',
                    model: 'gpt-5'
                  }
                ]
              }
            }
            return { results: [] }
          }),
          run: vi.fn(async () => ({
            success: true,
            meta: { changes: sql.includes('model_pricing_sync_state') ? 1 : 0 }
          }))
        }
      })
    })),
    batch: vi.fn(async (statements: unknown[]) =>
      statements.map(() => ({
        success: true,
        meta: { changes: 1 }
      }))
    )
  } as unknown as D1Database
}

function modelPricingFixture() {
  return {
    openai: {
      doc: 'https://developers.openai.com/api/docs/pricing',
      models: { 'gpt-5.6-sol': pricedModel('gpt-5.6-sol', 1_050_000, 5, 30) }
    },
    anthropic: {
      doc: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
      models: { 'claude-sonnet-5': pricedModel('claude-sonnet-5', 1_000_000, 2, 10) }
    },
    xai: { doc: 'https://docs.x.ai/docs/models', models: { 'grok-4.5': pricedModel('grok-4.5', 500_000, 2, 6) } }
  }
}

function pricedModel(id: string, context: number, input: number, output: number) {
  return {
    id,
    name: id,
    family: id,
    last_updated: '2026-08-01',
    limit: { context, output: 128_000 },
    cost: { input, output, cache_read: 0.1 }
  }
}

function createExecutionContext() {
  const waitUntilPromises: Promise<unknown>[] = []
  return {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise)
    },
    passThroughOnException() {},
    props: {},
    waitUntilPromises
  } as ExecutionContext & { waitUntilPromises: Promise<unknown>[] }
}

function workerRequest(url: string, init?: RequestInit) {
  return new Request(url, init) as Parameters<typeof worker.fetch>[0]
}

function createCache(clock: { now: number } = { now: Date.now() }) {
  const values = new Map<string, { response: Response; expiresAt: number | null }>()
  return {
    match: vi.fn(async (request: Request) => {
      const cached = values.get(request.url)
      if (!cached) return undefined
      if (cached.expiresAt !== null && cached.expiresAt <= clock.now) {
        values.delete(request.url)
        return undefined
      }
      return cached.response.clone()
    }),
    put: vi.fn(async (request: Request, response: Response) => {
      const cached = response.clone()
      cached.headers.set('x-cache-test', 'hit')
      values.set(request.url, {
        response: cached,
        expiresAt: cacheExpiresAt(response.headers.get('cache-control'), clock.now)
      })
    })
  }
}

function cacheExpiresAt(cacheControl: string | null, now: number) {
  const maxAge = cacheControl?.match(/(?:^|,\s*)max-age=(\d+)(?:,|$)/)?.[1]
  return maxAge === undefined ? null : now + Number(maxAge) * 1000
}

function createImmutableMatchCache() {
  const values = new Map<string, { body: string; contentType: string }>()
  return {
    match: vi.fn(async (request: Request) => {
      const response = values.get(request.url)
      if (!response) return undefined
      return fetch(`data:${response.contentType},${encodeURIComponent(response.body)}`)
    }),
    put: vi.fn(async (request: Request, response: Response) => {
      values.set(request.url, {
        body: await response.clone().text(),
        contentType: response.headers.get('content-type') ?? 'text/plain;charset=utf-8'
      })
    })
  }
}
