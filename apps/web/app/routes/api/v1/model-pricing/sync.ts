import { createRoute } from 'honox/factory'
import {
  modelPricingSyncEnabled,
  parsePricingSyncToken,
  pricingSyncTokenConfigured,
  readModelPricingSyncState,
  runModelPricingSync,
  verifyPricingSyncToken
} from '../../../../features/model-pricing/service'
import { ApiError } from '../../../../lib/errors'
import { jsonError } from '../../../../lib/http'
import { clientIpRateLimitSubject, enforceRateLimit, writeRateLimitPolicies } from '../../../../lib/rate-limit'

export const POST = createRoute(async (c) => {
  try {
    if (!pricingSyncTokenConfigured(c.env)) {
      throw new ApiError('INTERNAL_SERVER_ERROR', 'Model pricing sync is not configured', 500)
    }
    if (!(await verifyPricingSyncToken(c.env, c.req.header('authorization')))) {
      throw new ApiError('UNAUTHORIZED', 'Invalid model pricing sync token', 401)
    }
    const clientIp = clientIpRateLimitSubject(c.req.raw.headers)
    const pricingSyncToken = parsePricingSyncToken(c.req.header('authorization'))
    if (!pricingSyncToken) {
      throw new ApiError('UNAUTHORIZED', 'Invalid model pricing sync token', 401)
    }
    await enforceRateLimit(c.env.DB, {
      policy: writeRateLimitPolicies.modelPricingSyncIp,
      // Keep the network-wide guard while allowing independently configured
      // authenticated callers behind the same NAT to sync concurrently.
      subject: { kind: 'ip', value: `${clientIp.value}\u0000${pricingSyncToken}` }
    })
    const result = await runModelPricingSync({
      env: c.env,
      force: true
    })
    const syncState = await readModelPricingSyncState(c.env.DB)
    c.header('Cache-Control', 'no-store')
    return c.json({ ...result, scheduledSyncEnabled: modelPricingSyncEnabled(c.env), syncState })
  } catch (error) {
    return jsonError(c, error)
  }
})
