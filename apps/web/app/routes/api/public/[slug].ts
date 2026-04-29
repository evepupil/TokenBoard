import { createRoute } from 'honox/factory'
import {
  getPublicUsageCard,
  getPublicUsageJson,
  normalizePublicSlug
} from '../../../features/public-card/service'
import { ApiError } from '../../../lib/errors'
import { jsonError } from '../../../lib/http'

export const GET = createRoute(async (c) => {
  try {
    const slug = c.req.param('slug') ?? ''
    if (slug.endsWith('.json')) {
      const data = await getPublicUsageJson(c.env.DB, normalizePublicSlug(slug, 'json'))
      return c.json(data, 200, {
        'cache-control': 'public, max-age=300'
      })
    }

    if (slug.endsWith('.svg')) {
      const svg = await getPublicUsageCard(c.env.DB, normalizePublicSlug(slug, 'svg'))
      return c.body(svg, 200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=300'
      })
    }

    throw new ApiError('NOT_FOUND', 'Public endpoint not found', 404)
  } catch (error) {
    return jsonError(c, error)
  }
})
