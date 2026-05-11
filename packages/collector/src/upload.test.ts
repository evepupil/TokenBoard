import { describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { filterChangedSnapshots, snapshotHash, uploadSnapshots } from './upload'

const unchangedSnapshot: UsageSnapshot = {
  source: 'codex',
  usageDate: '2026-05-09',
  timezone: 'Asia/Shanghai',
  model: 'gpt-5',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 5,
  totalTokens: 17,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: '2026-05-09T10:00:00.000Z'
}

const changedSnapshot: UsageSnapshot = {
  ...unchangedSnapshot,
  model: 'gpt-5.5',
  totalTokens: 20
}

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
        uploadToken: 'tk_test',
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
	        uploadToken: 'tk_test',
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
        uploadToken: 'tk_test',
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
        uploadToken: 'tk_test',
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
    async (status) => {
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
          uploadToken: 'tk_test',
          timezone: 'Asia/Shanghai'
        },
        [unchangedSnapshot],
        fetcher
      )

      expect(result).toEqual({ upserted: 1, skipped: 0 })
      expect(requests).toHaveLength(2)
      expect(requests[1].body).toEqual({ snapshots: [unchangedSnapshot] })
    }
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
          uploadToken: 'tk_test',
          timezone: 'Asia/Shanghai'
        },
        [unchangedSnapshot],
        fetcher
      )
    ).rejects.toThrow('Snapshot check failed with status 500')
  })

  test('splits large uploads into 500-item batches', async () => {
    const snapshots = Array.from({ length: 501 }, (_, index) => ({
      ...unchangedSnapshot,
      model: `gpt-5-${index}`,
      totalTokens: unchangedSnapshot.totalTokens + index
    }))
    const requests: Array<{ url: string; body: unknown }> = []
    const fetcher = async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : null
      requests.push({
        url,
        body
      })
      return {
        ok: true,
        async json() {
          return {
            existing: [],
            upserted: body?.snapshots?.length ?? 0
          }
        }
      } as Response
    }

    const result = await uploadSnapshots(
      {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'tk_test',
        timezone: 'Asia/Shanghai'
      },
      snapshots,
      fetcher
    )

    expect(result).toEqual({ upserted: 501, skipped: 0 })
    expect(requests).toHaveLength(4)
    expect(requests[0]).toEqual({
      url: 'https://tokenboard.example.com/api/v1/ingest/check',
      body: {
        keys: snapshots.slice(0, 500).map((snapshot) => ({
          source: snapshot.source,
          usageDate: snapshot.usageDate,
          model: snapshot.model
        }))
      }
    })
    expect(requests[1]).toEqual({
      url: 'https://tokenboard.example.com/api/v1/ingest',
      body: { snapshots: snapshots.slice(0, 500) }
    })
    expect(requests[2]).toEqual({
      url: 'https://tokenboard.example.com/api/v1/ingest/check',
      body: {
        keys: snapshots.slice(500).map((snapshot) => ({
          source: snapshot.source,
          usageDate: snapshot.usageDate,
          model: snapshot.model
        }))
      }
    })
    expect(requests[3]).toEqual({
      url: 'https://tokenboard.example.com/api/v1/ingest',
      body: { snapshots: snapshots.slice(500) }
    })
  })
})
