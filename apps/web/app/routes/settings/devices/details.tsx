import { createRoute } from 'honox/factory'
import { AppNav } from '../../../components/app-nav'
import { LinkButton } from '../../../components/ui/button'
import { LucideIcon } from '../../../components/ui/icon'
import { requireUser } from '../../../features/auth/middleware'
import { listDeviceAuditLogs, listUserDevices } from '../../../features/device/service'
import { ApiError } from '../../../lib/errors'
import { X } from 'lucide'
import { DeviceDetailsDialogContent, DeviceDetailsPage, type DevicesPageState, type DevicesView } from '../devices'

export const GET = createRoute(async (c) => {
  const fragmentRequest = c.req.header('x-tokenboard-fragment') === 'device-details'
  const state: DevicesPageState = {
    view: normalizeDevicesView(c.req.query('view')),
    query: c.req.query('query') ?? ''
  }

  try {
    const user = await requireUser(c)
    const deviceId = c.req.query('deviceId') ?? ''
    const devices = await listUserDevices(c.env.DB, user.id)
    const device = devices.find((candidate) => candidate.id === deviceId)

    if (!device) {
      if (fragmentRequest) {
        return c.html(<DeviceDetailsError message="设备不存在或已不可用。" />, 404)
      }
      c.status(404)
      return c.render(<DeviceDetailsPageError email={user.email} message="设备不存在或已不可用。" state={state} />)
    }

    const auditLogs = await listDeviceAuditLogs(c.env.DB, {
      userId: user.id,
      deviceId: device.id,
      limit: 5
    })

    return fragmentRequest
      ? c.html(<DeviceDetailsDialogContent device={device} auditLogs={auditLogs} state={state} />)
      : c.render(<DeviceDetailsPage email={user.email} device={device} auditLogs={auditLogs} state={state} />)
  } catch (error) {
    if (fragmentRequest && error instanceof ApiError) {
      return c.html(<DeviceDetailsError message={formatDeviceDetailsError(error)} />, error.status)
    }
    if (fragmentRequest) {
      console.error(error)
      return c.html(<DeviceDetailsError message="加载设备详情失败，请稍后重试。" />, 500)
    }
    throw error
  }
})

function normalizeDevicesView(value: string | null | undefined): DevicesView {
  return value === 'cards' ? 'cards' : 'list'
}

function buildDevicesPageHref(input: { view: DevicesView; query: string }) {
  const params = new URLSearchParams()
  params.set('view', input.view)
  if (input.query.trim()) {
    params.set('query', input.query.trim())
  }
  return `/settings/devices?${params.toString()}`
}

function DeviceDetailsError(props: { message: string }) {
  return (
    <>
      <header class="flex items-start justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-panel)] p-4">
        <div class="min-w-0">
          <p id="device-details-dialog-title" class="text-base font-black text-[var(--app-text)]">
            设备详情
          </p>
          <p class="mt-1 text-sm font-bold text-[var(--app-muted)]">{props.message}</p>
        </div>
        <button
          type="button"
          class="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg-soft)] text-[var(--app-muted)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]"
          data-device-details-close="true"
          aria-label="关闭详情"
        >
          <LucideIcon icon={X} size={17} />
        </button>
      </header>
      <div class="app-device-dialog-body bg-[var(--app-bg-soft)] p-4 text-sm font-bold text-[var(--app-muted)]">
        请刷新页面后重试。
      </div>
    </>
  )
}

function DeviceDetailsPageError(props: { email: string; message: string; state: DevicesPageState }) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>设备详情 - TokenBoard</title>
      <AppNav active="devices" email={props.email} />

      <section class="mx-auto flex max-w-6xl flex-col gap-5">
        <article class="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)]">
          <header class="flex items-start justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-panel)] p-4">
            <div class="min-w-0">
              <p class="text-base font-black text-[var(--app-text)]">设备详情</p>
              <p class="mt-1 text-sm font-bold text-[var(--app-muted)]">{props.message}</p>
            </div>
            <LinkButton class="shrink-0" variant="secondary" size="sm" href={buildDevicesPageHref(props.state)}>
              返回列表
            </LinkButton>
          </header>
          <div class="app-device-dialog-body bg-[var(--app-bg-soft)] p-4 text-sm font-bold text-[var(--app-muted)]">
            请返回设备列表查看其他设备。
          </div>
        </article>
      </section>
    </main>
  )
}

function formatDeviceDetailsError(error: ApiError) {
  if (error.code === 'UNAUTHORIZED') return '登录已失效，请重新登录后再试。'
  if (error.code === 'FORBIDDEN') return '当前账号无权查看此设备。'
  if (error.code === 'NOT_FOUND') return '设备不存在或已不可用。'
  return error.message || '加载设备详情失败，请稍后重试。'
}
