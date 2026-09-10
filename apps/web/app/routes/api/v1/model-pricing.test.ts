import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getModelPricing } from '../../../features/model-pricing/service'
import { ModelPricingQueryError } from '../../../features/model-pricing/validation'
import { GET } from './model-pricing'

vi.mock('../../../features/model-pricing/service', () => ({
  getModelPricing: vi.fn(),
  maxModelPricingPageSize: 10_000
}))

const mockedGetModelPricing = vi.mocked(getModelPricing)

describe('model pricing route', () => {
  beforeEach(() => {
    mockedGetModelPricing.mockReset()
  })

  test('returns current prices without stale cache reuse', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const context = createContext(
      'https://tokenboard.example/api/v1/model-pricing?provider=openai&limit=25&cursor=opaque'
    )

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=300')
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/)
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: context.env.DB,
      provider: 'openai',
      includeInactive: false,
      limit: 25,
      cursor: 'opaque'
    })
  })

  test('rejects includeInactive=true instead of silently changing scope', async () => {
    const context = createContext('https://tokenboard.example/api/v1/model-pricing?includeInactive=true')

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(400)
    expect(mockedGetModelPricing).not.toHaveBeenCalled()
  })

  test('rejects limit=0', async () => {
    const context = createContext('https://tokenboard.example/api/v1/model-pricing?limit=0')

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(400)
    expect(mockedGetModelPricing).not.toHaveBeenCalled()
  })

  test('accepts includeInactive=0 as the default active-only scope', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const context = createContext('https://tokenboard.example/api/v1/model-pricing?includeInactive=0')

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

  test('maps an expired cursor to a client error instead of 500', async () => {
    mockedGetModelPricing.mockRejectedValueOnce(
      new ModelPricingQueryError('Model pricing cursor has expired; restart pagination')
    )
    const context = createContext('https://tokenboard.example/api/v1/model-pricing?cursor=expired')

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Model pricing cursor has expired; restart pagination'
      }
    })
  })
})

function createContext(url: string) {
  const request = new Request(url)
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
