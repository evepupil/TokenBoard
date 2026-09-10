import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requireUser } from '../../../../features/auth/middleware'
import { createPairingCode } from '../../../../features/device/service'
import { enforceRateLimit } from '../../../../lib/rate-limit'
import { POST } from './pairing-codes'

vi.mock('../../../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

vi.mock('../../../../features/device/repository', () => ({
  D1DevicePairingRepository: vi.fn(function D1DevicePairingRepository() {
    return { kind: 'repository' }
  })
}))

vi.mock('../../../../features/device/service', () => ({
  createPairingCode: vi.fn(),
  createPairingCodeDeps: vi.fn(() => ({ kind: 'deps' }))
}))

vi.mock('../../../../features/settings/service', () => ({
  getCanonicalPublicOrigin: vi.fn(() => 'https://tokenboard.example')
}))

vi.mock('../../../../lib/rate-limit', () => ({
  enforceRateLimit: vi.fn(),
  writeRateLimitPolicies: {
    pairingCode: { id: 'pairing-code', maxRequests: 20, windowSeconds: 60 }
  }
}))

const mockedRequireUser = vi.mocked(requireUser)
const mockedCreatePairingCode = vi.mocked(createPairingCode)
const mockedEnforceRateLimit = vi.mocked(enforceRateLimit)

describe('pairing codes route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
    mockedCreatePairingCode.mockReset()
    mockedEnforceRateLimit.mockReset()
  })

  test('prevents caching one-time pairing code responses', async () => {
    const request = new Request('https://tokenboard.example/api/v1/device/pairing-codes', {
      method: 'POST'
    })
    const context = {
      env: { DB: {}, BETTER_AUTH_URL: 'https://tokenboard.example' },
      req: {
        raw: request,
        url: request.url
      },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedCreatePairingCode.mockResolvedValue({
      pairingCode: 'pair_123',
      expiresAt: '2026-06-30T10:30:00.000Z'
    } as never)

    const response = (await POST[0](context as never, async () => undefined)) as Response
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(context.header).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(body).toEqual({
      pairingCode: 'pair_123',
      expiresAt: '2026-06-30T10:30:00.000Z',
      baseUrl: 'https://tokenboard.example'
    })
    expect(mockedEnforceRateLimit).toHaveBeenCalledWith(context.env.DB, {
      policy: { id: 'pairing-code', maxRequests: 20, windowSeconds: 60 },
      subject: { kind: 'user', value: 'user_1' }
    })
    expect(mockedCreatePairingCode).toHaveBeenCalledWith({ kind: 'repository' }, 'user_1', { kind: 'deps' })
  })
})
