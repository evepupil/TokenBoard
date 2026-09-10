import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../../lib/errors'
import { getModelPricing } from '../../../features/model-pricing/service'
import { GET } from './model-pricing'

vi.mock('../../../features/model-pricing/service', () => ({
  getModelPricing: vi.fn(),
  maxModelPricingPageSize: 10_000
}))

const mockedGetModelPricing = vi.mocked(getModelPricing)

describe('public model pricing route', () => {
  beforeEach(() => {
    mockedGetModelPricing.mockReset()
  })

  test('accepts the public catalogue path and forwards parsed filters', async () => {
    mockedGetModelPricing.mockResolvedValue({
      state: {
        status: 'failed',
        sourceUrl: 'https://models.dev/api.json',
        lastError: 'private failure detail'
      },
      models: [],
      nextCursor: null
    } as never)
    const url =
      'https://tokenboard.example/api/public/model-pricing?provider=%20deepseek%20&includeInactive=1&limit=25&cursor=opaque'
    const request = new Request(url)
    const context = {
      env: { DB: {} },
      req: {
        url,
        raw: request,
        query: (name: string) => new URL(url).searchParams.get(name)
      },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ models: [], nextCursor: null })
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: context.env.DB,
      provider: 'deepseek',
      includeInactive: true,
      limit: 25,
      cursor: 'opaque'
    })
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=300')
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/)
  })

  test('treats whitespace-only optional filters as absent', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const url = 'https://tokenboard.example/api/public/model-pricing?provider=%20%20'
    const request = new Request(url)
    const context = {
      env: { DB: {} },
      req: { url, raw: request, query: (name: string) => new URL(url).searchParams.get(name) },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: context.env.DB,
      provider: undefined,
      includeInactive: false,
      limit: undefined,
      cursor: undefined
    })
  })

  test('accepts explicit includeInactive false', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const url = 'https://tokenboard.example/api/public/model-pricing?includeInactive=0'
    const request = new Request(url)
    const context = createContext(url, request)

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: context.env.DB,
      provider: undefined,
      includeInactive: false,
      limit: undefined,
      cursor: undefined
    })
  })

  test('rejects provider filters outside the source id contract', async () => {
    for (const provider of ['OpenAI', 'provider/with-slash', `x${'a'.repeat(64)}`]) {
      const url = `https://tokenboard.example/api/public/model-pricing?provider=${encodeURIComponent(provider)}`
      const request = new Request(url)
      const context = {
        env: { DB: {} },
        req: { url, raw: request, query: (name: string) => new URL(url).searchParams.get(name) },
        header: vi.fn(),
        json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
      }

      const response = (await GET[0](context as never, async () => undefined)) as Response
      expect(response.status).toBe(400)
    }
    expect(mockedGetModelPricing).not.toHaveBeenCalled()
  })

  test('returns 304 for a matching generation ETag', async () => {
    mockedGetModelPricing.mockResolvedValue({
      state: {
        status: 'success',
        sourceUrl: 'https://models.dev/api.json',
        lastStartedAt: '2026-08-07T00:00:00.000Z',
        lastSuccessAt: '2026-08-07T00:00:00.000Z',
        lastFailureAt: null,
        lastSourceUpdatedAt: '2026-08-07',
        modelCount: 0,
        activeGeneration: 'generation-one',
        lastError: null,
        updatedAt: '2026-08-07T00:00:00.000Z'
      },
      models: [],
      nextCursor: null
    } as never)
    const url = 'https://tokenboard.example/api/public/model-pricing?limit=25'
    const firstRequest = new Request(url)
    const firstContext = createContext(url, firstRequest)
    const firstResponse = (await GET[0](firstContext as never, async () => undefined)) as Response
    const etag = firstResponse.headers.get('etag')
    expect(etag).toBeTruthy()

    const secondRequest = new Request(url, { headers: { 'if-none-match': etag ?? '' } })
    const secondContext = createContext(url, secondRequest)
    const secondResponse = (await GET[0](secondContext as never, async () => undefined)) as Response

    expect(secondResponse.status).toBe(304)
    expect(secondResponse.headers.get('etag')).toBe(etag)

    const weakRequest = new Request(url, { headers: { 'if-none-match': `W/${etag ?? ''}` } })
    const weakContext = createContext(url, weakRequest)
    const weakResponse = (await GET[0](weakContext as never, async () => undefined)) as Response

    expect(weakResponse.status).toBe(304)
    expect(weakResponse.headers.get('etag')).toBe(etag)
  })

  test('keeps the ETag stable when only sync metadata timestamps change', async () => {
    const state = {
      status: 'success' as const,
      sourceUrl: 'https://models.dev/api.json',
      lastStartedAt: '2026-08-07T00:00:00.000Z',
      lastSuccessAt: '2026-08-07T00:00:00.000Z',
      lastFailureAt: null,
      lastSourceUpdatedAt: '2026-08-07',
      modelCount: 0,
      activeGeneration: 'generation-one',
      lastError: null,
      updatedAt: '2026-08-07T00:00:00.000Z'
    }
    mockedGetModelPricing.mockResolvedValueOnce({ state, models: [], nextCursor: null }).mockResolvedValueOnce({
      state: { ...state, updatedAt: '2026-08-07T00:05:00.000Z' },
      models: [],
      nextCursor: null
    })
    const url = 'https://tokenboard.example/api/public/model-pricing?limit=25'
    const first = (await GET[0](createContext(url, new Request(url)) as never, async () => undefined)) as Response
    const etag = first.headers.get('etag')
    const second = (await GET[0](
      createContext(url, new Request(url, { headers: { 'if-none-match': etag ?? '' } })) as never,
      async () => undefined
    )) as Response

    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
  })

  test('returns 503 when a stable catalogue cannot be read', async () => {
    mockedGetModelPricing.mockRejectedValue(
      new ApiError('SERVICE_UNAVAILABLE', 'Model pricing catalogue is temporarily unavailable; retry the request', 503)
    )
    const url = 'https://tokenboard.example/api/public/model-pricing'
    const request = new Request(url)
    const response = (await GET[0](createContext(url, request) as never, async () => undefined)) as Response

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Model pricing catalogue is temporarily unavailable; retry the request'
      }
    })
  })
})

function createContext(url: string, request: Request) {
  return {
    env: { DB: {} },
    req: {
      url,
      raw: request,
      query: (name: string) => new URL(url).searchParams.get(name)
    },
    header: vi.fn(),
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
  }
}
