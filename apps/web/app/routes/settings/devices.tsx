import { createRoute } from 'honox/factory'
import type { Child } from 'hono/jsx'
import { AppNav } from '../../components/app-nav'
import { Button, LinkButton } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { LucideIcon } from '../../components/ui/icon'
import { requireUser } from '../../features/auth/middleware'
import { CopyableCommandBlock } from '../../features/device/components/install-command'
import {
  listLatestDeviceAuditLogs,
  listUserDevices,
  parseDeviceNameForm,
  renameDevice,
  rotateUploadToken,
  revokeDevice,
  revokeInstallation,
  revokeUploadToken,
  type UserDeviceAuditLog,
  type UserDevice
} from '../../features/device/service'
import { requireDeviceStepUp } from '../../features/device/step-up'
import { getCanonicalPublicOrigin } from '../../features/settings/service'
import { jsonError } from '../../lib/http'
import { Info, KeyRound, LayoutGrid, List, Search, X, type IconNode } from 'lucide'
import { cn } from '../../lib/cn'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const devices = await listUserDevices(c.env.DB, user.id)
  const view = c.req.query('view') === 'cards' ? 'cards' : 'list'
  const query = c.req.query('query') ?? ''
  const auditLogsByDevice = await listLatestDeviceAuditLogs(c.env.DB, {
    userId: user.id,
    deviceIds: devices.map((device) => device.id)
  })
  const devicesWithAudit = devices.map((device) => ({
    ...device,
    auditLogs: auditLogsByDevice.get(device.id) ?? []
  }))

  return c.render(
    <DevicesPage
      devices={devicesWithAudit}
      email={user.email}
      saved={c.req.query('saved') === '1'}
      revoked={c.req.query('revoked') ?? null}
      view={view}
      query={query}
    />
  )
})

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const form = await c.req.parseBody()
    const action = String(form.action ?? '')
    const deviceId = String(form.deviceId ?? '')
    const view = normalizeDevicesView(form.view)
    const query = String(form.query ?? '')

    if (action === 'rename') {
      await renameDevice(c.env.DB, {
        userId: user.id,
        deviceId,
        name: parseDeviceNameForm(form)
      })
      return c.redirect(buildDevicesUrl({ saved: '1', view, query }), 303)
    }

    if (action === 'revoke') {
      requireDeviceStepUp(c.env, 'device.revoke')
      await revokeDevice(c.env.DB, {
        userId: user.id,
        deviceId
      })
      return c.redirect(buildDevicesUrl({ revoked: '1', view, query }), 303)
    }

    if (action === 'revoke-installation') {
      requireDeviceStepUp(c.env, 'installation.revoke')
      await revokeInstallation(c.env.DB, {
        userId: user.id,
        installationId: String(form.installationId ?? '')
      })
      return c.redirect(buildDevicesUrl({ revoked: 'installation', view, query }), 303)
    }

    if (action === 'revoke-token') {
      requireDeviceStepUp(c.env, 'token.revoke')
      await revokeUploadToken(c.env.DB, {
        userId: user.id,
        uploadTokenId: String(form.uploadTokenId ?? '')
      })
      return c.redirect(buildDevicesUrl({ revoked: 'token', view, query }), 303)
    }

    if (action === 'rotate-token') {
      requireDeviceStepUp(c.env, 'token.rotate')
      const publicOrigin = getCanonicalPublicOrigin({
        configuredOrigin: c.env.BETTER_AUTH_URL,
        requestOrigin: new URL(c.req.url).origin
      })
      const result = await rotateUploadToken(c.env.DB, {
        userId: user.id,
        uploadTokenId: String(form.uploadTokenId ?? '')
      })
      c.header('Cache-Control', 'no-store')
      return renderDevicesPage(c, user, {
        rotatedCredentials: result,
        serverOrigin: publicOrigin,
        view,
        query
      })
    }

    return c.redirect(buildDevicesUrl({ view, query }), 303)
  } catch (error) {
    return jsonError(c, error)
  }
})

export function DevicesPage(props: {
  devices: DeviceViewModel[]
  email: string
  saved: boolean
  revoked: string | null
  rotatedUploadToken?: string | null
  rotatedCredentials?: RotatedCredentials | null
  serverOrigin?: string | null
  view?: DevicesView
  query?: string
}) {
  const rotatedCredentials = props.rotatedCredentials ?? credentialsFromLegacyToken(props.rotatedUploadToken)
  const view = props.view ?? 'list'
  const query = props.query ?? ''
  const filteredDevices = filterDevices(props.devices, query)
  const summary = summarizeDevices(filteredDevices)
  const pageState: DevicesPageState = { view, query }
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>设备管理 - TokenBoard</title>
      <AppNav active="devices" email={props.email} />

      <section class="mx-auto flex max-w-6xl flex-col gap-5">
        <DevicesHeader />
        <DevicePageFlash saved={props.saved} revoked={props.revoked} />
        <RotatedTokenFlash credentials={rotatedCredentials} serverOrigin={props.serverOrigin ?? null} />
        <DevicesOverview summary={summary} visible={filteredDevices.length} total={props.devices.length} />
        <DevicesToolbar view={view} query={query} total={props.devices.length} visible={filteredDevices.length} />
        {filteredDevices.length === 0 ? (
          <DevicesEmptyState query={query} />
        ) : view === 'list' ? (
          <DevicesList devices={filteredDevices} state={pageState} />
        ) : (
          <DevicesCardGrid devices={filteredDevices} state={pageState} />
        )}
      </section>
      <DeviceDetailsDialogShell />
    </main>
  )
}

type DevicesRenderContext = {
  env: {
    DB: D1Database
  }
  render: (element: ReturnType<typeof DevicesPage>) => Response | Promise<Response>
}

async function renderDevicesPage(
  c: DevicesRenderContext,
  user: { id: string; email: string },
  options: {
    rotatedCredentials?: RotatedCredentials
    serverOrigin?: string
    view?: DevicesView
    query?: string
  } = {}
) {
  const devices = await listUserDevices(c.env.DB, user.id)
  const auditLogsByDevice = await listLatestDeviceAuditLogs(c.env.DB, {
    userId: user.id,
    deviceIds: devices.map((device) => device.id)
  })
  const devicesWithAudit = devices.map((device) => ({
    ...device,
    auditLogs: auditLogsByDevice.get(device.id) ?? []
  }))
  return c.render(
    <DevicesPage
      devices={devicesWithAudit}
      email={user.email}
      saved={false}
      revoked={null}
      rotatedCredentials={options.rotatedCredentials}
      serverOrigin={options.serverOrigin}
      view={options.view}
      query={options.query}
    />
  )
}

export type DeviceViewModel = UserDevice & {
  auditLogs?: UserDeviceAuditLog[]
}

export type DevicesView = 'list' | 'cards'

type RotatedCredentials = {
  uploadToken: string
  deviceId?: string | null
  installationId?: string | null
  installClaim?: string | null
}

function credentialsFromLegacyToken(uploadToken?: string | null): RotatedCredentials | null {
  if (!uploadToken) return null
  return { uploadToken }
}

function DevicesHeader() {
  return (
    <header class="app-surface-raised rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
      <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div class="max-w-2xl">
          <p class="app-accent-text text-sm font-black uppercase tracking-[0.24em]">Devices</p>
          <h1 class="mt-3 text-3xl font-black tracking-tight text-balance sm:text-4xl">设备管理</h1>
          <p class="mt-2 text-sm leading-6 text-pretty text-[var(--app-muted)]">
            查看设备、同步、安装和上传凭证。列表看全局，卡片逐台处理。
          </p>
        </div>
        <LinkButton class="w-full md:w-auto" href="/settings/install">
          连接新设备
        </LinkButton>
      </div>
    </header>
  )
}

type DevicesSummary = ReturnType<typeof summarizeDevices>

function DevicesOverview(props: { summary: DevicesSummary; visible: number; total: number }) {
  return (
    <section
      class="app-surface-subtle grid gap-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4"
      data-devices-overview="true"
    >
      <div class="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="app-accent-text text-xs font-black uppercase tracking-[0.24em]">Overview</p>
          <h2 class="mt-2 text-xl font-black tracking-tight">设备概览</h2>
        </div>
        <p class="text-xs font-bold text-[var(--app-muted)]">
          显示 {props.visible} / {props.total}
        </p>
      </div>
      <dl class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryStat label="设备" value={String(props.summary.deviceCount)} hint="已连接" />
        <SummaryStat label="安装记录" value={String(props.summary.installationCount)} hint="已登记安装" />
        <SummaryStat label="可用凭证" value={String(props.summary.activeTokenCount)} hint="当前可用" />
        <SummaryStat label="72h 未同步" value={String(props.summary.staleDeviceCount)} hint="超过 72 小时" />
      </dl>
    </section>
  )
}

function SummaryStat(props: { label: string; value: string; hint: string }) {
  return (
    <div class="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3">
      <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">{props.label}</p>
      <p class="mt-2 text-2xl font-black tabular-nums text-[var(--app-text)]">{props.value}</p>
      <p class="mt-1 text-xs font-bold leading-5 text-[var(--app-muted)]">{props.hint}</p>
    </div>
  )
}

function DevicePageFlash(props: { saved: boolean; revoked: string | null }) {
  return (
    <>
      {props.saved ? <p class="app-flash-success p-3 text-sm">设备名称已更新。</p> : null}
      {props.revoked ? <p class="app-flash-success p-3 text-sm">{formatRevokeFlash(props.revoked)}</p> : null}
    </>
  )
}

function formatRevokeFlash(revoked: string) {
  const messages: Record<string, string> = {
    installation: '安装实例已停用。',
    token: '上传凭证已停用。'
  }
  return messages[revoked] ?? '设备上传凭证已停用。'
}

function DevicesToolbar(props: { view: 'list' | 'cards'; query: string; total: number; visible: number }) {
  const listActive = props.view === 'list'
  const cardsActive = props.view === 'cards'
  return (
    <section class="app-surface-subtle flex flex-col gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 lg:flex-row lg:items-center lg:justify-between">
      <form method="get" class="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
        <label class="flex min-h-11 flex-1 items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm text-[var(--app-text)]">
          <LucideIcon icon={Search} class="text-[var(--app-muted)]" size={16} />
          <input
            type="search"
            name="query"
            value={props.query}
            aria-label="搜索设备"
            placeholder="搜设备名、平台、安装或凭证"
            class="w-full bg-transparent outline-none placeholder:text-[var(--app-subtle)]"
          />
        </label>
        <input type="hidden" name="view" value={props.view} />
        <Button class="w-full sm:w-auto" type="submit" variant="secondary" size="sm">
          搜索
        </Button>
      </form>
      <div class="flex flex-wrap items-center gap-2 lg:justify-end">
        <span class="tabular-nums text-xs font-bold text-[var(--app-muted)]">
          {props.visible} / {props.total}
        </span>
        <ViewToggleButton active={listActive} view="list" label="列表" icon={List} query={props.query} />
        <ViewToggleButton active={cardsActive} view="cards" label="卡片" icon={LayoutGrid} query={props.query} />
      </div>
    </section>
  )
}

function ViewToggleButton(props: {
  active: boolean
  view: 'list' | 'cards'
  label: string
  icon: IconNode
  query: string
}) {
  return (
    <a
      data-device-view-toggle={props.view}
      href={buildViewHref(props.view, props.query)}
      class={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 py-3 text-sm font-black transition ${
        props.active
          ? 'border-lime-300 bg-lime-300 text-stone-950'
          : 'border-[var(--app-border)] bg-[var(--app-panel-strong)] text-[var(--app-text)] hover:border-lime-300'
      }`}
      aria-current={props.active ? 'page' : undefined}
    >
      <LucideIcon icon={props.icon} size={16} />
      <span>{props.label}</span>
    </a>
  )
}

function buildViewHref(view: 'list' | 'cards', query: string) {
  const params = new URLSearchParams()
  params.set('view', view)
  if (query.trim()) {
    params.set('query', query.trim())
  }
  return `/settings/devices?${params.toString()}`
}

function buildDevicesUrl(options: { saved?: string; revoked?: string; view: DevicesView; query: string }) {
  const params = new URLSearchParams()
  if (options.saved) {
    params.set('saved', options.saved)
  }
  if (options.revoked) {
    params.set('revoked', options.revoked)
  }
  params.set('view', options.view)
  if (options.query.trim()) {
    params.set('query', options.query.trim())
  }
  return `/settings/devices?${params.toString()}`
}

function normalizeDevicesView(value: FormDataEntryValue | null | undefined): DevicesView {
  return value === 'cards' ? 'cards' : 'list'
}

function RotatedTokenFlash(props: { credentials: RotatedCredentials | null; serverOrigin: string | null }) {
  if (!props.credentials) return null
  const deviceLinkCommands = buildRotatedTokenUpdateCommands(props.credentials, props.serverOrigin)
  return (
    <section class="app-flash-success grid gap-4 p-4 text-sm sm:p-5">
      <div role="status">
        <header class="flex items-start gap-3">
          <span class="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-lime-700/20 bg-lime-300/30 text-lime-950">
            <LucideIcon icon={KeyRound} size={18} />
          </span>
          <div class="min-w-0">
            <p class="font-black text-[var(--app-text)]">新的上传凭证只显示一次</p>
            <p class="mt-1 text-xs leading-5 text-[var(--app-muted)]">
              立即复制并更新对应 client。轮换后旧 upload token 和 install claim 已失效。
            </p>
          </div>
        </header>
      </div>
      <div class="grid min-w-0 gap-3">
        <CopyableCommandBlock
          title="Upload token"
          command={props.credentials.uploadToken}
          targetId="rotated-upload-token-text"
          copyLabel="复制新的 upload token"
        />
        {deviceLinkCommands ? (
          <>
            <CopyableCommandBlock
              title="macOS / Linux / Git Bash"
              command={deviceLinkCommands.bash}
              targetId="rotated-token-bash-command-text"
              copyLabel="复制 macOS / Linux / Git Bash 令牌更新命令"
            />
            <CopyableCommandBlock
              title="Windows PowerShell"
              command={deviceLinkCommands.powerShell}
              targetId="rotated-token-powershell-command-text"
              copyLabel="复制 Windows PowerShell 令牌更新命令"
            />
          </>
        ) : null}
      </div>
      {deviceLinkCommands ? (
        <p class="text-xs leading-5 text-[var(--app-muted)]">
          在对应 client 机器执行其中一条命令，以同时更新 config 和 device-link 恢复状态。
        </p>
      ) : null}
    </section>
  )
}

function buildRotatedTokenUpdateCommands(credentials: RotatedCredentials, serverOrigin: string | null) {
  if (!serverOrigin || !credentials.deviceId || !credentials.installationId || !credentials.installClaim) {
    return null
  }
  const commandInput = {
    uploadToken: credentials.uploadToken,
    deviceId: credentials.deviceId,
    installationId: credentials.installationId,
    installClaim: credentials.installClaim
  }
  return {
    bash: buildBashRotatedTokenCommand(commandInput, serverOrigin),
    powerShell: buildPowerShellRotatedTokenCommand(commandInput, serverOrigin)
  }
}

type RotatedTokenCommandInput = {
  uploadToken: string
  deviceId: string
  installationId: string
  installClaim: string
}

function buildBashRotatedTokenCommand(credentials: RotatedTokenCommandInput, serverOrigin: string) {
  return [
    'node ~/.tokenboard/TokenBoard/skills/tokenboard/scripts/rotate-token.mjs',
    `--server-origin ${shellQuote(serverOrigin)}`,
    `--upload-token ${shellQuote(credentials.uploadToken)}`,
    `--device-id ${shellQuote(credentials.deviceId)}`,
    `--installation-id ${shellQuote(credentials.installationId)}`,
    `--install-claim ${shellQuote(credentials.installClaim)}`
  ].join(' ')
}

function buildPowerShellRotatedTokenCommand(credentials: RotatedTokenCommandInput, serverOrigin: string) {
  return [
    'node (Join-Path $HOME ".tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\rotate-token.mjs")',
    `--server-origin ${powerShellQuote(serverOrigin)}`,
    `--upload-token ${powerShellQuote(credentials.uploadToken)}`,
    `--device-id ${powerShellQuote(credentials.deviceId)}`,
    `--installation-id ${powerShellQuote(credentials.installationId)}`,
    `--install-claim ${powerShellQuote(credentials.installClaim)}`
  ].join(' ')
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function powerShellQuote(value: string) {
  return `"${value.replaceAll('`', '``').replaceAll('"', '`"').replaceAll('$', '`$')}"`
}

function DevicesCardGrid(props: { devices: DeviceViewModel[]; state: DevicesPageState }) {
  return (
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-devices-card-grid="true">
      {props.devices.map((device) => (
        <DeviceCard device={device} mode="card" state={props.state} />
      ))}
    </div>
  )
}

function DevicesList(props: { devices: DeviceViewModel[]; state: DevicesPageState }) {
  return (
    <Card class="overflow-hidden">
      <CardHeader class="p-4 pb-3">
        <CardTitle>已连接设备</CardTitle>
        <CardDescription>停用设备只会阻止后续上传，历史用量会继续保留。</CardDescription>
      </CardHeader>
      <CardContent class="p-4 pt-0">
        {props.devices.length > 0 ? (
          <div class="overflow-hidden rounded-xl border border-[var(--app-border)]" data-devices-list="true">
            <div class="app-device-list-grid bg-[var(--app-bg-soft)] px-4 py-2 text-xs font-black text-[var(--app-muted)]">
              <span>设备</span>
              <span>最近同步</span>
              <span>安装 / 可用凭证</span>
              <span>最近操作</span>
              <span class="text-right">详情</span>
            </div>
            {props.devices.map((device) => (
              <DeviceCard device={device} mode="list" state={props.state} />
            ))}
          </div>
        ) : (
          <DevicesEmptyState query={props.state.query} />
        )}
      </CardContent>
    </Card>
  )
}

function DeviceCard(props: { device: DeviceViewModel; mode: 'list' | 'card'; state: DevicesPageState }) {
  if (props.mode === 'card') {
    return <DeviceCompactCard device={props.device} state={props.state} />
  }

  return <DeviceListRow device={props.device} state={props.state} />
}

function DeviceListRow(props: { device: DeviceViewModel; state: DevicesPageState }) {
  const auditLogs = props.device.auditLogs ?? []
  const dialogId = buildDeviceDetailsDialogId(props.device.id)
  return (
    <article
      class="overflow-hidden border-t border-[var(--app-border)] bg-[var(--app-panel)] first:border-t-0"
      data-device-card={props.device.id}
      data-device-card-mode="list"
      data-device-list-row="true"
    >
      <DeviceListSummary device={props.device} auditLogs={auditLogs} dialogId={dialogId} state={props.state} />
    </article>
  )
}

function buildDeviceDetailsDialogId(_deviceId: string) {
  return 'device-details-dialog'
}

function buildDeviceDetailsHref(deviceId: string, state: DevicesPageState) {
  const params = new URLSearchParams()
  params.set('deviceId', deviceId)
  params.set('view', state.view)
  if (state.query.trim()) {
    params.set('query', state.query.trim())
  }
  return `/settings/devices/details?${params.toString()}`
}

function DeviceListSummary(props: {
  device: DeviceViewModel
  auditLogs: UserDeviceAuditLog[]
  dialogId: string
  state: DevicesPageState
}) {
  const lastSyncedAt = formatDeviceTimestamp(props.device.lastSyncedAt, '从未同步')
  const createdAt = formatDeviceTimestamp(props.device.createdAt)
  const recentAudit = props.auditLogs[0] ?? null
  const recentAuditAt = recentAudit ? formatDeviceTimestamp(recentAudit.createdAt) : null
  return (
    <>
      <DeviceListMobileSummary
        device={props.device}
        lastSyncedAt={lastSyncedAt}
        dialogId={props.dialogId}
        state={props.state}
      />
      <div class="app-device-list-grid gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--app-hover)]">
        <DeviceListIdentity device={props.device} />
        <DeviceListTime label="最近同步" value={lastSyncedAt} />
        <DeviceListCounts device={props.device} createdAt={createdAt} />
        <DeviceListRecentAction device={props.device} recentAudit={recentAudit} recentAuditAt={recentAuditAt} />
        <DeviceListDetailsButton dialogId={props.dialogId} deviceId={props.device.id} state={props.state} />
      </div>
    </>
  )
}

function DeviceListMobileSummary(props: {
  device: UserDevice
  lastSyncedAt: ReturnType<typeof formatDeviceTimestamp>
  dialogId: string
  state: DevicesPageState
}) {
  return (
    <div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--app-hover)] md:hidden">
      <div class="min-w-0">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <p class="min-w-0 truncate text-sm font-black text-[var(--app-text)]">{props.device.name}</p>
          <DeviceStatus device={props.device} />
        </div>
        <p class="mt-1 truncate text-xs font-bold text-[var(--app-muted)]">
          {formatPlatformLabel(props.device.platform)} / 同步 {props.lastSyncedAt.primary}
        </p>
        <p class="mt-1 text-xs font-bold tabular-nums text-[var(--app-muted)]">
          安装记录 {props.device.installations.length} / 可用凭证 {props.device.activeTokenCount}
        </p>
      </div>
      <DeviceListDetailsButton dialogId={props.dialogId} deviceId={props.device.id} state={props.state} />
    </div>
  )
}

function DeviceListIdentity(props: { device: UserDevice }) {
  return (
    <div class="min-w-0">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <p class="min-w-0 truncate text-sm font-black text-[var(--app-text)]">{props.device.name}</p>
        <DeviceStatus device={props.device} />
      </div>
      <p class="mt-1 hidden truncate text-xs font-bold text-[var(--app-muted)] md:block">
        {formatPlatformLabel(props.device.platform)} / 安装记录 {props.device.installations.length} / 可用凭证{' '}
        {props.device.activeTokenCount}
      </p>
    </div>
  )
}

function DeviceListTime(props: { label: string; value: ReturnType<typeof formatDeviceTimestamp> }) {
  return (
    <div class="min-w-0">
      <p class="sr-only">{props.label}</p>
      <p class="text-sm font-black text-[var(--app-text)]">{props.value.primary}</p>
    </div>
  )
}

function DeviceListCounts(props: { device: UserDevice; createdAt: ReturnType<typeof formatDeviceTimestamp> }) {
  return (
    <div class="min-w-0">
      <p class="sr-only">安装 / 可用凭证</p>
      <p class="text-sm font-black tabular-nums text-[var(--app-text)]">
        {props.device.installations.length} / {props.device.activeTokenCount}
      </p>
      <p class="sr-only">创建 {props.createdAt.primary}</p>
    </div>
  )
}

function DeviceListRecentAction(props: {
  device: UserDevice
  recentAudit: UserDeviceAuditLog | null
  recentAuditAt: ReturnType<typeof formatDeviceTimestamp> | null
}) {
  return (
    <div class="hidden min-w-0 md:block">
      <p class="sr-only">最近操作</p>
      <p class="truncate text-sm font-black text-[var(--app-text)]">
        {props.recentAudit ? formatAuditAction(props.recentAudit.action) : '无'}
      </p>
      <p class="mt-0.5 text-xs text-[var(--app-muted)]">
        {props.recentAuditAt ? props.recentAuditAt.primary : `可用凭证 ${props.device.activeTokenCount}`}
      </p>
    </div>
  )
}

function DeviceListDetailsButton(props: { dialogId: string; deviceId: string; state: DevicesPageState }) {
  return (
    <div class="flex items-center justify-start md:justify-end">
      <a
        href={buildDeviceDetailsHref(props.deviceId, props.state)}
        class="inline-flex min-h-9 min-w-16 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[var(--app-border)] bg-[var(--app-bg-soft)] px-3 py-2 text-xs font-black text-[var(--app-text)] transition hover:border-lime-300 hover:bg-[var(--app-hover)]"
        data-device-details-open={props.dialogId}
        aria-haspopup="dialog"
        aria-controls={props.dialogId}
      >
        <LucideIcon icon={Info} size={15} />
        <span>详情</span>
      </a>
    </div>
  )
}

function DeviceDetailsDialogShell() {
  return (
    <dialog id="device-details-dialog" class="app-device-dialog" data-device-details-dialog="true" aria-live="polite" />
  )
}

export function DeviceDetailsDialogContent(props: {
  device: DeviceViewModel
  auditLogs: UserDeviceAuditLog[]
  state: DevicesPageState
  showCloseButton?: boolean
}) {
  const titleId = 'device-details-dialog-title'
  const showCloseButton = props.showCloseButton ?? true
  return (
    <>
      <header class="flex items-start justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-panel)] p-4">
        <div class="min-w-0">
          <p id={titleId} class="text-base font-black text-[var(--app-text)]">
            设备详情
          </p>
          <p class="mt-1 truncate text-sm font-bold text-[var(--app-muted)]">{props.device.name}</p>
          <p class="mt-1 text-xs font-bold text-[var(--app-subtle)]">
            {formatPlatformLabel(props.device.platform)} / 安装记录 {props.device.installations.length} / 凭证记录{' '}
            {props.device.uploadTokens.length}
          </p>
        </div>
        {showCloseButton ? (
          <button
            type="button"
            class="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg-soft)] text-[var(--app-muted)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]"
            data-device-details-close="true"
            aria-label="关闭详情"
          >
            <LucideIcon icon={X} size={17} />
          </button>
        ) : (
          <LinkButton
            class="shrink-0"
            variant="secondary"
            size="sm"
            href={buildViewHref(props.state.view, props.state.query)}
          >
            返回列表
          </LinkButton>
        )}
      </header>
      <DeviceListDetails device={props.device} auditLogs={props.auditLogs} state={props.state} />
    </>
  )
}

export function DeviceDetailsPage(props: {
  email: string
  device: DeviceViewModel
  auditLogs: UserDeviceAuditLog[]
  state: DevicesPageState
}) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>设备详情 - TokenBoard</title>
      <AppNav active="devices" email={props.email} />

      <section class="mx-auto flex max-w-6xl flex-col gap-5">
        <DeviceDetailsSurface>
          <DeviceDetailsDialogContent
            device={props.device}
            auditLogs={props.auditLogs}
            state={props.state}
            showCloseButton={false}
          />
        </DeviceDetailsSurface>
      </section>
    </main>
  )
}

function DeviceDetailsSurface(props: { children: Child }) {
  return (
    <article class="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)]">
      {props.children}
    </article>
  )
}

function DeviceListDetails(props: {
  device: DeviceViewModel
  auditLogs: UserDeviceAuditLog[]
  state: DevicesPageState
}) {
  return (
    <div class="app-device-dialog-body grid content-start gap-3 bg-[var(--app-bg-soft)] p-3 sm:p-4">
      <DeviceDetailControlPanel device={props.device} state={props.state} />
      <DeviceCredentialDensePanel device={props.device} state={props.state} />
      {props.auditLogs.length > 0 ? <DeviceAuditTrailDense auditLogs={props.auditLogs} /> : null}
    </div>
  )
}

function DeviceDetailControlPanel(props: { device: DeviceViewModel; state: DevicesPageState }) {
  return (
    <section class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
      <div class="grid gap-3 xl:grid-cols-[minmax(0,1fr)_18rem] xl:items-end">
        <div class="min-w-0">
          <p class="mb-2 text-xs font-black text-[var(--app-muted)]">设备名称</p>
          <DeviceRenameForm device={props.device} state={props.state} />
        </div>
        <div class="min-w-0">
          <div class="mb-2 flex items-center justify-between gap-3">
            <p class="text-xs font-black text-[var(--app-muted)]">主要操作</p>
            <span class="text-xs font-bold tabular-nums text-[var(--app-subtle)]">2 项</span>
          </div>
          <DeviceActionForms device={props.device} state={props.state} compact inline />
        </div>
      </div>
    </section>
  )
}

function DeviceCredentialDensePanel(props: { device: UserDevice; state: DevicesPageState }) {
  return (
    <section class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-2">
      <div class="grid gap-3 lg:grid-cols-2">
        <DeviceInstallationsDense device={props.device} state={props.state} />
        <DeviceUploadTokensDense device={props.device} state={props.state} />
      </div>
    </section>
  )
}

function DeviceCompactCard(props: { device: DeviceViewModel; state: DevicesPageState }) {
  const auditLogs = props.device.auditLogs ?? []
  const lastSyncedAt = formatDeviceTimestamp(props.device.lastSyncedAt, '从未同步')
  const createdAt = formatDeviceTimestamp(props.device.createdAt)
  return (
    <article
      class="app-surface-subtle w-full rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 sm:p-4"
      data-device-card={props.device.id}
      data-device-card-mode="card"
    >
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full border border-[var(--app-border)] bg-[var(--app-bg-soft)] px-3 py-1 text-xs font-bold text-[var(--app-muted)]">
            {formatPlatformLabel(props.device.platform)}
          </span>
          <DeviceStatus device={props.device} />
        </div>

        <DeviceRenameForm device={props.device} state={props.state} />

        <dl class="grid gap-2 sm:grid-cols-2">
          <DeviceTimeMeta label="上次同步" value={lastSyncedAt} />
          <DeviceTimeMeta label="创建时间" value={createdAt} />
        </dl>

        <details class="app-surface-subtle rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3">
          <summary class="flex items-center justify-between gap-3 text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">
            <span>操作</span>
            <span class="tabular-nums">2</span>
          </summary>
          <div class="mt-3">
            <DeviceActionForms device={props.device} state={props.state} compact />
          </div>
        </details>

        <details class="app-surface-subtle rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3">
          <summary class="flex items-center justify-between gap-3 text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">
            <span>安装与凭证</span>
            <span class="tabular-nums">{props.device.installations.length + props.device.uploadTokens.length}</span>
          </summary>
          <div class="mt-3 grid gap-3">
            <DeviceInstallations device={props.device} state={props.state} compact />
            <DeviceUploadTokens device={props.device} state={props.state} compact />
          </div>
        </details>

        {auditLogs.length > 0 ? (
          <details class="app-surface-subtle rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3">
            <summary class="flex items-center justify-between gap-3 text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">
              <span>最近操作</span>
              <span class="tabular-nums">{auditLogs.length}</span>
            </summary>
            <div class="mt-3">
              <DeviceAuditTrail auditLogs={auditLogs.slice(0, 3)} compact />
            </div>
          </details>
        ) : null}
      </div>
    </article>
  )
}

function DeviceTimeMeta(props: { label: string; value: ReturnType<typeof formatDeviceTimestamp> }) {
  return (
    <div class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
      <dt class="text-xs font-black uppercase tracking-wide text-[var(--app-muted)]">{props.label}</dt>
      <dd class="mt-1 grid gap-0.5">
        <span class="block text-lg font-black leading-6 text-[var(--app-text)]">{props.value.primary}</span>
        {props.value.secondary ? (
          <span class="block text-xs font-bold leading-5 text-[var(--app-muted)]">{props.value.secondary}</span>
        ) : null}
      </dd>
    </div>
  )
}

function DeviceInstallationsDense(props: { device: UserDevice; state: DevicesPageState }) {
  return (
    <DenseSection title="安装记录" count={props.device.installations.length}>
      {props.device.installations.length === 0 ? (
        <DenseEmpty>暂无安装</DenseEmpty>
      ) : (
        props.device.installations.map((installation) => (
          <InstallationDenseRow installation={installation} state={props.state} />
        ))
      )}
    </DenseSection>
  )
}

function InstallationDenseRow(props: { installation: UserDevice['installations'][number]; state: DevicesPageState }) {
  const lastSeenAt = formatDeviceTimestamp(props.installation.lastSeenAt, '从未同步')
  return (
    <div class="grid gap-2 border-t border-[var(--app-border)] px-2 py-2.5 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div class="min-w-0">
        <p class="truncate text-sm font-black leading-5 text-[var(--app-text)]">
          {props.installation.hostname ?? formatPlatformLabel(props.installation.platform)}
        </p>
        <p class="mt-0.5 truncate text-xs font-bold text-[var(--app-muted)]">
          {formatPlatformLabel(props.installation.platform)} / {props.installation.clientVersion ?? '版本未知'}
        </p>
        <p class="mt-1 text-xs text-[var(--app-muted)]">
          {lastSeenAt.primary}
          {lastSeenAt.secondary ? <span class="text-[var(--app-subtle)]"> / {lastSeenAt.secondary}</span> : null}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2 sm:justify-end">
        <span class="rounded-full border border-[var(--app-border)] bg-[var(--app-bg-soft)] px-2 py-1 text-xs font-bold tabular-nums text-[var(--app-muted)]">
          可用凭证 {props.installation.activeTokenCount}
        </span>
        <InstallationRevokeForm installation={props.installation} state={props.state} />
      </div>
    </div>
  )
}

function DeviceUploadTokensDense(props: { device: UserDevice; state: DevicesPageState }) {
  return (
    <DenseSection title="凭证记录" count={props.device.uploadTokens.length}>
      {props.device.uploadTokens.length === 0 ? (
        <DenseEmpty>暂无上传凭证</DenseEmpty>
      ) : (
        props.device.uploadTokens.map((token) => <UploadTokenDenseRow token={token} state={props.state} />)
      )}
    </DenseSection>
  )
}

function UploadTokenDenseRow(props: { token: UserDevice['uploadTokens'][number]; state: DevicesPageState }) {
  const lastUsedAt = formatDeviceTimestamp(props.token.lastUsedAt, '从未使用')
  const installationLabel = props.token.installationId ? `安装：${props.token.installationId}` : '未绑定安装'
  return (
    <div class="grid gap-2 border-t border-[var(--app-border)] px-2 py-2.5 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div class="min-w-0">
        <p class="truncate text-sm font-black leading-5 text-[var(--app-text)]">{props.token.name}</p>
        <p class="mt-0.5 truncate text-xs font-bold text-[var(--app-muted)]" title={installationLabel}>
          {installationLabel}
        </p>
        <p class="mt-1 text-xs text-[var(--app-muted)]">
          {lastUsedAt.primary}
          {lastUsedAt.secondary ? <span class="text-[var(--app-subtle)]"> / {lastUsedAt.secondary}</span> : null}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2 sm:justify-end">
        <UploadTokenRotateForm token={props.token} state={props.state} />
        <UploadTokenRevokeForm token={props.token} state={props.state} />
      </div>
    </div>
  )
}

function DeviceAuditTrailDense(props: { auditLogs: UserDeviceAuditLog[] }) {
  return (
    <DenseSection title="最近操作" count={props.auditLogs.length}>
      <div class="grid gap-1.5">
        {props.auditLogs.map((log) => {
          const createdAt = formatDeviceTimestamp(log.createdAt)
          return (
            <p class="break-words text-xs text-[var(--app-muted)]">
              <span class="font-bold text-[var(--app-text)]">{formatAuditAction(log.action)}</span>
              <span> / {createdAt.primary}</span>
              {createdAt.secondary ? <span> / {createdAt.secondary}</span> : null}
            </p>
          )
        })}
      </div>
    </DenseSection>
  )
}

function DenseSection(props: { title: string; count: number; children: Child }) {
  return (
    <section class="min-w-0 rounded-lg bg-[var(--app-bg-soft)] p-2">
      <div class="flex items-center justify-between gap-3 px-2 pb-1.5">
        <p class="text-xs font-black text-[var(--app-muted)]">{props.title}</p>
        <span class="text-xs font-bold tabular-nums text-[var(--app-muted)]">{props.count}</span>
      </div>
      {props.children}
    </section>
  )
}

function DenseEmpty(props: { children: string }) {
  return (
    <div class="rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-3 text-xs font-bold text-[var(--app-muted)]">
      {props.children}
    </div>
  )
}

function DeviceUploadTokens(props: { device: UserDevice; state: DevicesPageState; compact?: boolean }) {
  if (props.device.uploadTokens.length === 0) {
    return (
      <div class="grid gap-2">
        {props.compact ? null : (
          <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">凭证记录</p>
        )}
        <div class="rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-3 text-xs font-bold text-[var(--app-muted)]">
          暂无上传凭证
        </div>
      </div>
    )
  }

  if (props.compact) {
    return (
      <section class="grid gap-2">
        {props.device.uploadTokens.map((token) => {
          const lastUsedAt = formatDeviceTimestamp(token.lastUsedAt, '从未使用')
          return (
            <div class="grid gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 text-sm">
                  <p class="truncate font-black text-[var(--app-text)]">{token.name}</p>
                  <p class="mt-1 break-words text-xs font-bold text-[var(--app-muted)]">
                    {token.installationId ? `安装：${token.installationId}` : '未绑定安装'}
                  </p>
                  <p class="mt-1 text-xs text-[var(--app-muted)]">上次使用：{lastUsedAt.primary}</p>
                  {lastUsedAt.secondary ? (
                    <p class="mt-1 text-xs text-[var(--app-subtle)]">{lastUsedAt.secondary}</p>
                  ) : null}
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <UploadTokenRotateForm token={token} state={props.state} />
                <UploadTokenRevokeForm token={token} state={props.state} />
              </div>
            </div>
          )
        })}
      </section>
    )
  }

  return (
    <section class="grid gap-2">
      {props.compact ? null : (
        <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">凭证记录</p>
      )}
      {props.device.uploadTokens.map((token) => {
        const lastUsedAt = formatDeviceTimestamp(token.lastUsedAt, '从未使用')
        return (
          <div class="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3">
            <div class="flex flex-col gap-3">
              <div class="min-w-0 text-sm">
                <p class="truncate font-black text-[var(--app-text)]">{token.name}</p>
                <p class="mt-1 break-words text-xs font-bold text-[var(--app-muted)]">
                  {token.installationId ? `安装：${token.installationId}` : '未绑定安装'}
                </p>
                <p class="mt-1 text-xs text-[var(--app-muted)]">上次使用：{lastUsedAt.primary}</p>
                {lastUsedAt.secondary ? (
                  <p class="mt-1 text-xs text-[var(--app-subtle)]">{lastUsedAt.secondary}</p>
                ) : null}
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <UploadTokenRotateForm token={token} state={props.state} />
                <UploadTokenRevokeForm token={token} state={props.state} />
              </div>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function UploadTokenRotateForm(props: { token: UserDevice['uploadTokens'][number]; state: DevicesPageState }) {
  const disabled = props.token.revokedAt !== null
  return (
    <form method="post" action="/settings/devices" data-submit-feedback="true">
      <input type="hidden" name="action" value="rotate-token" />
      <input type="hidden" name="uploadTokenId" value={props.token.id} />
      <input type="hidden" name="view" value={props.state.view} />
      <input type="hidden" name="query" value={props.state.query} />
      <Button
        class="w-full px-2 sm:w-auto"
        type="submit"
        variant="secondary"
        size="sm"
        disabled={disabled}
        data-confirm="确认换新这个上传凭证？旧凭证会立即停用，新凭证只显示一次。"
        data-submitting-label="正在换新..."
      >
        换新凭证
      </Button>
    </form>
  )
}

function UploadTokenRevokeForm(props: { token: UserDevice['uploadTokens'][number]; state: DevicesPageState }) {
  const disabled = props.token.revokedAt !== null
  return (
    <form method="post" action="/settings/devices" data-submit-feedback="true">
      <input type="hidden" name="action" value="revoke-token" />
      <input type="hidden" name="uploadTokenId" value={props.token.id} />
      <input type="hidden" name="view" value={props.state.view} />
      <input type="hidden" name="query" value={props.state.query} />
      <Button
        class="w-full px-2 sm:w-auto"
        type="submit"
        variant="secondary"
        size="sm"
        disabled={disabled}
        data-confirm="确认只停用这个上传凭证？"
        data-submitting-label="正在停用..."
      >
        停用
      </Button>
    </form>
  )
}

function DeviceRenameForm(props: { device: UserDevice; state: DevicesPageState }) {
  return (
    <form
      method="post"
      action="/settings/devices"
      class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      data-submit-feedback="true"
    >
      <input type="hidden" name="action" value="rename" />
      <input type="hidden" name="deviceId" value={props.device.id} />
      <input type="hidden" name="view" value={props.state.view} />
      <input type="hidden" name="query" value={props.state.query} />
      <Input class="mt-0 h-11 py-2" name="name" value={props.device.name} autocomplete="off" required minLength={1} />
      <Button class="w-full sm:w-auto" type="submit" variant="secondary" size="sm" data-submitting-label="正在保存...">
        保存
      </Button>
    </form>
  )
}

function DeviceActionForms(props: {
  device: UserDevice
  state: DevicesPageState
  compact?: boolean
  inline?: boolean
}) {
  if (props.compact) {
    return (
      <div class={cn('grid gap-2', props.inline ? 'sm:grid-cols-2 xl:grid-cols-2' : '')}>
        <DeviceReconnectForm device={props.device} compact />
        <DeviceRevokeForm device={props.device} state={props.state} compact />
      </div>
    )
  }
  return (
    <div class="flex flex-col gap-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3">
      <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">操作</p>
      <DeviceReconnectForm device={props.device} />
      <DeviceRevokeForm device={props.device} state={props.state} />
    </div>
  )
}

function DeviceReconnectForm(props: { device: UserDevice; compact?: boolean }) {
  return (
    <form method="post" action="/settings/install" data-submit-feedback="true">
      <input type="hidden" name="targetDeviceId" value={props.device.id} />
      <Button
        class={cn('w-full', props.compact ? 'h-10' : '')}
        type="submit"
        variant="secondary"
        size="sm"
        data-submitting-label="正在生成..."
      >
        重连
      </Button>
    </form>
  )
}

function DeviceRevokeForm(props: { device: UserDevice; state: DevicesPageState; compact?: boolean }) {
  return (
    <form method="post" action="/settings/devices" data-submit-feedback="true">
      <input type="hidden" name="action" value="revoke" />
      <input type="hidden" name="deviceId" value={props.device.id} />
      <input type="hidden" name="view" value={props.state.view} />
      <input type="hidden" name="query" value={props.state.query} />
      <Button
        class={cn('w-full', props.compact ? 'h-10' : '')}
        type="submit"
        variant="destructive"
        size="sm"
        disabled={props.device.activeTokenCount <= 0}
        data-confirm="确认停用这个设备的上传凭证？"
        data-submitting-label="正在停用..."
        data-submitting-tone="danger"
      >
        停用设备
      </Button>
    </form>
  )
}

function DeviceInstallations(props: { device: UserDevice; state: DevicesPageState; compact?: boolean }) {
  if (props.device.installations.length === 0) {
    return (
      <div class="grid gap-2">
        {props.compact ? null : (
          <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">安装记录</p>
        )}
        <div class="rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-3 text-xs font-bold text-[var(--app-muted)]">
          暂无安装
        </div>
      </div>
    )
  }

  if (props.compact) {
    return (
      <section class="grid gap-2">
        {props.device.installations.map((installation) => {
          const lastSeenAt = formatDeviceTimestamp(installation.lastSeenAt, '从未同步')
          return (
            <div class="grid gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 text-sm">
                  <p class="truncate font-black text-[var(--app-text)]">
                    {installation.hostname ?? formatPlatformLabel(installation.platform)}
                  </p>
                  <p class="mt-1 text-xs text-[var(--app-muted)]">
                    {formatPlatformLabel(installation.platform)} / {installation.clientVersion ?? '版本未知'}
                  </p>
                </div>
                <span class="shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-bg-soft)] px-2 py-1 text-xs font-bold text-[var(--app-muted)]">
                  {installation.activeTokenCount}
                </span>
              </div>
              <div class="grid gap-1 text-xs text-[var(--app-muted)]">
                <p>上次同步：{lastSeenAt.primary}</p>
                {lastSeenAt.secondary ? <p>{lastSeenAt.secondary}</p> : null}
              </div>
              <div class="flex justify-end">
                <InstallationRevokeForm installation={installation} state={props.state} />
              </div>
            </div>
          )
        })}
      </section>
    )
  }

  return (
    <section class="grid gap-2">
      {props.compact ? null : (
        <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">安装记录</p>
      )}
      {props.device.installations.map((installation) => {
        const lastSeenAt = formatDeviceTimestamp(installation.lastSeenAt, '从未同步')
        return (
          <details class="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3">
            <summary class="flex items-center justify-between gap-3">
              <div class="min-w-0 text-sm">
                <p class="truncate font-black text-[var(--app-text)]">
                  {installation.hostname ?? formatPlatformLabel(installation.platform)}
                </p>
                <p class="mt-1 text-xs text-[var(--app-muted)]">
                  {formatPlatformLabel(installation.platform)} / {installation.clientVersion ?? '版本未知'}
                </p>
              </div>
              <span class="shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1 text-xs font-bold text-[var(--app-muted)]">
                {installation.activeTokenCount}
              </span>
            </summary>
            <div class="mt-3 grid gap-2 text-xs text-[var(--app-muted)]">
              <p>上次同步：{lastSeenAt.primary}</p>
              {lastSeenAt.secondary ? <p>{lastSeenAt.secondary}</p> : null}
              <div class="flex justify-end">
                <InstallationRevokeForm installation={installation} state={props.state} />
              </div>
            </div>
          </details>
        )
      })}
    </section>
  )
}

function InstallationRevokeForm(props: { installation: UserDevice['installations'][number]; state: DevicesPageState }) {
  const disabled = props.installation.revokedAt !== null
  return (
    <form method="post" action="/settings/devices" data-submit-feedback="true">
      <input type="hidden" name="action" value="revoke-installation" />
      <input type="hidden" name="installationId" value={props.installation.id} />
      <input type="hidden" name="view" value={props.state.view} />
      <input type="hidden" name="query" value={props.state.query} />
      <Button
        class="w-full px-2 sm:w-auto"
        type="submit"
        variant="secondary"
        size="sm"
        disabled={disabled}
        data-confirm="确认只停用这个安装实例的上传凭证？"
        data-submitting-label="正在停用..."
      >
        停用安装
      </Button>
    </form>
  )
}

function DeviceAuditTrail(props: { auditLogs: UserDeviceAuditLog[]; compact?: boolean }) {
  if (props.auditLogs.length === 0) return null
  if (props.compact) {
    return (
      <section class="grid gap-2">
        <div class="flex items-center justify-between gap-3">
          <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">最近操作</p>
          <span class="text-xs font-bold text-[var(--app-muted)]">{props.auditLogs.length} 条</span>
        </div>
        <div class="grid gap-1.5">
          {props.auditLogs.map((log) => {
            const createdAt = formatDeviceTimestamp(log.createdAt)
            return (
              <p class="text-xs text-[var(--app-muted)]">
                <span class="font-bold text-[var(--app-text)]">{formatAuditAction(log.action)}</span>
                <span> / {createdAt.primary}</span>
                {createdAt.secondary ? <span> / {createdAt.secondary}</span> : null}
              </p>
            )
          })}
        </div>
      </section>
    )
  }
  return (
    <section class="grid gap-2">
      {props.compact ? null : (
        <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">最近操作</p>
      )}
      <div class="grid gap-2">
        {props.auditLogs.map((log) => {
          const createdAt = formatDeviceTimestamp(log.createdAt)
          return (
            <p class="break-words text-xs text-[var(--app-muted)]">
              <span class="font-bold text-[var(--app-text)]">{formatAuditAction(log.action)}</span>
              <span> / {createdAt.primary}</span>
              {createdAt.secondary ? <span> / {createdAt.secondary}</span> : null}
            </p>
          )
        })}
      </div>
    </section>
  )
}

function formatDeviceTimestamp(value: string | null | undefined, fallback = '从未同步') {
  if (!value) {
    return { primary: fallback, secondary: null as string | null }
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return { primary: value, secondary: null as string | null }
  }

  return {
    primary: formatRelativeDeviceTimestamp(date),
    secondary: formatAbsoluteDeviceTimestamp(date)
  }
}

function formatRelativeDeviceTimestamp(date: Date, now = new Date()) {
  const diffMs = date.getTime() - now.getTime()
  const absMs = Math.abs(diffMs)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day

  if (absMs < minute) return '刚刚'

  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
  const direction = diffMs < 0 ? -1 : 1
  if (absMs < hour) return formatter.format(direction * Math.floor(absMs / minute), 'minute')
  if (absMs < day) return formatter.format(direction * Math.floor(absMs / hour), 'hour')
  if (absMs < week) return formatter.format(direction * Math.floor(absMs / day), 'day')
  return formatter.format(direction * Math.floor(absMs / week), 'week')
}

function formatAbsoluteDeviceTimestamp(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')} UTC`
}

function summarizeDevices(devices: DeviceViewModel[]) {
  return devices.reduce(
    (summary, device) => {
      summary.deviceCount += 1
      summary.installationCount += device.installations.length
      summary.uploadTokenCount += device.uploadTokens.length
      summary.activeTokenCount += device.activeTokenCount
      if (device.lastSyncedAt && isStaleSync(device.lastSyncedAt)) {
        summary.staleDeviceCount += 1
      }
      return summary
    },
    {
      deviceCount: 0,
      installationCount: 0,
      uploadTokenCount: 0,
      activeTokenCount: 0,
      staleDeviceCount: 0
    }
  )
}

export type DevicesPageState = {
  view: DevicesView
  query: string
}

function filterDevices(devices: DeviceViewModel[], query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return devices
  return devices.filter((device) => {
    const haystack = [
      device.name,
      device.platform,
      formatPlatformLabel(device.platform),
      device.createdAt,
      device.lastSyncedAt ?? '',
      ...device.installations.flatMap((installation) => [
        installation.hostname ?? '',
        installation.platform,
        formatPlatformLabel(installation.platform),
        installation.clientVersion ?? ''
      ]),
      ...device.uploadTokens.flatMap((token) => [token.name, token.installationId ?? '', token.lastUsedAt ?? '']),
      ...(device.auditLogs ?? []).map((log) => `${log.action} ${log.createdAt}`)
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(normalized)
  })
}

function formatPlatformLabel(platform: string) {
  const labels: Record<string, string> = {
    darwin: 'macOS',
    linux: 'Linux',
    win32: 'Windows',
    browser: 'Browser',
    'browser-e2e': 'Browser E2E'
  }
  return labels[platform] ?? platform
}

function formatAuditAction(action: string) {
  const labels: Record<string, string> = {
    'device.pair': '连接',
    'device.reconnect': '重连',
    'device.rename': '改名',
    'device.revoke': '停用设备',
    'installation.revoke': '停用安装',
    'token.rotate': '换新凭证',
    'token.revoke': '停用凭证'
  }
  return labels[action] ?? action
}

function DevicesEmptyState(props: { query?: string }) {
  const hasQuery = props.query?.trim()
  return (
    <div
      class="app-surface-subtle rounded-2xl border border-dashed border-[var(--app-border)] bg-[var(--app-bg-soft)] p-6 text-sm text-[var(--app-muted)]"
      data-devices-empty-state="true"
    >
      {hasQuery ? `没有匹配「${hasQuery}」的设备。` : '还没有设备。'}
    </div>
  )
}

function DeviceStatus(props: { device: UserDevice }) {
  if (props.device.activeTokenCount <= 0) {
    return <StatusPill tone="muted">已停用</StatusPill>
  }
  if (!props.device.lastSyncedAt) {
    return <StatusPill tone="warning">从未同步</StatusPill>
  }
  if (isStaleSync(props.device.lastSyncedAt)) {
    return <StatusPill tone="warning">长时间未同步</StatusPill>
  }
  return <StatusPill tone="ok">正常</StatusPill>
}

function StatusPill(props: { tone: 'ok' | 'warning' | 'muted'; children: string }) {
  const classes = {
    ok: 'app-status-pill app-status-pill-ok',
    warning: 'app-status-pill app-status-pill-warning',
    muted: 'app-status-pill app-status-pill-muted'
  }
  return <span class={classes[props.tone]}>{props.children}</span>
}

function isStaleSync(lastSyncedAt: string) {
  const last = Date.parse(lastSyncedAt)
  if (!Number.isFinite(last)) return true
  return Date.now() - last > 72 * 60 * 60 * 1000
}
