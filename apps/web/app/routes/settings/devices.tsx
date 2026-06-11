import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { Button, LinkButton } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { requireUser } from '../../features/auth/middleware'
import {
  listUserDevices,
  parseDeviceNameForm,
  renameDevice,
  revokeDevice,
  type UserDevice
} from '../../features/device/service'
import { jsonError } from '../../lib/http'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const devices = await listUserDevices(c.env.DB, user.id)
  return c.render(
    <DevicesPage
      devices={devices}
      email={user.email}
      saved={c.req.query('saved') === '1'}
      revoked={c.req.query('revoked') === '1'}
    />
  )
})

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const form = await c.req.parseBody()
    const action = String(form.action ?? '')
    const deviceId = String(form.deviceId ?? '')

    if (action === 'rename') {
      await renameDevice(c.env.DB, {
        userId: user.id,
        deviceId,
        name: parseDeviceNameForm(form)
      })
      return c.redirect('/settings/devices?saved=1', 303)
    }

    if (action === 'revoke') {
      await revokeDevice(c.env.DB, {
        userId: user.id,
        deviceId
      })
      return c.redirect('/settings/devices?revoked=1', 303)
    }

    return c.redirect('/settings/devices', 303)
  } catch (error) {
    return jsonError(c, error)
  }
})

export function DevicesPage(props: {
  devices: UserDevice[]
  email: string
  saved: boolean
  revoked: boolean
}) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>设备管理 - TokenBoard</title>
      <AppNav active="devices" email={props.email} />

      <section class="mx-auto flex max-w-6xl flex-col gap-5">
        <DevicesHeader />
        <DevicePageFlash saved={props.saved} revoked={props.revoked} />
        <DevicesCard devices={props.devices} />
      </section>
    </main>
  )
}

function DevicesHeader() {
  return (
    <header class="app-surface-raised rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
      <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p class="app-accent-text text-sm font-black uppercase tracking-[0.24em]">Devices</p>
          <h1 class="mt-3 text-3xl font-black tracking-tight sm:text-4xl">设备管理</h1>
          <p class="mt-2 text-sm text-[var(--app-muted)]">
            查看采集器设备、同步状态，并停用不再使用的上传 token。
          </p>
        </div>
        <LinkButton class="w-full md:w-auto" href="/settings/install">连接新设备</LinkButton>
      </div>
    </header>
  )
}

function DevicePageFlash(props: { saved: boolean; revoked: boolean }) {
  return (
    <>
      {props.saved ? (
        <p class="app-flash-success p-3 text-sm">设备名称已更新。</p>
      ) : null}
      {props.revoked ? (
        <p class="app-flash-success p-3 text-sm">设备 token 已停用。</p>
      ) : null}
    </>
  )
}

function DevicesCard(props: { devices: UserDevice[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>已连接设备</CardTitle>
        <CardDescription>停用设备只会阻止后续上传，历史用量会继续保留。</CardDescription>
      </CardHeader>
      <CardContent>
        {props.devices.length > 0 ? <DevicesTable devices={props.devices} /> : <DevicesEmptyState />}
      </CardContent>
    </Card>
  )
}

function DevicesTable(props: { devices: UserDevice[] }) {
  return (
    <>
      <div class="grid gap-3 md:hidden" data-devices-mobile-list="true">
        {props.devices.map((device) => (
          <DeviceCard device={device} />
        ))}
      </div>
      <div class="hidden overflow-x-auto md:block" data-devices-desktop-table="true">
        <Table class="min-w-[900px]">
          <DevicesTableHeader />
          <TableBody>
            {props.devices.map((device) => (
              <DeviceRow device={device} />
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

function DeviceCard(props: { device: UserDevice }) {
  return (
    <article class="app-surface-raised rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-xs font-bold uppercase tracking-wide text-[var(--app-muted)]">设备</p>
          <h2 class="mt-1 truncate text-base font-black text-[var(--app-text)]">{props.device.name}</h2>
          <p class="mt-1 text-sm text-[var(--app-muted)]">{props.device.platform}</p>
        </div>
        <DeviceStatus device={props.device} />
      </div>
      <dl class="mt-4 grid gap-3 text-sm">
        <DeviceMeta label="最近同步" value={props.device.lastSyncedAt ?? '从未同步'} />
        <DeviceMeta label="创建时间" value={props.device.createdAt} />
      </dl>
      <div class="mt-4 grid gap-3">
        <DeviceRenameForm device={props.device} />
        <DeviceRevokeForm device={props.device} />
      </div>
    </article>
  )
}

function DeviceMeta(props: { label: string; value: string }) {
  return (
    <div>
      <dt class="text-xs font-bold uppercase tracking-wide text-[var(--app-muted)]">{props.label}</dt>
      <dd class="mt-1 break-all font-bold text-[var(--app-text)]">{props.value}</dd>
    </div>
  )
}

function DevicesTableHeader() {
  return (
    <TableHeader>
      <TableRow>
        <TableHead>设备</TableHead>
        <TableHead>Platform</TableHead>
        <TableHead>最近同步</TableHead>
        <TableHead>创建时间</TableHead>
        <TableHead>状态</TableHead>
        <TableHead>操作</TableHead>
      </TableRow>
    </TableHeader>
  )
}

function DeviceRow(props: { device: UserDevice }) {
  return (
    <TableRow>
      <TableCell class="min-w-64">
        <DeviceRenameForm device={props.device} />
      </TableCell>
      <TableCell>{props.device.platform}</TableCell>
      <TableCell>{props.device.lastSyncedAt ?? '从未同步'}</TableCell>
      <TableCell>{props.device.createdAt}</TableCell>
      <TableCell>
        <DeviceStatus device={props.device} />
      </TableCell>
      <TableCell>
        <DeviceRevokeForm device={props.device} />
      </TableCell>
    </TableRow>
  )
}

function DeviceRenameForm(props: { device: UserDevice }) {
  return (
    <form method="post" class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input type="hidden" name="action" value="rename" />
      <input type="hidden" name="deviceId" value={props.device.id} />
      <Input
        class="mt-0 h-10 py-2"
        name="name"
        value={props.device.name}
        autocomplete="off"
        required
        minLength={1}
      />
      <Button class="w-full sm:w-auto" type="submit" variant="secondary" size="sm">保存</Button>
    </form>
  )
}

function DeviceRevokeForm(props: { device: UserDevice }) {
  return (
    <form method="post">
      <input type="hidden" name="action" value="revoke" />
      <input type="hidden" name="deviceId" value={props.device.id} />
      <Button
        class="w-full sm:w-auto"
        type="submit"
        variant="destructive"
        size="sm"
        disabled={props.device.activeTokenCount <= 0}
        data-confirm="确认停用这个设备的上传 token？"
      >
        停用
      </Button>
    </form>
  )
}

function DevicesEmptyState() {
  return (
    <div class="app-surface-subtle rounded-xl border border-dashed border-[var(--app-border)] p-6 text-sm text-[var(--app-muted)]">
      还没有连接设备。
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
