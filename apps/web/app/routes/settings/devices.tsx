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
  try {
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
  } catch (error) {
    return jsonError(c, error)
  }
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

function DevicesPage(props: {
  devices: UserDevice[]
  email: string
  saved: boolean
  revoked: boolean
}) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-5 py-6 text-[var(--app-text)]">
      <title>设备管理 - TokenBoard</title>
      <AppNav active="devices" email={props.email} />

      <section class="mx-auto flex max-w-6xl flex-col gap-5">
        <header class="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-xl shadow-black/10">
          <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p class="text-sm font-black uppercase tracking-[0.24em] text-lime-300">Devices</p>
              <h1 class="mt-3 text-4xl font-black tracking-tight">设备管理</h1>
              <p class="mt-2 text-sm text-[var(--app-muted)]">
                查看采集器设备、同步状态，并停用不再使用的上传 token。
              </p>
            </div>
            <LinkButton href="/settings/install">连接新设备</LinkButton>
          </div>
        </header>

        {props.saved ? (
          <p class="rounded-md border border-lime-300/30 bg-lime-300/10 p-3 text-sm text-lime-100">设备名称已更新。</p>
        ) : null}
        {props.revoked ? (
          <p class="rounded-md border border-lime-300/30 bg-lime-300/10 p-3 text-sm text-lime-100">设备 token 已停用。</p>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>已连接设备</CardTitle>
            <CardDescription>停用设备只会阻止后续上传，历史用量会继续保留。</CardDescription>
          </CardHeader>
          <CardContent>
            {props.devices.length > 0 ? (
              <div class="overflow-x-auto">
                <Table class="min-w-[900px]">
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
                  <TableBody>
                    {props.devices.map((device) => (
                      <TableRow>
                        <TableCell class="min-w-64">
                          <form method="post" class="flex items-center gap-2">
                            <input type="hidden" name="action" value="rename" />
                            <input type="hidden" name="deviceId" value={device.id} />
                            <Input class="mt-0 h-10 py-2" name="name" value={device.name} required minLength={1} />
                            <Button type="submit" variant="secondary" size="sm">保存</Button>
                          </form>
                        </TableCell>
                        <TableCell>{device.platform}</TableCell>
                        <TableCell>{device.lastSyncedAt ?? '从未同步'}</TableCell>
                        <TableCell>{device.createdAt}</TableCell>
                        <TableCell>
                          <DeviceStatus device={device} />
                        </TableCell>
                        <TableCell>
                          <form method="post">
                            <input type="hidden" name="action" value="revoke" />
                            <input type="hidden" name="deviceId" value={device.id} />
                            <Button
                              type="submit"
                              variant="destructive"
                              size="sm"
                              disabled={device.activeTokenCount <= 0}
                            >
                              停用
                            </Button>
                          </form>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div class="rounded-xl border border-dashed border-[var(--app-border)] p-6 text-sm text-[var(--app-muted)]">
                还没有连接设备。
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
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
    ok: 'border-lime-300/40 bg-lime-300/10 text-lime-100',
    warning: 'border-amber-300/40 bg-amber-300/10 text-amber-100',
    muted: 'border-[var(--app-border)] bg-[var(--app-bg-soft)] text-[var(--app-muted)]'
  }
  return <span class={`inline-flex rounded-full border px-2 py-1 text-xs font-bold ${classes[props.tone]}`}>{props.children}</span>
}

function isStaleSync(lastSyncedAt: string) {
  const last = Date.parse(lastSyncedAt)
  if (!Number.isFinite(last)) return true
  return Date.now() - last > 72 * 60 * 60 * 1000
}
