import { describe, expect, test } from 'vitest'
import { uploadSnapshots } from './upload'
import { unchangedSnapshot } from './upload-test-helpers'

describe('uploadSnapshots batches', () => {
  test('splits large uploads into free-tier sized batches', async () => {
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
    expect(requests).toHaveLength(34)
    for (let index = 0; index < requests.length; index += 2) {
      const offset = (index / 2) * 30
      const batch = snapshots.slice(offset, offset + 30)
      expect(requests[index]).toEqual(checkRequest(batch))
      expect(requests[index + 1]).toEqual(uploadRequest(batch))
    }
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

function checkRequest(snapshots: (typeof unchangedSnapshot)[]) {
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

function uploadRequest(snapshots: (typeof unchangedSnapshot)[]) {
  return {
    url: 'https://tokenboard.example.com/api/v1/ingest',
    body: { snapshots }
  }
}
