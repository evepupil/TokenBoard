import { createRoute } from 'honox/factory'
import { createCachedModelPricingResponse } from '../../../features/model-pricing/http'
import { jsonError } from '../../../lib/http'
import { clientIpRateLimitSubject, enforceRateLimit, readRateLimitPolicies } from '../../../lib/rate-limit'

// The Worker cache only stores 200s, so a request that misses it — a novel `?cursor=`, a
// rejected limit — reaches D1 every time. The entrypoint (app/server.ts) answers the canonical
// spelling of this path and caps it there; the ceiling is repeated here because Hono
// percent-decodes the path before matching, so `/%61pi/public/model-pricing` reaches this route
// having declined the entrypoint's exact-string comparison. One of the two always returns before
// the other runs, so a request is counted once and the effective ceiling stays 120/60s.
export const GET = createRoute(async (c) => {
  try {
    await enforceRateLimit(c.env.DB, {
      policy: readRateLimitPolicies.publicModelPricingRead,
      subject: clientIpRateLimitSubject(c.req.raw.headers)
    })
    const executionContext = readExecutionContext(c)
    return createCachedModelPricingResponse({
      db: c.env.DB,
      url: new URL(c.req.url),
      requestHeaders: c.req.raw.headers,
      waitUntil: executionContext?.waitUntil.bind(executionContext)
    })
  } catch (error) {
    return jsonError(c, error)
  }
})

function readExecutionContext(value: unknown) {
  try {
    const executionContext = (value as { executionCtx?: unknown }).executionCtx
    if (!executionContext || typeof executionContext !== 'object') return undefined
    if (!('waitUntil' in executionContext) || typeof executionContext.waitUntil !== 'function') return undefined
    return executionContext as ExecutionContext
  } catch {
    return undefined
  }
}
