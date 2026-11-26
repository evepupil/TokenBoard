import { beforeEach, describe, expect, test, vi } from 'vitest'
import { verifyUploadToken } from '../../../../features/auth/middleware'
import { ApiError } from '../../../../lib/errors'
import { clientIpRateLimitSubject, enforceRateLimit } from '../../../../lib/rate-limit'
import { POST } from './check'

vi.mock('../../../../features/auth/middleware', () => ({
  verifyUploadToken: vi.fn()
}))

vi.mock('../../../../lib/rate-limit', () => ({
  clientIpRateLimitSubject: vi.fn((headers: Headers) => ({
    kind: 'ip',
    value: headers.get('cf-connecting-ip') ?? 'unknown'
  })),
  enforceRateLimit: vi.fn(),
  writeRateLimitPolicies: {
    ingestCheck: { id: 'ingest-check', maxRequests: 240, windowSeconds: 60 },
    ingestCheckIp: { id: 'ingest-check-ip', maxRequests: 300, windowSeconds: 60 }
  }
}))

const mockedVerifyUploadToken = vi.mocked(verifyUploadToken)
const mockedClientIpRateLimitSubject = vi.mocked(clientIpRateLimitSubject)
const mockedEnforceRateLimit = vi.mocked(enforceRateLimit)

describe('snapshot check route', () => {
  beforeEach(() => {
    mockedVerifyUploadToken.mockReset()
    mockedClientIpRateLimitSubject.mockClear()
    mockedEnforceRateLimit.mockReset()
  })

  test('rate limits by client IP before upload token lookup', async () => {
    const request = new Request('https://tokenboard.example/api/v1/ingest/check', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.10' }
    })
    const context = {
      env: { DB: {} },
      req: {
        raw: request,
        header: vi.fn(() => 'Bearer token'),
        json: vi.fn(async () => ({ keys: [] }))
      },
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    mockedVerifyUploadToken.mockResolvedValue({
      id: 'user_1',
      uploadTokenHash: 'token_hash',
      deviceId: null,
      installationId: null
    })
    mockedEnforceRateLimit.mockRejectedValueOnce(
      new ApiError('RATE_LIMITED', 'Too many requests. Try again later.', 429)
    )

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(429)
    expect(mockedClientIpRateLimitSubject).toHaveBeenCalledWith(request.headers)
    expect(mockedVerifyUploadToken).not.toHaveBeenCalled()
    expect(context.req.json).not.toHaveBeenCalled()
  })

  // The uploader uses /check to skip unchanged rows; a rejected key must be named so the
  // client can drop it and keep checking the rest of the batch.
  test('names the rejected key in a 400', async () => {
    const context = {
      env: { DB: {} },
      req: {
        raw: new Request('https://tokenboard.example/api/v1/ingest/check', { method: 'POST' }),
        header: vi.fn(() => 'Bearer token'),
        json: vi.fn(async () => ({ keys: [{ source: 'codex', usageDate: 'SENTINEL-DATE', model: 'gpt-5' }] }))
      },
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    mockedVerifyUploadToken.mockResolvedValue({
      id: 'user_1',
      uploadTokenHash: 'token_hash',
      deviceId: null,
      installationId: null
    })

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { details: unknown[] } }
    expect(body.error.details).toEqual([{ index: 0, path: 'keys.0.usageDate', code: 'invalid-date' }])
    expect(JSON.stringify(body)).not.toContain('SENTINEL-DATE')
  })
})
