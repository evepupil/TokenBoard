import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createReconnectPairingCodeFromClaim } from '../../../../features/device/service'
import { clientIpRateLimitSubject, enforceRateLimit } from '../../../../lib/rate-limit'
import { POST } from './reconnect-pairing-codes'

vi.mock('../../../../features/device/repository', () => ({
  D1DevicePairingRepository: vi.fn(function D1DevicePairingRepository() {
    return { kind: 'repository' }
  })
}))

vi.mock('../../../../features/device/service', () => ({
  createPairingCodeDeps: vi.fn(() => ({ kind: 'deps' })),
  createReconnectPairingCodeFromClaim: vi.fn()
}))

vi.mock('../../../../lib/rate-limit', () => ({
  clientIpRateLimitSubject: vi.fn((headers: Headers) => ({
    kind: 'ip',
    value: headers.get('cf-connecting-ip') ?? 'unknown'
  })),
  enforceRateLimit: vi.fn(),
  writeRateLimitPolicies: {
    pairingCode: { id: 'pairing-code', maxRequests: 20, windowSeconds: 60 }
  }
}))

const mockedCreateReconnectPairingCodeFromClaim = vi.mocked(createReconnectPairingCodeFromClaim)
const mockedClientIpRateLimitSubject = vi.mocked(clientIpRateLimitSubject)
const mockedEnforceRateLimit = vi.mocked(enforceRateLimit)

describe('reconnect pairing code route', () => {
  beforeEach(() => {
    mockedCreateReconnectPairingCodeFromClaim.mockReset()
    mockedClientIpRateLimitSubject.mockClear()
    mockedEnforceRateLimit.mockReset()
  })

  test('exchanges a device-link claim for a reconnect pairing code without web session auth', async () => {
    const request = new Request('https://tokenboard.example/api/v1/device/reconnect-pairing-codes', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.10' }
    })
    const context = {
      env: { DB: {}, BETTER_AUTH_URL: 'https://tokenboard.example' },
      req: {
        raw: request,
        url: request.url,
        json: vi.fn(async () => ({
          deviceId: 'dev_1',
          installationId: 'inst_1',
          installClaim: 'claim-secret-fixture'
        }))
      },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }
    mockedCreateReconnectPairingCodeFromClaim.mockResolvedValue({
      pairingCode: 'pair_123',
      expiresAt: '2026-06-30T10:30:00.000Z'
    })

    const response = (await POST[0](context as never, async () => undefined)) as Response
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(context.header).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(body).toEqual({
      pairingCode: 'pair_123',
      expiresAt: '2026-06-30T10:30:00.000Z',
      baseUrl: 'https://tokenboard.example'
    })
    expect(mockedClientIpRateLimitSubject).toHaveBeenCalledWith(request.headers)
    expect(mockedEnforceRateLimit).toHaveBeenCalled()
    expect(mockedCreateReconnectPairingCodeFromClaim).toHaveBeenCalledWith(
      { kind: 'repository' },
      {
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret-fixture'
      },
      { kind: 'deps' }
    )
  })
})
