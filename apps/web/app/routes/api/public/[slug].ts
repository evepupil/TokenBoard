import { createRoute } from 'honox/factory'
import {
  createPublicUsageResponse,
  parsePublicUsageSegment,
  publicApiErrorResponse
} from '../../../features/public-card/http'
import { usageSummaryStrictMode } from '../../../features/usage/deduped-daily-usage'
import { clientIpRateLimitSubject, enforceRateLimit, readRateLimitPolicies } from '../../../lib/rate-limit'

export const GET = createRoute(async (c) => {
  try {
    // The slug check is a D1 query on every request, and the 404/private answers are
    // `no-store` by policy so they can never be served from cache. Capping the
    // anonymous path keeps random-slug traffic from becoming unbounded D1 reads;
    // the ceiling sits far above any real README-card view rate.
    await enforceRateLimit(c.env.DB, {
      policy: readRateLimitPolicies.publicCardRead,
      subject: clientIpRateLimitSubject(c.req.raw.headers)
    })
    const params = c.req.param() as Record<string, string | undefined>
    const route = parsePublicUsageSegment(params.slug ?? '')
    return await createPublicUsageResponse({
      db: c.env.DB,
      route,
      configuredOrigin: c.env.BETTER_AUTH_URL,
      requestOrigin: new URL(c.req.url).origin,
      summaryStrict: usageSummaryStrictMode(c.env)
    })
  } catch (error) {
    return publicApiErrorResponse(error)
  }
})
