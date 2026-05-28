import { describe, expect, test } from 'vitest'
import { filterChangedSnapshots, snapshotHash, uploadSnapshots } from './upload'
import { changedSnapshot, unchangedSnapshot } from './upload-test-helpers'

describe('filterChangedSnapshots', () => {
  test('skips snapshots whose server hash already matches', async () => {
    const checked = await filterChangedSnapshots(
      [unchangedSnapshot, changedSnapshot],
      async () => ({
        existing: [
          {
            source: unchangedSnapshot.source,
            usageDate: unchangedSnapshot.usageDate,
            model: unchangedSnapshot.model,
            snapshotHash: await snapshotHash(unchangedSnapshot)
          },
          {
            source: changedSnapshot.source,
            usageDate: changedSnapshot.usageDate,
            model: changedSnapshot.model,
            snapshotHash: 'different'
          }
        ]
      })
    )

    expect(checked).toEqual({
      snapshots: [changedSnapshot],
      skipped: 1
    })
  })
})

describe('uploadSnapshots', () => {
  test('checks existing hashes before uploading changed snapshots', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const fetcher = async (url: string, init: RequestInit) => {
      requests.push({
        url,
        body: init.body ? JSON.parse(String(init.body)) : null
      })
      return {
        ok: true,
        async json() {
          return url.endsWith('/api/v1/ingest/check')
            ? {
	                existing: [
	                  {
	                    source: unchangedSnapshot.source,
	                    usageDate: unchangedSnapshot.usageDate,
	                    model: unchangedSnapshot.model,
	                    snapshotHash: await snapshotHash(unchangedSnapshot)
	                  }
	                ]
	              }
            : { upserted: 1 }
        }
      } as Response
    }

    const result = await uploadSnapshots(
      {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'test-upload-token',
        timezone: 'Asia/Shanghai'
      },
      [unchangedSnapshot, changedSnapshot],
      fetcher
    )

    expect(result).toEqual({ upserted: 1, skipped: 1 })
    expect(requests).toHaveLength(2)
    expect(requests[0].url).toBe('https://tokenboard.example.com/api/v1/ingest/check')
	    expect(requests[1].url).toBe('https://tokenboard.example.com/api/v1/ingest')
	    expect(requests[1].body).toEqual({ snapshots: [changedSnapshot] })
	  })

	  test('does not call the server when there are no collected snapshots', async () => {
	    const requests: unknown[] = []

	    const result = await uploadSnapshots(
	      {
	        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
	        uploadToken: 'test-upload-token',
	        timezone: 'Asia/Shanghai'
	      },
	      [],
	      async () => {
	        requests.push('called')
	        return { ok: true, async json() { return {} } } as Response
	      }
	    )

	    expect(result).toEqual({ upserted: 0, skipped: 0 })
	    expect(requests).toEqual([])
	  })

	  test('acks sync when every snapshot already exists on the server', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const fetcher = async (url: string, init: RequestInit) => {
      requests.push({
        url,
        body: init.body ? JSON.parse(String(init.body)) : null
      })
      return {
        ok: true,
        async json() {
          return url.endsWith('/api/v1/ingest/check')
            ? {
                existing: [
                  {
                    source: unchangedSnapshot.source,
                    usageDate: unchangedSnapshot.usageDate,
                    model: unchangedSnapshot.model,
                    snapshotHash: await snapshotHash(unchangedSnapshot)
                  }
                ]
              }
            : { upserted: 0 }
        }
      } as Response
    }

    const result = await uploadSnapshots(
      {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'test-upload-token',
        timezone: 'Asia/Shanghai'
      },
      [unchangedSnapshot],
      fetcher
    )

    expect(result).toEqual({ upserted: 0, skipped: 1 })
    expect(requests).toHaveLength(2)
    expect(requests[1].body).toEqual({ snapshots: [] })
  })

  test('falls back to full upload when the server does not support hash checks yet', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const fetcher = async (url: string, init: RequestInit) => {
      requests.push({
        url,
        body: init.body ? JSON.parse(String(init.body)) : null
      })
      return {
        ok: !url.endsWith('/api/v1/ingest/check'),
        status: url.endsWith('/api/v1/ingest/check') ? 404 : 200,
        async json() {
          return { upserted: 1 }
        }
      } as Response
    }

    const result = await uploadSnapshots(
      {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'test-upload-token',
        timezone: 'Asia/Shanghai'
      },
      [unchangedSnapshot],
      fetcher
    )

    expect(result).toEqual({ upserted: 1, skipped: 0 })
    expect(requests).toHaveLength(2)
    expect(requests[1].body).toEqual({ snapshots: [unchangedSnapshot] })
  })

  test.each([405, 501])(
    'falls back to full upload when the hash check endpoint returns %i',
    async (status) => expectUnsupportedHashCheckFallback(status)
  )

  test('does not fall back when hash check fails with a server error', async () => {
    const fetcher = async () =>
      ({
        ok: false,
        status: 500,
        async json() {
          return {}
        }
      }) as Response

    await expect(
      uploadSnapshots(
        {
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          uploadToken: 'test-upload-token',
          timezone: 'Asia/Shanghai'
        },
        [unchangedSnapshot],
        fetcher
      )
    ).rejects.toThrow('Snapshot check failed with status 500')
  })

  test('retries transient fetch failures during hash check and upload', async () => {
    const requests: string[] = []
    const failures = new Set([
      'https://tokenboard.example.com/api/v1/ingest/check',
      'https://tokenboard.example.com/api/v1/ingest'
    ])
    const fetcher = async (url: string) => {
      requests.push(url)
      if (failures.delete(url)) throw new TypeError('fetch failed')
      return {
        ok: true,
        async json() {
          return url.endsWith('/check') ? { existing: [] } : { upserted: 1 }
        }
      } as Response
    }

    const result = await uploadSnapshots(
      {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'test-upload-token',
        timezone: 'Asia/Shanghai'
      },
      [unchangedSnapshot],
      fetcher
    )

    expect(result).toEqual({ upserted: 1, skipped: 0 })
    expect(requests).toEqual([
      'https://tokenboard.example.com/api/v1/ingest/check',
      'https://tokenboard.example.com/api/v1/ingest/check',
      'https://tokenboard.example.com/api/v1/ingest',
      'https://tokenboard.example.com/api/v1/ingest'
    ])
  })

})

async function expectUnsupportedHashCheckFallback(status: number) {
  const requests: Array<{ url: string; body: unknown }> = []
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : null
    })
    return {
      ok: !url.endsWith('/api/v1/ingest/check'),
      status: url.endsWith('/api/v1/ingest/check') ? status : 200,
      async json() {
        return { upserted: 1 }
      }
    } as Response
  }

  const result = await uploadSnapshots(
    {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai'
    },
    [unchangedSnapshot],
    fetcher
  )

  expect(result).toEqual({ upserted: 1, skipped: 0 })
  expect(requests).toHaveLength(2)
  expect(requests[1].body).toEqual({ snapshots: [unchangedSnapshot] })
}
