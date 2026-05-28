import { describe, expect, test } from 'vitest'
import { uploadSnapshots } from './upload'
import { unchangedSnapshot } from './upload-test-helpers'

describe('uploadSnapshots batches', () => {
  test('splits large uploads into 500-item batches', async () => {
    const snapshots = largeSnapshotSet()
    const requests: Array<{ url: string; body: unknown }> = []
    const result = await uploadSnapshots(
      {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'test-upload-token',
        timezone: 'Asia/Shanghai'
      },
      snapshots,
      createBatchFetch(requests)
    )

    expect(result).toEqual({ upserted: 501, skipped: 0 })
    expect(requests).toHaveLength(4)
    expect(requests[0]).toEqual(checkRequest(snapshots.slice(0, 500)))
    expect(requests[1]).toEqual(uploadRequest(snapshots.slice(0, 500)))
    expect(requests[2]).toEqual(checkRequest(snapshots.slice(500)))
    expect(requests[3]).toEqual(uploadRequest(snapshots.slice(500)))
  })
})

function largeSnapshotSet() {
  return Array.from({ length: 501 }, (_, index) => ({
    ...unchangedSnapshot,
    model: `gpt-5-${index}`,
    totalTokens: unchangedSnapshot.totalTokens + index
  }))
}

function createBatchFetch(requests: Array<{ url: string; body: unknown }>) {
  return async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, body })
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
}

function checkRequest(snapshots: typeof unchangedSnapshot[]) {
  return {
    url: 'https://tokenboard.example.com/api/v1/ingest/check',
    body: {
      keys: snapshots.map((snapshot) => ({
        source: snapshot.source,
        usageDate: snapshot.usageDate,
        model: snapshot.model
      }))
    }
  }
}

function uploadRequest(snapshots: typeof unchangedSnapshot[]) {
  return {
    url: 'https://tokenboard.example.com/api/v1/ingest',
    body: { snapshots }
  }
}
