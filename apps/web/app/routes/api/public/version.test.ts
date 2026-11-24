import { describe, expect, test, vi } from 'vitest'
import { clientVersion, serverVersion } from '../../../lib/version'
import { GET } from './version'

describe('public version route', () => {
  test('serves both version numbers without caching', async () => {
    const header = vi.fn()
    const json = vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    const response = (await GET[0]({ header, json } as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ serverVersion, clientVersion })
    // A cached version answer names a deployment that may no longer be there.
    expect(header).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
})
