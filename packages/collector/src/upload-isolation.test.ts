import { describe, expect, test } from 'vitest'
import { readUploadBlocked, readUploadDelivered, uploadSnapshots } from './upload'
import { unchangedSnapshot } from './upload-test-helpers'

const config = {
  endpoint: 'https://tokenboard.example.com/api/v1/ingest',
  uploadToken: 'test-upload-token',
  timezone: 'Asia/Shanghai'
}

function snapshot(model: string, totalTokens = 100) {
  return { ...unchangedSnapshot, model, totalTokens }
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
    async json() {
      return body
    }
  } as unknown as Response
}

// The check endpoint answers 404 (unsupported), so every row is posted; the
// ingest endpoint names any row whose model is "bad" in a 400.
function isolationFetcher(state: { ingestCalls: number; badCode?: string }) {
  return async (url: string, init?: RequestInit) => {
    if (url.endsWith('/check')) return jsonResponse({}, 404)
    state.ingestCalls += 1
    const body = JSON.parse(String(init?.body ?? '{}')) as { snapshots: Array<{ model: string }> }
    for (const [index, posted] of body.snapshots.entries()) {
      if (posted.model === 'bad') {
        return jsonResponse(
          {
            error: {
              code: 'BAD_REQUEST',
              message: 'Invalid request',
              details: [
                { index, path: `snapshots.${index}.usageDate`, code: state.badCode ?? 'usage-date-too-far-future' }
              ]
            }
          },
          400
        )
      }
    }
    return jsonResponse({ upserted: body.snapshots.length })
  }
}

describe('upload isolation', () => {
  test('isolates the rows a 400 names and delivers the rest', async () => {
    const state = { ingestCalls: 0 }
    const good = snapshot('good')
    const bad = snapshot('bad')
    const also = snapshot('also-good')

    const result = await uploadSnapshots(config, [good, bad, also], isolationFetcher(state))

    expect(state.ingestCalls).toBe(2)
    expect(readUploadBlocked(result)).toEqual([{ snapshot: bad, code: 'usage-date-too-far-future' }])
    // A blocked row never reached the server: acknowledging it would retire it.
    expect(readUploadDelivered(result)?.map((row) => row.model)).toEqual(['good', 'also-good'])
  })

  test('stops isolating after two rounds instead of looping', async () => {
    let ingestCalls = 0
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/check')) return jsonResponse({}, 404)
      ingestCalls += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { snapshots: unknown[] }
      if (body.snapshots.length === 0) return jsonResponse({ upserted: 0 })
      return jsonResponse(
        {
          error: {
            code: 'BAD_REQUEST',
            message: 'Invalid request',
            details: [{ index: 0, path: 'snapshots.0.model', code: 'invalid-value' }]
          }
        },
        400
      )
    }

    await expect(uploadSnapshots(config, [snapshot('a'), snapshot('b'), snapshot('c')], fetcher)).rejects.toThrow(
      'Upload failed with status 400'
    )
    expect(ingestCalls).toBe(3)
  })

  test('fails the whole batch on a 400 without details', async () => {
    let ingestCalls = 0
    const fetcher = async (url: string) => {
      if (url.endsWith('/check')) return jsonResponse({}, 404)
      ingestCalls += 1
      return jsonResponse({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } }, 400)
    }

    await expect(uploadSnapshots(config, [snapshot('a')], fetcher)).rejects.toThrow('Upload failed with status 400')
    expect(ingestCalls).toBe(1)
  })

  test('drops a rejected check key and retries with the rest', async () => {
    const keysSeen: number[] = []
    let checkCalls = 0
    let upserted = 0
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/check')) {
        checkCalls += 1
        const body = JSON.parse(String(init?.body ?? '{}')) as { keys: unknown[] }
        keysSeen.push(body.keys.length)
        if (checkCalls === 1) {
          return jsonResponse(
            { error: { details: [{ index: 0, path: 'keys.0.usageDate', code: 'invalid-date' }] } },
            400
          )
        }
        return jsonResponse({ existing: [] })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { snapshots: unknown[] }
      upserted += body.snapshots.length
      return jsonResponse({ upserted: body.snapshots.length })
    }

    const result = await uploadSnapshots(config, [snapshot('a'), snapshot('b')], fetcher)

    expect(checkCalls).toBe(2)
    expect(keysSeen).toEqual([2, 1])
    expect(upserted).toBe(2)
    expect((result as { upserted: number }).upserted).toBe(2)
  })
})
