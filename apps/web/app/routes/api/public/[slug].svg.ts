import { createRoute } from 'honox/factory'
import { getEmptyPublicCard } from '../../../features/public-card/service'

export const GET = createRoute((c) => {
  return c.body(getEmptyPublicCard(), 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'public, max-age=300'
  })
})

