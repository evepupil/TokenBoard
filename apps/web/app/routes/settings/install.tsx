import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { requireUser } from '../../features/auth/middleware'
import { InstallCommand } from '../../features/device/components/install-command'
import { D1DevicePairingRepository } from '../../features/device/repository'
import { createPairingCode, createPairingCodeDeps } from '../../features/device/service'
import { requireDeviceStepUp } from '../../features/device/step-up'
import { getCanonicalPublicOrigin, getProfileTimezoneSettings } from '../../features/settings/service'
import { ApiError } from '../../lib/errors'
import { jsonError } from '../../lib/http'
import { enforceRateLimit, writeRateLimitPolicies } from '../../lib/rate-limit'
import { normalizeTimezone, parseTimezone } from '../../lib/timezone'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const publicOrigin = getCanonicalPublicOrigin({
    configuredOrigin: c.env.BETTER_AUTH_URL,
    requestOrigin: new URL(c.req.url).origin
  })
  const profile = await getProfileTimezoneSettings(c.env.DB, user.id)
  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>连接 TokenBoard</title>
      <AppNav active="install" email={user.email} />
      <InstallCommand
        baseUrl={publicOrigin}
        timezone={profile.timezone}
        collectorRepoUrl={c.env.TOKENBOARD_COLLECTOR_REPO_URL}
        collectorRepoRef={c.env.TOKENBOARD_COLLECTOR_REF}
      />
    </main>
  )
})

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    // This form mints the same one-time pairing code as POST /api/v1/device/pairing-codes, so it
    // carries the same per-user ceiling: leaving it out would let the API limit be bypassed by
    // posting the form instead.
    await enforceRateLimit(c.env.DB, {
      policy: writeRateLimitPolicies.pairingCode,
      subject: { kind: 'user', value: user.id }
    })
    const form = await c.req.parseBody()
    const publicOrigin = getCanonicalPublicOrigin({
      configuredOrigin: c.env.BETTER_AUTH_URL,
      requestOrigin: new URL(c.req.url).origin
    })
    const profile = await readProfile(c.env.DB, user.id)
    const timezone = parseInstallTimezone(form.timezone, profile.timezone)
    const targetDeviceId = parseOptionalDeviceId(form.targetDeviceId)
    if (targetDeviceId) {
      requireDeviceStepUp(c.env, 'device.reconnect')
    }
    const repository = new D1DevicePairingRepository(c.env.DB)
    const result = await createPairingCode(
      repository,
      user.id,
      createPairingCodeDeps(),
      30,
      targetDeviceId
        ? {
            pairingType: 'reconnect_device',
            targetDeviceId
          }
        : undefined
    )

    c.header('Cache-Control', 'no-store')
    return c.render(
      <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
        <title>连接 TokenBoard</title>
        <AppNav active="install" email={user.email} />
        <InstallCommand
          baseUrl={publicOrigin}
          timezone={timezone}
          collectorRepoUrl={c.env.TOKENBOARD_COLLECTOR_REPO_URL}
          collectorRepoRef={c.env.TOKENBOARD_COLLECTOR_REF}
          pairingCode={result.pairingCode}
          expiresAt={result.expiresAt}
          mode={targetDeviceId ? 'reconnect' : 'new'}
          targetDeviceId={targetDeviceId ?? undefined}
        />
      </main>
    )
  } catch (error) {
    return jsonError(c, error)
  }
})

async function readProfile(db: D1Database, userId: string) {
  return getProfileTimezoneSettings(db, userId)
}

function parseInstallTimezone(value: unknown, fallback: string) {
  if (typeof value !== 'string' || value.trim() === '') return normalizeTimezone(fallback)

  const timezone = parseTimezone(value)
  if (!timezone) {
    throw new ApiError('BAD_REQUEST', 'Invalid timezone', 400)
  }

  return timezone
}

// The reconnect endpoint caps `targetDeviceId` at 128 characters; this form feeds the same
// pairing-code creation, so it carries the same ceiling. Ownership is still enforced by
// `ensureDeviceOwnedByUser`, so this is an input bound, not an authorization check.
function parseOptionalDeviceId(value: unknown) {
  if (typeof value !== 'string') return null
  const deviceId = value.trim()
  if (!deviceId || deviceId.length > 128) return null
  return deviceId
}
