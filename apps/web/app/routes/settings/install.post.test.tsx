import { renderToString } from 'hono/jsx/dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requireUser } from '../../features/auth/middleware'
import { createPairingCode } from '../../features/device/service'
import { getCanonicalPublicOrigin, getProfileTimezoneSettings } from '../../features/settings/service'
import { ApiError } from '../../lib/errors'
import { enforceRateLimit } from '../../lib/rate-limit'
import { POST } from './install'

vi.mock('../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

// The settings form mints the same one-time pairing code as POST /api/v1/device/pairing-codes,
// which is rate-limited per user. Without the same ceiling here the API limit is bypassable by
// posting this form instead.
vi.mock('../../lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limit')>()),
  enforceRateLimit: vi.fn()
}))

vi.mock('../../features/device/repository', () => ({
  D1DevicePairingRepository: vi.fn(function D1DevicePairingRepository() {
    return { kind: 'repository' }
  })
}))

vi.mock('../../features/device/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/device/service')>()
  return {
    ...actual,
    createPairingCode: vi.fn(),
    createPairingCodeDeps: vi.fn(() => ({ kind: 'deps' }))
  }
})

vi.mock('../../features/settings/service', () => ({
  getCanonicalPublicOrigin: vi.fn(() => 'https://tokenboard.example'),
  getProfileTimezoneSettings: vi.fn()
}))

const mockedRequireUser = vi.mocked(requireUser)
const mockedCreatePairingCode = vi.mocked(createPairingCode)
const mockedGetCanonicalPublicOrigin = vi.mocked(getCanonicalPublicOrigin)
const mockedGetProfileTimezoneSettings = vi.mocked(getProfileTimezoneSettings)
const mockedEnforceRateLimit = vi.mocked(enforceRateLimit)

describe('install POST route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
    mockedCreatePairingCode.mockReset()
    mockedGetCanonicalPublicOrigin.mockClear()
    mockedGetProfileTimezoneSettings.mockReset()
    mockedEnforceRateLimit.mockReset()
  })

  test('rate-limits pairing code creation per user', async () => {
    const context = postContext({ timezone: 'Asia/Shanghai' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedEnforceRateLimit.mockRejectedValue(new ApiError('RATE_LIMITED', 'Too many requests', 429))

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(429)
    expect(mockedCreatePairingCode).not.toHaveBeenCalled()
    expect(mockedEnforceRateLimit).toHaveBeenCalledWith(context.env.DB, {
      policy: expect.objectContaining({ id: 'pairing-code' }),
      subject: { kind: 'user', value: 'user_1' }
    })
  })

  test('prevents caching one-time pairing code pages', async () => {
    const context = postContext({ timezone: 'Asia/Shanghai' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedGetProfileTimezoneSettings.mockResolvedValue({ timezone: 'Asia/Shanghai' } as never)
    mockedCreatePairingCode.mockResolvedValue({
      pairingCode: 'pair_123',
      expiresAt: '2026-06-30T10:30:00.000Z'
    } as never)

    const response = (await POST[0](context as never, async () => undefined)) as Response
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(html).toContain('pair_123')
    expect(mockedCreatePairingCode).toHaveBeenCalled()
  })
})

function postContext(body: Record<string, unknown>) {
  const headers = new Headers()
  return {
    env: {
      DB: {},
      BETTER_AUTH_URL: 'https://tokenboard.example'
    },
    req: {
      url: 'https://tokenboard.example/settings/install',
      parseBody: vi.fn(async () => body)
    },
    header: vi.fn((name: string, value: string) => {
      headers.set(name, value)
    }),
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status, headers })),
    render: vi.fn(async (body: unknown) => new Response(await renderToString(body as never), { headers }))
  }
}
