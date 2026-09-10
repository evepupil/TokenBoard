import { renderToString } from 'hono/jsx/dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DeviceDetailsDialogContent, DevicesPage } from './devices'

describe('DevicesPage layout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-29T02:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('renders the list view with search, summary, and actions', async () => {
    const html = await renderToString(
      <DevicesPage
        email="user@example.com"
        saved={false}
        revoked={null}
        devices={[
          {
            id: 'device_1',
            name: 'MacBook Pro With A Long Local Collector Name',
            platform: 'darwin',
            lastSyncedAt: '2026-05-29T01:27:47.279Z',
            createdAt: '2026-04-29T10:03:36.232Z',
            activeTokenCount: 1,
            installations: [
              {
                id: 'inst_1',
                deviceId: 'device_1',
                platform: 'darwin',
                hostname: 'MacBook Pro',
                clientVersion: '0.2.0',
                firstSeenAt: '2026-04-29T10:03:36.232Z',
                lastSeenAt: '2026-05-29T01:27:47.279Z',
                revokedAt: null,
                activeTokenCount: 1
              }
            ],
            uploadTokens: [
              {
                id: 'ut_1',
                deviceId: 'device_1',
                installationId: 'inst_1',
                name: 'MacBook Pro upload token',
                lastUsedAt: '2026-05-29T01:27:47.279Z',
                createdAt: '2026-04-29T10:03:36.232Z',
                revokedAt: null
              },
              {
                id: 'ut_old',
                deviceId: 'device_1',
                installationId: 'inst_1',
                name: 'MacBook Pro old credential',
                lastUsedAt: '2026-05-28T01:27:47.279Z',
                createdAt: '2026-04-29T10:03:36.232Z',
                revokedAt: '2026-05-29T01:40:00.000Z'
              }
            ],
            auditLogs: [
              {
                id: 'audit_1',
                action: 'device.reconnect',
                targetType: 'device',
                targetId: 'device_1',
                metadata: '{"installationId":"inst_1"}',
                createdAt: '2026-05-29T01:30:00.000Z'
              },
              {
                id: 'audit_2',
                action: 'token.rotate',
                targetType: 'upload_token',
                targetId: 'ut_2',
                metadata: '{"previousTokenId":"ut_1"}',
                createdAt: '2026-05-29T01:40:00.000Z'
              }
            ]
          }
        ]}
      />
    )

    expect(html).toContain('data-devices-list="true"')
    expect(html).toContain('data-device-card-mode="list"')
    expect(html).toContain('data-device-list-row="true"')
    expect(html).toContain('data-device-details-dialog="true"')
    expect(html).toContain('data-device-details-open="device-details-dialog"')
    expect(html).toContain('href="/settings/devices/details?deviceId=device_1&amp;view=list"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-controls="device-details-dialog"')
    expect(html).toContain('data-devices-overview="true"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('搜设备名、平台、安装或凭证')
    expect(html).toContain('macOS / 同步 32分钟前')
    expect(html).toContain('列表')
    expect(html).toContain('卡片')
    expect(html).toContain('连接新设备')
    expect(html).toContain('tabular-nums')
    expect(html).toContain('MacBook Pro With A Long Local Collector Name')
    expect(html).toContain('重连')
    expect(html).toContain('详情')
    expect(html).toContain('可用凭证')
    expect(html).toContain('安装记录 1 / 可用凭证 1')
    expect(html).toContain('安装 / 可用凭证')
    expect(html).toContain('32分钟前')
    expect(html).toContain('最近操作')
    expect(html).toContain('重连')
    expect(html).toContain('data-link-button="true"')
    expect(html).not.toContain('MacBook Pro upload token')
    expect(html).not.toContain('name="uploadTokenId"')
    expect(html).not.toContain('name="installationId"')
    expect(html).not.toContain('<details class="group"')
    expect(html).not.toContain('xl:-translate-x-')
    expect(html).not.toContain('data-devices-card-grid="true"')
    expect(html).not.toContain('data-device-card-mode="card"')
  })

  test('renders device details as a deferred dialog fragment', async () => {
    const html = await renderToString(
      <DeviceDetailsDialogContent
        state={{ view: 'list', query: '' }}
        device={{
          id: 'device_1',
          name: 'MacBook Pro With A Long Local Collector Name',
          platform: 'darwin',
          lastSyncedAt: '2026-05-29T01:27:47.279Z',
          createdAt: '2026-04-29T10:03:36.232Z',
          activeTokenCount: 1,
          installations: [
            {
              id: 'inst_1',
              deviceId: 'device_1',
              platform: 'darwin',
              hostname: 'MacBook Pro',
              clientVersion: '0.2.0',
              firstSeenAt: '2026-04-29T10:03:36.232Z',
              lastSeenAt: '2026-05-29T01:27:47.279Z',
              revokedAt: null,
              activeTokenCount: 1
            }
          ],
          uploadTokens: [
            {
              id: 'ut_1',
              deviceId: 'device_1',
              installationId: 'inst_1',
              name: 'MacBook Pro upload token',
              lastUsedAt: '2026-05-29T01:27:47.279Z',
              createdAt: '2026-04-29T10:03:36.232Z',
              revokedAt: null
            },
            {
              id: 'ut_old',
              deviceId: 'device_1',
              installationId: 'inst_1',
              name: 'MacBook Pro old credential',
              lastUsedAt: '2026-05-28T01:27:47.279Z',
              createdAt: '2026-04-29T10:03:36.232Z',
              revokedAt: '2026-05-29T01:40:00.000Z'
            }
          ]
        }}
        auditLogs={[
          {
            id: 'audit_1',
            action: 'device.reconnect',
            targetType: 'device',
            targetId: 'device_1',
            metadata: '{"installationId":"inst_1"}',
            createdAt: '2026-05-29T01:30:00.000Z'
          },
          {
            id: 'audit_2',
            action: 'token.rotate',
            targetType: 'upload_token',
            targetId: 'ut_2',
            metadata: '{"previousTokenId":"ut_1"}',
            createdAt: '2026-05-29T01:40:00.000Z'
          }
        ]}
      />
    )

    expect(html).toContain('设备详情')
    expect(html).toContain('关闭详情')
    expect(html).toContain('设备名称')
    expect(html).toContain('主要操作')
    expect(html).toContain('w-full sm:w-auto')
    expect(html).toContain('name="name"')
    expect(html).toContain('autocomplete="off"')
    expect(html).toContain('data-submit-feedback="true"')
    expect(html).toContain('data-submitting-label="正在保存..."')
    expect(html).toContain('action="/settings/install"')
    expect(html).toContain('name="targetDeviceId"')
    expect(html).toContain('data-submitting-label="正在生成..."')
    expect(html).toContain('2026-05-29 01:27 UTC')
    expect(html).toContain('安装记录 1 / 凭证记录 2')
    expect(html).toContain('凭证记录 2')
    expect(html).toContain('MacBook Pro upload token')
    expect(html).toContain('安装：inst_1')
    expect(html).toContain('name="installationId"')
    expect(html).toContain('value="revoke-installation"')
    expect(html).toContain('name="uploadTokenId"')
    expect(html).toContain('value="rotate-token"')
    expect(html).toContain('action="/settings/devices"')
    expect(html).toContain('确认换新这个上传凭证？旧凭证会立即停用，新凭证只显示一次。')
    expect(html).toContain('最近操作')
    expect(html).toContain('换新凭证')
    expect(html).toContain('2026-05-29 01:30 UTC')
  })

  test('allows revoking a non-revoked installation after its last token is revoked', async () => {
    const html = await renderToString(
      <DeviceDetailsDialogContent
        state={{ view: 'list', query: '' }}
        device={{
          id: 'device_1',
          name: 'MacBook Pro',
          platform: 'darwin',
          lastSyncedAt: '2026-05-29T01:27:47.279Z',
          createdAt: '2026-04-29T10:03:36.232Z',
          activeTokenCount: 0,
          installations: [
            {
              id: 'inst_zero',
              deviceId: 'device_1',
              platform: 'darwin',
              hostname: 'MacBook Pro',
              clientVersion: '0.2.0',
              firstSeenAt: '2026-04-29T10:03:36.232Z',
              lastSeenAt: '2026-05-29T01:27:47.279Z',
              revokedAt: null,
              activeTokenCount: 0
            }
          ],
          uploadTokens: [
            {
              id: 'ut_revoked',
              deviceId: 'device_1',
              installationId: 'inst_zero',
              name: 'Revoked upload credential',
              lastUsedAt: '2026-05-29T01:27:47.279Z',
              createdAt: '2026-04-29T10:03:36.232Z',
              revokedAt: '2026-05-29T01:40:00.000Z'
            }
          ]
        }}
        auditLogs={[]}
      />
    )
    const installationActionIndex = html.indexOf('value="revoke-installation"')
    const installationFormHtml = html.slice(installationActionIndex, html.indexOf('</form>', installationActionIndex))

    expect(installationActionIndex).toBeGreaterThanOrEqual(0)
    expect(installationFormHtml).toContain('停用安装')
    expect(installationFormHtml).not.toMatch(/\sdisabled(?:=|>|\/|\s)/)
  })

  test('formats relative timestamps with floor-based unit buckets', async () => {
    const html = await renderToString(
      <DevicesPage
        email="user@example.com"
        saved={false}
        revoked={null}
        devices={[
          {
            id: 'device_59m',
            name: 'Boundary minute',
            platform: 'linux',
            lastSyncedAt: '2026-05-29T01:00:29.000Z',
            createdAt: '2026-05-29T01:00:29.000Z',
            activeTokenCount: 0,
            installations: [],
            uploadTokens: [],
            auditLogs: []
          },
          {
            id: 'device_23h',
            name: 'Boundary hour',
            platform: 'linux',
            lastSyncedAt: '2026-05-28T02:28:29.000Z',
            createdAt: '2026-05-28T02:28:29.000Z',
            activeTokenCount: 0,
            installations: [],
            uploadTokens: [],
            auditLogs: []
          }
        ]}
      />
    )

    expect(html).toContain('59分钟前')
    expect(html).toContain('23小时前')
    expect(html).not.toContain('60分钟前')
    expect(html).not.toContain('24小时前')
  })

  test('renders the card view and keeps the search state in controls', async () => {
    const html = await renderToString(
      <DevicesPage
        email="user@example.com"
        saved={false}
        revoked={null}
        view="cards"
        query="macbook"
        devices={[
          {
            id: 'device_1',
            name: 'MacBook Pro',
            platform: 'darwin',
            lastSyncedAt: '2026-05-29T01:27:47.279Z',
            createdAt: '2026-04-29T10:03:36.232Z',
            activeTokenCount: 1,
            installations: [
              {
                id: 'inst_1',
                deviceId: 'device_1',
                platform: 'darwin',
                hostname: 'MacBook Pro',
                clientVersion: '0.2.0',
                firstSeenAt: '2026-04-29T10:03:36.232Z',
                lastSeenAt: '2026-05-29T01:27:47.279Z',
                revokedAt: null,
                activeTokenCount: 1
              }
            ],
            uploadTokens: [
              {
                id: 'ut_1',
                deviceId: 'device_1',
                installationId: 'inst_1',
                name: 'MacBook Pro upload token',
                lastUsedAt: '2026-05-29T01:27:47.279Z',
                createdAt: '2026-04-29T10:03:36.232Z',
                revokedAt: null
              }
            ],
            auditLogs: []
          }
        ]}
      />
    )

    expect(html).toContain('data-devices-card-grid="true"')
    expect(html).toContain('data-device-card-mode="card"')
    expect(html).toContain('value="macbook"')
    expect(html).toContain('name="view" value="cards"')
    expect(html).toContain('name="query" value="macbook"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('data-device-view-toggle="cards"')
    expect(html).toContain('href="/settings/devices?view=cards&amp;query=macbook"')
    expect(html).not.toContain('data-device-view-toggle="list" aria-current="page"')
  })

  test('renders the empty state when no device matches the search', async () => {
    const html = await renderToString(
      <DevicesPage email="user@example.com" saved={false} revoked={null} view="cards" query="missing" devices={[]} />
    )

    expect(html).toContain('data-devices-empty-state="true"')
    expect(html).toContain('没有匹配「missing」的设备。')
    expect(html).not.toContain('data-devices-list="true"')
    expect(html).not.toContain('data-devices-card-grid="true"')
  })

  test('renders token revoke flash separately from device and installation revoke', async () => {
    const html = await renderToString(
      <DevicesPage email="user@example.com" saved={false} revoked="token" devices={[]} />
    )

    expect(html).toContain('上传凭证已停用。')
  })

  test('renders a rotated upload token as one-time output', async () => {
    const html = await renderToString(
      <DevicesPage
        email="user@example.com"
        saved={false}
        revoked={null}
        rotatedCredentials={{
          uploadToken: 'tb_upload_new_secret',
          deviceId: 'dev_1',
          installationId: 'inst_1',
          installClaim: 'tb_install_new_secret'
        }}
        serverOrigin="https://tokenboard.example.com"
        devices={[]}
      />
    )

    expect(html).toContain('新的上传凭证只显示一次')
    expect(html).toContain('tb_upload_new_secret')
    expect(html).toContain('旧 upload token 和 install claim 已失效')
    expect(html).toContain('macOS / Linux / Git Bash')
    expect(html).toContain('Windows PowerShell')
    expect(html).toContain('data-copy-target="rotated-upload-token-text"')
    expect(html).toContain('data-copy-target="rotated-token-bash-command-text"')
    expect(html).toContain('data-copy-target="rotated-token-powershell-command-text"')
    expect(html).toContain('aria-label="复制新的 upload token"')
    expect(html).toContain('aria-label="复制 macOS / Linux / Git Bash 令牌更新命令"')
    expect(html).toContain('aria-label="复制 Windows PowerShell 令牌更新命令"')
    expect(html).toContain('rotate-token.mjs')
    expect(html).toContain('--server-origin &#39;https://tokenboard.example.com&#39;')
    expect(html).toContain('--upload-token &#39;tb_upload_new_secret&#39;')
    expect(html).toContain('--install-claim &#39;tb_install_new_secret&#39;')
    expect(html).toContain(
      'Join-Path $HOME &quot;.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\rotate-token.mjs&quot;'
    )
    expect(html).toContain('--server-origin &quot;https://tokenboard.example.com&quot;')
    expect(html).toContain('--upload-token &quot;tb_upload_new_secret&quot;')
    expect(html).toContain('--install-claim &quot;tb_install_new_secret&quot;')

    const statusRegion = html.match(/<div role="status">([\s\S]*?)<\/div>/)?.[1]
    expect(statusRegion).toContain('新的上传凭证只显示一次')
    expect(statusRegion).not.toContain('tb_upload_new_secret')
    expect(statusRegion).not.toContain('rotate-token.mjs')
  })
})
