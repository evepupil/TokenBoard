import { beforeEach, describe, expect, test, vi } from 'vitest'
import { verifyUploadToken } from '../../../features/auth/middleware'
import { ApiError } from '../../../lib/errors'
import { clientIpRateLimitSubject, enforceRateLimit } from '../../../lib/rate-limit'
import { POST, maxIngestBodyBytes } from './ingest'

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

  // The schema ceiling must hold at the HTTP boundary: a snapshot dated beyond tomorrow is a
  // 400 before anything touches the database, not a row no dashboard can ever surface.
  test('rejects snapshots whose usage date is beyond the ceiling with 400', async () => {
    const request = new Request('https://tokenboard.example/api/v1/ingest', { method: 'POST' })
    const context = {
      env: { DB: {} },
      req: {
        raw: request,
        header: vi.fn(() => 'Bearer token'),
        json: vi.fn(async () => ({
          snapshots: [
            {
              source: 'codex',
              usageDate: '2099-01-01',
              timezone: 'UTC',
              model: 'gpt-5',
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalTokens: 2,
              costUsd: 0,
              sessionCount: 1,
              collectedAt: '2026-10-07T00:00:00.000Z'
            }
          ]
        }))
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
    expect(await response.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } })
  })

  // Parsing is what materialises the body in memory, so a declared size past the ceiling is
  // refused from the header alone: a 500-snapshot batch is ~200 KB, and anything at the cap is
  // a client that is not this collector.
  test('rejects an oversized body from its Content-Length before parsing', async () => {
    const declared = String(maxIngestBodyBytes + 1)
    const context = {
      env: { DB: {} },
      req: {
        raw: new Request('https://tokenboard.example/api/v1/ingest', { method: 'POST' }),
        header: vi.fn((name: string) => (name.toLowerCase() === 'content-length' ? declared : 'Bearer token')),
        json: vi.fn(async () => ({ snapshots: [] }))
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

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' }
    })
    expect(context.req.json).not.toHaveBeenCalled()
  })
})
