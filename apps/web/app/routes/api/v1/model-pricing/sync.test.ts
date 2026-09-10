import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  modelPricingSyncEnabled,
  parsePricingSyncToken,
  pricingSyncTokenConfigured,
  readModelPricingSyncState,
  runModelPricingSync,
  verifyPricingSyncToken
} from '../../../../features/model-pricing/service'
import { POST } from './sync'
import { enforceRateLimit } from '../../../../lib/rate-limit'
import { ApiError } from '../../../../lib/errors'

vi.mock('../../../../features/model-pricing/service', () => ({
  modelPricingSyncEnabled: vi.fn(),
  parsePricingSyncToken: vi.fn(),
  pricingSyncTokenConfigured: vi.fn(),
  readModelPricingSyncState: vi.fn(),
  runModelPricingSync: vi.fn(),
  verifyPricingSyncToken: vi.fn()
}))

const mockedEnabled = vi.mocked(modelPricingSyncEnabled)
const mockedParse = vi.mocked(parsePricingSyncToken)
const mockedConfigured = vi.mocked(pricingSyncTokenConfigured)
const mockedRun = vi.mocked(runModelPricingSync)
const mockedVerify = vi.mocked(verifyPricingSyncToken)
const mockedState = vi.mocked(readModelPricingSyncState)
const mockedRateLimit = vi.mocked(enforceRateLimit)

vi.mock('../../../../lib/rate-limit', () => ({
  clientIpRateLimitSubject: vi.fn(() => ({ kind: 'ip', value: 'test-ip' })),
  enforceRateLimit: vi.fn(),
  writeRateLimitPolicies: { modelPricingSyncIp: { id: 'model-pricing-sync-ip', maxRequests: 5, windowSeconds: 900 } }
}))

describe('model pricing sync route', () => {
  beforeEach(() => {
    mockedEnabled.mockReset()
    mockedParse.mockReset()
    mockedConfigured.mockReset()
    mockedRun.mockReset()
    mockedVerify.mockReset()
    mockedState.mockReset()
    mockedRateLimit.mockReset()
  })

  test('requires the configured secret and forces a sync', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(true)
    mockedParse.mockReturnValue('secret')
    mockedEnabled.mockReturnValue(true)
    mockedRun.mockResolvedValue({ status: 'success', modelCount: 3, sourceUpdatedAt: '2026-08-07' })
    mockedState.mockResolvedValue({
      status: 'success',
      sourceUrl: 'https://models.dev/api.json',
      lastStartedAt: '2026-08-07T00:00:00.000Z',
      lastSuccessAt: '2026-08-07T00:00:00.000Z',
      lastFailureAt: null,
      lastSourceUpdatedAt: '2026-08-07',
      modelCount: 3,
      activeGeneration: 'generation',
      lastError: null,
      updatedAt: '2026-08-07T00:00:00.000Z'
    })
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'success',
      scheduledSyncEnabled: true,
      syncState: { modelCount: 3 }
    })
    expect(mockedRun).toHaveBeenCalledWith({ env: context.env, force: true })
    expect(mockedRateLimit).toHaveBeenCalledOnce()
    expect(mockedRateLimit.mock.calls[0]?.[1]?.subject).toEqual({ kind: 'ip', value: 'test-ip\u0000secret' })
    expect(context.header).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  test('rejects an invalid secret before reading source data', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(false)
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' }
    })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(401)
    expect(mockedRateLimit).not.toHaveBeenCalled()
    expect(mockedRun).not.toHaveBeenCalled()
  })

  test('does not disclose the secret environment variable when sync is unconfigured', async () => {
    mockedConfigured.mockReturnValue(false)
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST'
    })
    const context = {
      env: { DB: {} },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Model pricing sync is not configured' }
    })
    expect(JSON.stringify(body)).not.toContain('TOKENBOARD_MODEL_PRICING_SYNC_TOKEN')
    expect(mockedVerify).not.toHaveBeenCalled()
    expect(mockedRateLimit).not.toHaveBeenCalled()
    expect(mockedRun).not.toHaveBeenCalled()
  })

  test('returns 429 after authenticating when the IP limit rejects', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(true)
    mockedParse.mockReturnValue('secret')
    mockedRateLimit.mockRejectedValueOnce(new ApiError('RATE_LIMITED', 'Too many requests', 429))
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' }
    })
    expect(mockedVerify).toHaveBeenCalledWith(context.env, 'Bearer secret')
    expect(mockedRun).not.toHaveBeenCalled()
  })

  test('uses the parsed token for the rate-limit key despite authorization whitespace', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(true)
    mockedParse.mockReturnValue('secret')
    mockedEnabled.mockReturnValue(true)
    mockedRun.mockResolvedValue({ status: 'success', modelCount: 0, sourceUpdatedAt: null })
    mockedState.mockResolvedValue(null)
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer   secret' }
    })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    await POST[0](context as never, async () => undefined)

    expect(mockedParse).toHaveBeenCalledWith('Bearer   secret')
    expect(mockedRateLimit.mock.calls[0]?.[1]?.subject).toEqual({ kind: 'ip', value: 'test-ip\u0000secret' })
  })
})
