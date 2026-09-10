import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { requireUser } from '../../../features/auth/middleware'
import { listDeviceAuditLogs, listUserDevices } from '../../../features/device/service'
import { ApiError } from '../../../lib/errors'
import { GET } from './details'

vi.mock('../../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

vi.mock('../../../features/device/service', () => ({
  listDeviceAuditLogs: vi.fn(),
  listUserDevices: vi.fn()
}))

const mockedRequireUser = vi.mocked(requireUser)
const mockedListUserDevices = vi.mocked(listUserDevices)
const mockedListDeviceAuditLogs = vi.mocked(listDeviceAuditLogs)

describe('device details route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
    mockedListUserDevices.mockReset()
    mockedListDeviceAuditLogs.mockReset()
  })

  test('renders a full page for normal navigation', async () => {
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedListUserDevices.mockResolvedValue([device()] as never)
    mockedListDeviceAuditLogs.mockResolvedValue([] as never)
    const response = (await GET[0](
      routeContext(
        'https://tokenboard.example/settings/devices/details?deviceId=device_1&view=cards&query=linux'
      ) as never,
      async () => undefined
    )) as Response
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<main')
    expect(html).toContain('设备详情')
    expect(html).toContain('返回列表')
    expect(html).toContain('Linux host')
    expect(mockedListUserDevices).toHaveBeenCalledTimes(1)
    expect(response.headers.get('x-rendered-by')).toBe('app-renderer')
  })

  test('keeps normal unauthenticated navigation on the shared auth redirect path', async () => {
    mockedRequireUser.mockRejectedValue(new ApiError('UNAUTHORIZED', 'Authentication required', 401) as never)

    await expect(
      GET[0](
        routeContext('https://tokenboard.example/settings/devices/details?deviceId=device_1') as never,
        async () => undefined
      )
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  test('renders a full error page through the app renderer when the device is missing', async () => {
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedListUserDevices.mockResolvedValue([] as never)

    const response = (await GET[0](
      routeContext('https://tokenboard.example/settings/devices/details?deviceId=missing') as never,
      async () => undefined
    )) as Response
    const html = await response.text()

    expect(response.status).toBe(404)
    expect(response.headers.get('x-rendered-by')).toBe('app-renderer')
    expect(html).toContain('<main')
    expect(html).toContain('设备不存在或已不可用。')
  })

  test('renders a fragment for enhanced dialog requests', async () => {
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedListUserDevices.mockResolvedValue([device()] as never)
    mockedListDeviceAuditLogs.mockResolvedValue([] as never)

    const response = (await GET[0](
      routeContext('https://tokenboard.example/settings/devices/details?deviceId=device_1&view=list', {
        'x-tokenboard-fragment': 'device-details'
      }) as never,
      async () => undefined
    )) as Response
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('设备详情')
    expect(html).toContain('Linux host')
    expect(html).not.toContain('<main')
    expect(response.headers.get('x-rendered-by')).toBeNull()
  })
})

function routeContext(url: string, headers: Record<string, string> = {}) {
  let responseStatus = 200
  return {
    env: { DB: {} },
    req: {
      query: vi.fn((name: string) => new URL(url).searchParams.get(name)),
      header: vi.fn((name: string) => headers[name.toLowerCase()] ?? null),
      raw: new Request(url, { headers })
    },
    html: vi.fn(async (body: unknown, status = 200) => new Response(await renderToString(body as never), { status })),
    render: vi.fn(
      async (body: unknown) =>
        new Response(await renderToString(body as never), {
          status: responseStatus,
          headers: { 'x-rendered-by': 'app-renderer' }
        })
    ),
    status: vi.fn((status: number) => {
      responseStatus = status
    }),
    redirect: vi.fn((location: string, status = 302) => new Response(null, { status, headers: { location } }))
  }
}

function device() {
  return {
    id: 'device_1',
    name: 'Linux host',
    platform: 'linux',
    lastSyncedAt: '2026-05-29T01:27:47.279Z',
    createdAt: '2026-04-29T10:03:36.232Z',
    activeTokenCount: 1,
    installations: [],
    uploadTokens: []
  }
}
