import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { requireUser } from '../../features/auth/middleware'
import { InstallCommand } from '../../features/device/components/install-command'
import { D1DevicePairingRepository } from '../../features/device/repository'
import { createPairingCode, createPairingCodeDeps } from '../../features/device/service'
import { getCanonicalPublicOrigin } from '../../features/settings/service'
import { jsonError } from '../../lib/http'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const publicOrigin = getCanonicalPublicOrigin({
    configuredOrigin: c.env.BETTER_AUTH_URL,
    requestOrigin: new URL(c.req.url).origin
  })
  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-5 py-6 text-[var(--app-text)]">
      <title>连接 TokenBoard</title>
      <AppNav active="install" email={user.email} />
      <InstallCommand baseUrl={publicOrigin} timezone="Asia/Shanghai" />
    </main>
  )
})

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const form = await c.req.parseBody()
    const timezone = String(form.timezone || 'Asia/Shanghai')
    const publicOrigin = getCanonicalPublicOrigin({
      configuredOrigin: c.env.BETTER_AUTH_URL,
      requestOrigin: new URL(c.req.url).origin
    })
    const repository = new D1DevicePairingRepository(c.env.DB)
    const result = await createPairingCode(repository, user.id, createPairingCodeDeps())

    return c.render(
      <main class="min-h-screen bg-[var(--app-bg)] px-5 py-6 text-[var(--app-text)]">
        <title>连接 TokenBoard</title>
        <AppNav active="install" email={user.email} />
        <InstallCommand
          baseUrl={publicOrigin}
          timezone={timezone}
          pairingCode={result.pairingCode}
          expiresAt={result.expiresAt}
        />
      </main>
    )
  } catch (error) {
    return jsonError(c, error)
  }
})
