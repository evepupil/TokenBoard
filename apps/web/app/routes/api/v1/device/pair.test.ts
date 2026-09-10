import { beforeEach, describe, expect, test, vi } from 'vitest'
import { pairDevice } from '../../../../features/device/service'
import { clientIpRateLimitSubject, enforceRateLimit } from '../../../../lib/rate-limit'
import { ApiError } from '../../../../lib/errors'
import { POST } from './pair'

vi.mock('../../../../features/device/repository', () => ({
  D1DevicePairingRepository: vi.fn(function D1DevicePairingRepository() {
    return { kind: 'repository' }
  })
}))

vi.mock('../../../../features/device/service', () => ({
  createPairDeviceDeps: vi.fn((endpoint: string) => ({ endpoint })),
  pairDevice: vi.fn()
}))

vi.mock('../../../../lib/rate-limit', () => ({
  clientIpRateLimitSubject: vi.fn((headers: Headers) => ({
    kind: 'ip',
    value: headers.get('cf-connecting-ip') ?? 'unknown'
  })),
  enforceRateLimit: vi.fn(),
  writeRateLimitPolicies: {
    devicePair: { id: 'device-pair', maxRequests: 20, windowSeconds: 60 }
  }
}))

const mockedPairDevice = vi.mocked(pairDevice)
const mockedClientIpRateLimitSubject = vi.mocked(clientIpRateLimitSubject)
const mockedEnforceRateLimit = vi.mocked(enforceRateLimit)

describe('device pair route', () => {
  beforeEach(() => {
    mockedPairDevice.mockReset()
    mockedClientIpRateLimitSubject.mockClear()
    mockedEnforceRateLimit.mockReset()
  })

  test('prevents caching one-time upload token and install claim responses', async () => {
    const request = new Request('https://tokenboard.example/api/v1/device/pair', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.10' }
    })
    const context = {
      env: { DB: {} },
      req: {
        raw: request,
        url: request.url,
        json: vi.fn(async () => ({
          pairingCode: 'pair_123',
          deviceName: 'MacBook Pro',
          platform: 'darwin',
          timezone: 'Asia/Shanghai'
        }))
      },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }
    mockedPairDevice.mockResolvedValue({
      uploadToken: 'tb_upload_secret',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaim: 'tb_install_secret',
      endpoint: 'https://tokenboard.example/api/v1/ingest'
    } as never)

    const response = (await POST[0](context as never, async () => undefined)) as Response
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(context.header).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(body).toMatchObject({
      uploadToken: 'tb_upload_secret',
      installClaim: 'tb_install_secret'
    })
    expect(mockedClientIpRateLimitSubject).toHaveBeenCalledWith(request.headers)
    expect(mockedEnforceRateLimit).toHaveBeenCalled()
    expect(mockedPairDevice).toHaveBeenCalledWith(
      { kind: 'repository' },
      {
        pairingCode: 'pair_123',
        deviceName: 'MacBook Pro',
        platform: 'darwin',
        timezone: 'Asia/Shanghai'
      },
      { endpoint: 'https://tokenboard.example/api/v1/ingest' }
    )
  })

  test('preserves inactive reconnect targets as a not-found response', async () => {
    const request = new Request('https://tokenboard.example/api/v1/device/pair', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.10' }
    })
    const context = {
      env: { DB: {} },
      req: {
        raw: request,
        url: request.url,
        json: vi.fn(async () => ({ pairingCode: 'pair_123' }))
      },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }
    mockedPairDevice.mockRejectedValue(new ApiError('NOT_FOUND', 'Device has no active installation', 404))

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Device has no active installation'
      }
    })
    expect(context.header).not.toHaveBeenCalled()
  })
})
