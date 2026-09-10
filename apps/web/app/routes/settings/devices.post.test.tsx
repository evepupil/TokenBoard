import { renderToString } from 'hono/jsx/dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requireUser } from '../../features/auth/middleware'
import {
  listDeviceAuditLogs,
  listLatestDeviceAuditLogs,
  listUserDevices,
  parseDeviceNameForm,
  renameDevice,
  revokeDevice,
  revokeInstallation,
  revokeUploadToken,
  rotateUploadToken
} from '../../features/device/service'
import { POST } from './devices'

vi.mock('../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

vi.mock('../../features/device/service', () => ({
  listDeviceAuditLogs: vi.fn(),
  listLatestDeviceAuditLogs: vi.fn(),
  listUserDevices: vi.fn(),
  parseDeviceNameForm: vi.fn(),
  renameDevice: vi.fn(),
  revokeDevice: vi.fn(),
  revokeInstallation: vi.fn(),
  revokeUploadToken: vi.fn(),
  rotateUploadToken: vi.fn()
}))

const mockedRequireUser = vi.mocked(requireUser)
const mockedListDeviceAuditLogs = vi.mocked(listDeviceAuditLogs)
const mockedListLatestDeviceAuditLogs = vi.mocked(listLatestDeviceAuditLogs)
const mockedListUserDevices = vi.mocked(listUserDevices)
const mockedParseDeviceNameForm = vi.mocked(parseDeviceNameForm)
const mockedRenameDevice = vi.mocked(renameDevice)
const mockedRevokeDevice = vi.mocked(revokeDevice)
const mockedRevokeInstallation = vi.mocked(revokeInstallation)
const mockedRevokeUploadToken = vi.mocked(revokeUploadToken)
const mockedRotateUploadToken = vi.mocked(rotateUploadToken)

describe('devices POST route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
    mockedListDeviceAuditLogs.mockReset()
    mockedListLatestDeviceAuditLogs.mockReset()
    mockedListUserDevices.mockReset()
    mockedParseDeviceNameForm.mockReset()
    mockedRenameDevice.mockReset()
    mockedRevokeDevice.mockReset()
    mockedRevokeInstallation.mockReset()
    mockedRevokeUploadToken.mockReset()
    mockedRotateUploadToken.mockReset()
  })

  test('prevents caching one-time rotated credentials', async () => {
    const context = postContext(
      {
        action: 'rotate-token',
        uploadTokenId: 'ut_old',
        view: 'cards',
        query: 'macbook'
      },
      {
        url: 'https://preview.example/settings/devices',
        betterAuthUrl: 'https://tokenboard.example/'
      }
    )
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedRotateUploadToken.mockResolvedValue({
      uploadTokenId: 'ut_new',
      uploadToken: 'tb_upload_new_secret',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaim: 'tb_install_new_secret'
    } as never)
    mockedListUserDevices.mockResolvedValue([] as never)
    mockedListLatestDeviceAuditLogs.mockResolvedValue(new Map() as never)

    const response = (await POST[0](context as never, async () => undefined)) as Response
    const html = await response.text()

    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(html).toContain('tb_upload_new_secret')
    expect(html).toContain('tb_install_new_secret')
    expect(html).toContain('--server-origin &#39;https://tokenboard.example&#39;')
    expect(html).not.toContain('https://preview.example')
    expect(mockedRotateUploadToken).toHaveBeenCalledWith(context.env.DB, {
      userId: 'user_1',
      uploadTokenId: 'ut_old'
    })
  })
})

function postContext(
  body: Record<string, unknown>,
  options: {
    url?: string
    betterAuthUrl?: string
  } = {}
) {
  const headers = new Headers()
  return {
    env: { DB: {}, BETTER_AUTH_URL: options.betterAuthUrl },
    req: {
      url: options.url ?? 'https://tokenboard.example/settings/devices',
      parseBody: vi.fn(async () => body)
    },
    header: vi.fn((name: string, value: string) => {
      headers.set(name, value)
    }),
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status, headers })),
    redirect: vi.fn((location: string, status = 302) => new Response(null, { status, headers: { location } })),
    render: vi.fn(async (body: unknown) => new Response(await renderToString(body as never), { headers }))
  }
}
