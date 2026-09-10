import { beforeEach, describe, expect, test, vi } from 'vitest'
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
      url
    },
    json: (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers }),
    body: (body: BodyInit, status = 200, headers?: Record<string, string>) => new Response(body, { status, headers })
  }
}
