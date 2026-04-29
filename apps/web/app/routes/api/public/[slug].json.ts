import { createRoute } from 'honox/factory'
import { getPublicRouteSlug, getPublicUsageJson } from '../../../features/public-card/service'
import { jsonError } from '../../../lib/http'

export const GET = createRoute(async (c) => {
  try {
    const slug = getPublicRouteSlug(c.req.param(), 'json')
    const data = await getPublicUsageJson(c.env.DB, slug)
    return c.json(data, 200, {
      'cache-control': 'public, max-age=300'
    })
  } catch (error) {
    return jsonError(c, error)
  }
})
