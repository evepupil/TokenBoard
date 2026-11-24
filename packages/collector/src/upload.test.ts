import { describe, expect, test } from 'vitest'
import {
  filterChangedSnapshots,
  readUploadDelivered,
  readUploadRejected,
  snapshotHash,
  uploadSnapshots
} from './upload'
import { changedSnapshot, unchangedSnapshot } from './upload-test-helpers'

describe('filterChangedSnapshots', () => {
  test('skips snapshots whose server hash already matches', async () => {
    const checked = await filterChangedSnapshots([unchangedSnapshot, changedSnapshot], async () => ({
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
    }))

    expect(checked).toEqual({
      snapshots: [changedSnapshot],
      skipped: 1
    })
  })

  test('accepts Antigravity CLI hashes from the server check response', async () => {
    const snapshot = { ...unchangedSnapshot, source: 'antigravity-cli' as const, model: 'Gemini 3.5 Flash (Medium)' }
    const checked = await filterChangedSnapshots([snapshot], async () => ({
      existing: [
        {
          source: snapshot.source,
          usageDate: snapshot.usageDate,
          model: snapshot.model,
          snapshotHash: await snapshotHash(snapshot)
        }
      ]
    }))

    expect(checked).toEqual({ snapshots: [], skipped: 1 })
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

  test('acks sync when there are no collected snapshots', async () => {
    const requests: Array<{ url: string; body: unknown }> = []

    const result = await uploadSnapshots(
      {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'test-upload-token',
        timezone: 'Asia/Shanghai'
      },
      [],
      async (url, init) => {
        requests.push({
          url,
          body: init.body ? JSON.parse(String(init.body)) : null
        })
        return {
          ok: true,
          async json() {
            return { upserted: 0 }
          }
        } as Response
      }
    )

    expect(result).toEqual({ upserted: 0, skipped: 0 })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://tokenboard.example.com/api/v1/ingest')
    expect(requests[0].body).toEqual({ snapshots: [] })
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

  test.each([405, 501])('falls back to full upload when the hash check endpoint returns %i', async (status) =>
    expectUnsupportedHashCheckFallback(status)
  )
})

describe('uploadSnapshots usageDate window', () => {
  const config = {
    endpoint: 'https://tokenboard.example.com/api/v1/ingest',
    uploadToken: 'test-upload-token',
    timezone: 'Asia/Shanghai'
  }

  test('leaves a rejected row out of the delivered set so its cursor is not acknowledged', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const fetched = async (url: string, init: RequestInit) => {
      requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      return {
        ok: true,
        async json() {
          return url.endsWith('/api/v1/ingest/check') ? { existing: [] } : { upserted: 1 }
        }
      } as Response
    }
    const inWindow = { ...unchangedSnapshot, usageDate: '2026-05-01' }
    const outOfWindow = { ...changedSnapshot, usageDate: '2026-05-09' }

    const result = await uploadSnapshots(config, [inWindow, outOfWindow], fetched, {
      now: new Date('2026-05-01T10:00:00.000Z')
    })

    expect(readUploadDelivered(result)).toEqual([inWindow])
    expect(requests[1].body).toEqual({ snapshots: [inWindow] })
  })

  test('posts no batch and delivers nothing when every row falls outside the date window', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const outOfWindow = { ...unchangedSnapshot, usageDate: '2026-05-09' }

    const result = await uploadSnapshots(
      config,
      [outOfWindow],
      async (url, init) => {
        requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
        return {
          ok: true,
          async json() {
            return { upserted: 0 }
          }
        } as Response
      },
      { now: new Date('2026-05-01T10:00:00.000Z') }
    )

    expect(readUploadDelivered(result)).toEqual([])
    expect(requests).toEqual([])
  })

  test('a plain result object carries no delivered set, so stubs keep acknowledging the whole collection', () => {
    expect(readUploadDelivered({ upserted: 1 })).toBeUndefined()
  })

  test('reports each dropped row with its reason so the caller can tell retryable from permanent', async () => {
    const inWindow = { ...unchangedSnapshot, usageDate: '2026-05-01' }
    const invalid = { ...changedSnapshot, usageDate: 'not-a-date' }
    const tooFarFuture = { ...changedSnapshot, usageDate: '2026-05-09' }

    const result = await uploadSnapshots(
      config,
      [inWindow, invalid, tooFarFuture],
      async (url) =>
        ({
          ok: true,
          async json() {
            return url.endsWith('/api/v1/ingest/check') ? { existing: [] } : { upserted: 1 }
          }
        }) as Response,
      { now: new Date('2026-05-01T10:00:00.000Z') }
    )

    expect(readUploadDelivered(result)).toEqual([inWindow])
    expect(readUploadRejected(result)).toEqual([
      { snapshot: invalid, issue: 'invalid' },
      { snapshot: tooFarFuture, issue: 'too-far-future' }
    ])
  })

  test('a plain result object carries no rejected set either', () => {
    expect(readUploadRejected({ upserted: 1 })).toBeUndefined()
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
