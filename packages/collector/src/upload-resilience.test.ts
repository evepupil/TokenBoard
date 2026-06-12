import { describe, expect, test, vi } from 'vitest'
import { uploadSnapshots } from './upload'
import { unchangedSnapshot } from './upload-test-helpers'

const config = {
  endpoint: 'https://tokenboard.example.com/api/v1/ingest',
  uploadToken: 'test-upload-token',
  timezone: 'Asia/Shanghai'
}

describe('uploadSnapshots resilience', () => {
  test('calls injected fetchers with the global context', async () => {
    const calls: string[] = []
    const thisSensitiveFetch = vi.fn(function (this: unknown, url: string) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.')
      }
      calls.push(url)
      return Promise.resolve(successResponse(url))
    })

    const result = await uploadSnapshots(config, [unchangedSnapshot], thisSensitiveFetch)

    expect(result).toEqual({ upserted: 1, skipped: 0 })
    expect(calls).toEqual([`${config.endpoint}/check`, config.endpoint])
  })

  test('does not fall back when hash check fails with a non-retryable error', async () => {
    const fetcher = async () =>
      ({
        ok: false,
        status: 400,
        async json() {
          return {}
        }
      }) as Response

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Snapshot check failed with status 400'
    )
  })

  test('retries transient fetch failures during hash check and upload', async () => {
    vi.stubEnv('TOKENBOARD_FETCH_RETRY_DELAY_MS', '0')
    const requests: string[] = []
    const failures = new Set([`${config.endpoint}/check`, config.endpoint])
    const fetcher = async (url: string) => {
      requests.push(url)
      if (failures.delete(url)) throw new TypeError('fetch failed')
      return successResponse(url)
    }

    try {
      const result = await uploadSnapshots(config, [unchangedSnapshot], fetcher)

      expect(result).toEqual({ upserted: 1, skipped: 0 })
      expect(requests).toEqual([
        `${config.endpoint}/check`,
        `${config.endpoint}/check`,
        config.endpoint,
        config.endpoint
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('retries retryable server responses during hash check and upload', async () => {
    vi.stubEnv('TOKENBOARD_FETCH_RETRY_DELAY_MS', '0')
    const requests: string[] = []
    const attempts = new Map<string, number>()
    const fetcher = async (url: string) => {
      requests.push(url)
      const count = attempts.get(url) ?? 0
      attempts.set(url, count + 1)
      if (count === 0) {
        return retryableResponse(url.endsWith('/check') ? 503 : 429)
      }
      return successResponse(url)
    }

    try {
      const result = await uploadSnapshots(config, [unchangedSnapshot], fetcher)

      expect(result).toEqual({ upserted: 1, skipped: 0 })
      expect(requests).toEqual([
        `${config.endpoint}/check`,
        `${config.endpoint}/check`,
        config.endpoint,
        config.endpoint
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('does not retry non-retryable upload responses', async () => {
    const requests: string[] = []
    const fetcher = async (url: string) => {
      requests.push(url)
      return url.endsWith('/check') ? successResponse(url) : unauthorizedResponse()
    }

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Upload failed with status 401'
    )
    expect(requests).toEqual([`${config.endpoint}/check`, config.endpoint])
  })

  test('fails visibly when the hash check response shape is invalid', async () => {
    const fetcher = async () => jsonResponse({ existing: [{ source: 'codex' }] })

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Snapshot check returned invalid response'
    )
  })

  test('fails visibly when the hash check response contains an invalid hash', async () => {
    const fetcher = async () =>
      jsonResponse({
        existing: [
          {
            source: unchangedSnapshot.source,
            usageDate: unchangedSnapshot.usageDate,
            model: unchangedSnapshot.model,
            snapshotHash: 'not-a-sha256-hash'
          }
        ]
      })

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Snapshot check returned invalid response'
    )
  })

  test('fails visibly when the upload response shape is invalid', async () => {
    const fetcher = async (url: string) =>
      url.endsWith('/check') ? jsonResponse({ existing: [] }) : jsonResponse({ ok: true })

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Upload returned invalid response'
    )
  })

  test('fails visibly when the upload response count is invalid', async () => {
    const fetcher = async (url: string) =>
      url.endsWith('/check') ? jsonResponse({ existing: [] }) : jsonResponse({ upserted: -1 })

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Upload returned invalid response'
    )
  })
})

function successResponse(url: string) {
  return jsonResponse(url.endsWith('/check') ? { existing: [] } : { upserted: 1 })
}

function retryableResponse(status: number) {
  return {
    ok: false,
    status,
    headers: new Headers({ 'retry-after': '0' }),
    async json() {
      return {}
    }
  } as Response
}

function unauthorizedResponse() {
  return {
    ok: false,
    status: 401,
    async json() {
      return { error: 'unauthorized' }
    }
  } as Response
}

function jsonResponse(value: unknown) {
  return {
    ok: true,
    async json() {
      return value
    }
  } as Response
}
