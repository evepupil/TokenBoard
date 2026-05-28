import { createRoute } from 'honox/factory'
import { getPublicRouteSlug, getPublicUsageCard } from '../../../features/public-card/service'
import { getCanonicalPublicOrigin } from '../../../features/settings/service'
import { jsonError } from '../../../lib/http'

export const GET = createRoute(async (c) => {
  try {
    const slug = getPublicRouteSlug(c.req.param(), 'svg')
    const origin = getCanonicalPublicOrigin({
      configuredOrigin: c.env.BETTER_AUTH_URL,
      requestOrigin: new URL(c.req.url).origin
    })
    const svg = await getPublicUsageCard(c.env.DB, slug, new Date(), origin)
    return c.body(svg, 200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=300'
    })
  } catch (error) {
    return jsonError(c, error)
  }
})
