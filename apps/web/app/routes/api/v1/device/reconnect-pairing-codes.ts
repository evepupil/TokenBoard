import { createRoute } from 'honox/factory'
import { z } from 'zod'
import { D1DevicePairingRepository } from '../../../../features/device/repository'
import { createPairingCodeDeps, createReconnectPairingCodeFromClaim } from '../../../../features/device/service'
import { getCanonicalPublicOrigin } from '../../../../features/settings/service'
import { jsonError } from '../../../../lib/http'
import { clientIpRateLimitSubject, enforceRateLimit, writeRateLimitPolicies } from '../../../../lib/rate-limit'

const reconnectPairingCodeRequestSchema = z.object({
  deviceId: z.string().min(1).max(128),
  installationId: z.string().min(1).max(128),
  installClaim: z.string().min(16).max(512)
})

export const POST = createRoute(async (c) => {
  try {
    await enforceRateLimit(c.env.DB, {
      policy: writeRateLimitPolicies.pairingCode,
      subject: clientIpRateLimitSubject(c.req.raw.headers)
    })
    const request = reconnectPairingCodeRequestSchema.parse(await c.req.json())
    const repository = new D1DevicePairingRepository(c.env.DB)
    const result = await createReconnectPairingCodeFromClaim(repository, request, createPairingCodeDeps())
    const baseUrl = getCanonicalPublicOrigin({
      configuredOrigin: c.env.BETTER_AUTH_URL,
      requestOrigin: new URL(c.req.url).origin
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ...result,
      baseUrl
    })
  } catch (error) {
    return jsonError(c, error)
  }
})
