import { createRoute } from 'honox/factory'
import { createModelPricingResponse } from '../../../features/model-pricing/http'
import { jsonError } from '../../../lib/http'
import { clientIpRateLimitSubject, enforceRateLimit, readRateLimitPolicies } from '../../../lib/rate-limit'

// Keep the versioned path as a stable compatibility alias for collectors.
// The public route owns the Worker Cache API; collectors must read the current
// catalogue from D1 instead of sharing that public cache entry. That makes every
// request here a D1 read, so the anonymous path gets an IP ceiling: collectors
// read the catalogue at most once per cache period, well under it.
export const GET = createRoute(async (c) => {
  try {
    await enforceRateLimit(c.env.DB, {
      policy: readRateLimitPolicies.modelPricingRead,
      subject: clientIpRateLimitSubject(c.req.raw.headers)
    })
    return createModelPricingResponse({
      db: c.env.DB,
      searchParams: new URL(c.req.url).searchParams,
      requestHeaders: c.req.raw.headers
    })
  } catch (error) {
    return jsonError(c, error)
  }
})
