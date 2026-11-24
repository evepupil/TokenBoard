import { describe, expect, test, vi } from 'vitest'
import { serverVersion } from '../../../lib/version'
import { GET } from './health'

describe('health route', () => {
  test('reports ok with the deployment version and stays uncacheable', async () => {
    const header = vi.fn()
    const json = vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    const response = (await GET[0]({ header, json } as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, name: 'TokenBoard', version: serverVersion })
    expect(header).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
})
