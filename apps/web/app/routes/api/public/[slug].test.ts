import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../../lib/errors'
import { getPublicUsageCard, getPublicUsageJson } from '../../../features/public-card/service'
import { GET } from './[slug]'

vi.mock('../../../features/public-card/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../features/public-card/service')>()
  return {
    ...actual,
    getPublicUsageCard: vi.fn(),
    getPublicUsageJson: vi.fn()
  }
})

vi.mock('../../../lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/rate-limit')>()),
  clientIpRateLimitSubject: vi.fn(() => ({ kind: 'ip', value: '203.0.113.10' })),
  enforceRateLimit: vi.fn()
}))

const mockedGetPublicUsageCard = vi.mocked(getPublicUsageCard)
const mockedGetPublicUsageJson = vi.mocked(getPublicUsageJson)

describe('public usage route', () => {
  beforeEach(() => {
    mockedGetPublicUsageCard.mockReset()
    mockedGetPublicUsageJson.mockReset()
  })

  test('serves JSON for .json and extensionless public URLs', async () => {
    mockedGetPublicUsageJson.mockResolvedValue({ slug: 'eve-tokenboard' } as never)

    const jsonResponse = (await GET[0](
      contextFor('eve-tokenboard.json', 'https://tokenboard.example/api/public/eve-tokenboard.json') as never,
      async () => undefined
    )) as Response
    const extensionlessResponse = (await GET[0](
      contextFor('eve-tokenboard', 'https://tokenboard.example/api/public/eve-tokenboard') as never,
      async () => undefined
    )) as Response

    expect(jsonResponse.headers.get('content-type')).toContain('application/json')
    expect(extensionlessResponse.headers.get('content-type')).toContain('application/json')
    expect(await jsonResponse.json()).toEqual({ slug: 'eve-tokenboard' })
    expect(await extensionlessResponse.json()).toEqual({ slug: 'eve-tokenboard' })
    expect(mockedGetPublicUsageJson).toHaveBeenNthCalledWith(1, {}, 'eve-tokenboard', expect.any(Date), false)
    expect(mockedGetPublicUsageJson).toHaveBeenNthCalledWith(2, {}, 'eve-tokenboard', expect.any(Date), false)
  })

  test('serves SVG for .svg public URLs', async () => {
    mockedGetPublicUsageCard.mockResolvedValue('<svg />')

    const response = (await GET[0](
      contextFor('eve-tokenboard.svg', 'https://tokenboard.example/api/public/eve-tokenboard.svg') as never,
      async () => undefined
    )) as Response

    expect(response.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(await response.text()).toBe('<svg />')
    expect(mockedGetPublicUsageCard).toHaveBeenCalledWith(
      {},
      'eve-tokenboard',
      expect.any(Date),
      'https://tokenboard.example',
      false
    )
  })

  test('rejects unsupported public URL extensions', async () => {
    const response = (await GET[0](
      contextFor('eve-tokenboard.txt', 'https://tokenboard.example/api/public/eve-tokenboard.txt') as never,
      async () => undefined
    )) as Response

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Public route not found'
      }
    })
    expect(mockedGetPublicUsageJson).not.toHaveBeenCalled()
    expect(mockedGetPublicUsageCard).not.toHaveBeenCalled()
    // Without a directive a browser may cache the 404 heuristically, which would keep
    // serving "not found" for a slug after its owner made the profile public.
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  test.each(['eve-tokenboard.json.svg', 'eve-tokenboard.svg.json'])(
    'rejects double public URL extensions: %s',
    async (slug) => {
      const response = (await GET[0](
        contextFor(slug, `https://tokenboard.example/api/public/${slug}`) as never,
        async () => undefined
      )) as Response

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Public route not found'
        }
      })
      expect(mockedGetPublicUsageJson).not.toHaveBeenCalled()
      expect(mockedGetPublicUsageCard).not.toHaveBeenCalled()
    }
  )

  test('rejects reserved public slugs case-insensitively', async () => {
    const response = (await GET[0](
      contextFor('Model-Pricing.json', 'https://tokenboard.example/api/public/Model-Pricing.json') as never,
      async () => undefined
    )) as Response

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Public route not found'
      }
    })
    expect(mockedGetPublicUsageJson).not.toHaveBeenCalled()
    expect(mockedGetPublicUsageCard).not.toHaveBeenCalled()
  })

  test('preserves API error headers', async () => {
    mockedGetPublicUsageJson.mockRejectedValue(
      new ApiError('RATE_LIMITED', 'Too many requests', 429, { 'Retry-After': '30' })
    )
    const response = (await GET[0](
      contextFor('eve-tokenboard', 'https://tokenboard.example/api/public/eve-tokenboard') as never,
      async () => undefined
    )) as Response

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('30')
  })

  // A cached failure would keep serving after the underlying problem clears, so the error's own
  // `Cache-Control` must not be able to override the no-store the boundary applies.
  test('forces no-store over a Cache-Control carried by the error', async () => {
    mockedGetPublicUsageJson.mockRejectedValue(
      new ApiError('INTERNAL_SERVER_ERROR', 'boom', 500, { 'Cache-Control': 'max-age=60' })
    )
    const response = (await GET[0](
      contextFor('eve-tokenboard', 'https://tokenboard.example/api/public/eve-tokenboard') as never,
      async () => undefined
    )) as Response

    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

function contextFor(slug: string, url: string) {
  return {
    env: {
      DB: {},
      BETTER_AUTH_URL: 'https://tokenboard.example'
    },
    req: {
      param: vi.fn(() => ({ slug })),
      url,
      // The route reads `cf-connecting-ip` off the raw request for its IP rate limit.
      raw: new Request(url)
    },
    json: (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers }),
    body: (body: BodyInit, status = 200, headers?: Record<string, string>) => new Response(body, { status, headers })
  }
}
