import { beforeEach, describe, expect, test, vi } from 'vitest'
import { verifyUploadToken } from '../../../features/auth/middleware'
import { ApiError } from '../../../lib/errors'
import {
  clientIpRateLimitSubject,
  enforceRateLimit
} from '../../../lib/rate-limit'
import { POST } from './ingest'

vi.mock('../../../features/auth/middleware', () => ({
  verifyUploadToken: vi.fn()
}))

vi.mock('../../../lib/rate-limit', () => ({
  clientIpRateLimitSubject: vi.fn((headers: Headers) => ({
    kind: 'ip',
    value: headers.get('cf-connecting-ip') ?? 'unknown'
  })),
  enforceRateLimit: vi.fn(),
  writeRateLimitPolicies: {
    ingest: { id: 'ingest', maxRequests: 120, windowSeconds: 60 },
    ingestIp: { id: 'ingest-ip', maxRequests: 300, windowSeconds: 60 }
  }
}))

const mockedVerifyUploadToken = vi.mocked(verifyUploadToken)
const mockedClientIpRateLimitSubject = vi.mocked(clientIpRateLimitSubject)
const mockedEnforceRateLimit = vi.mocked(enforceRateLimit)

describe('ingest route', () => {
  beforeEach(() => {
    mockedVerifyUploadToken.mockReset()
    mockedClientIpRateLimitSubject.mockClear()
    mockedEnforceRateLimit.mockReset()
  })

  test('rate limits by client IP before upload token lookup', async () => {
    const request = new Request('https://tokenboard.example/api/v1/ingest', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.10' }
    })
    const context = {
      env: { DB: {} },
      req: {
        raw: request,
        header: vi.fn(() => 'Bearer token'),
        json: vi.fn(async () => ({ snapshots: [] }))
      },
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    mockedVerifyUploadToken.mockResolvedValue({
      id: 'user_1',
      uploadTokenHash: 'token_hash',
      deviceId: null
    })
    mockedEnforceRateLimit.mockRejectedValueOnce(
      new ApiError('RATE_LIMITED', 'Too many requests. Try again later.', 429)
    )

    const response = await POST[0](context as never, async () => undefined) as Response

    expect(response.status).toBe(429)
    expect(mockedClientIpRateLimitSubject).toHaveBeenCalledWith(request.headers)
    expect(mockedVerifyUploadToken).not.toHaveBeenCalled()
    expect(context.req.json).not.toHaveBeenCalled()
  })
})
