import { createRoute } from 'honox/factory'
import { requireUser } from '../../../../features/auth/middleware'
import { D1DevicePairingRepository } from '../../../../features/device/repository'
import { createPairingCode, createPairingCodeDeps } from '../../../../features/device/service'
import { getCanonicalPublicOrigin } from '../../../../features/settings/service'
import { jsonError } from '../../../../lib/http'

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const repository = new D1DevicePairingRepository(c.env.DB)
    const result = await createPairingCode(repository, user.id, createPairingCodeDeps())
    const baseUrl = getCanonicalPublicOrigin({
      configuredOrigin: c.env.BETTER_AUTH_URL,
      requestOrigin: new URL(c.req.url).origin
    })

    return c.json({
      ...result,
      baseUrl
    })
  } catch (error) {
    return jsonError(c, error)
  }
})
