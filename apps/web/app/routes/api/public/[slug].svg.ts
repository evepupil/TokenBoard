import { createRoute } from 'honox/factory'
import { getPublicUsageCard } from '../../../features/public-card/service'
import { jsonError } from '../../../lib/http'

export const GET = createRoute(async (c) => {
  try {
    const slug = c.req.param('slug') ?? ''
    const svg = await getPublicUsageCard(c.env.DB, slug)
    return c.body(svg, 200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=300'
    })
  } catch (error) {
    return jsonError(c, error)
  }
})
