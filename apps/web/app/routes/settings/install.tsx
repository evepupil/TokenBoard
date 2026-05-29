import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { requireUser } from '../../features/auth/middleware'
import { InstallCommand } from '../../features/device/components/install-command'
import { D1DevicePairingRepository } from '../../features/device/repository'
import { createPairingCode, createPairingCodeDeps } from '../../features/device/service'
import { getCanonicalPublicOrigin, getProfileSettings } from '../../features/settings/service'
import { ApiError } from '../../lib/errors'
import { jsonError } from '../../lib/http'
import { normalizeTimezone, parseTimezone } from '../../lib/timezone'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const publicOrigin = getCanonicalPublicOrigin({
    configuredOrigin: c.env.BETTER_AUTH_URL,
    requestOrigin: new URL(c.req.url).origin
  })
  const profile = await getProfileSettings(c.env.DB, user.id, publicOrigin)
  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>连接 TokenBoard</title>
      <AppNav active="install" email={user.email} />
      <InstallCommand
        baseUrl={publicOrigin}
        timezone={profile.timezone}
        collectorRepoUrl={c.env.TOKENBOARD_COLLECTOR_REPO_URL}
      />
    </main>
  )
})

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const form = await c.req.parseBody()
    const publicOrigin = getCanonicalPublicOrigin({
      configuredOrigin: c.env.BETTER_AUTH_URL,
      requestOrigin: new URL(c.req.url).origin
    })
    const profile = await readProfile(c.env.DB, user.id, publicOrigin)
    const timezone = parseInstallTimezone(form.timezone, profile.timezone)
    const repository = new D1DevicePairingRepository(c.env.DB)
    const result = await createPairingCode(repository, user.id, createPairingCodeDeps())

    return c.render(
      <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
        <title>连接 TokenBoard</title>
        <AppNav active="install" email={user.email} />
        <InstallCommand
          baseUrl={publicOrigin}
          timezone={timezone}
          collectorRepoUrl={c.env.TOKENBOARD_COLLECTOR_REPO_URL}
          pairingCode={result.pairingCode}
          expiresAt={result.expiresAt}
        />
      </main>
    )
  } catch (error) {
    return jsonError(c, error)
  }
})

async function readProfile(db: D1Database, userId: string, origin: string) {
  return getProfileSettings(db, userId, origin)
}

function parseInstallTimezone(value: unknown, fallback: string) {
  if (typeof value !== 'string' || value.trim() === '') return normalizeTimezone(fallback)

  const timezone = parseTimezone(value)
  if (!timezone) {
    throw new ApiError('BAD_REQUEST', 'Invalid timezone', 400)
  }

  return timezone
}
