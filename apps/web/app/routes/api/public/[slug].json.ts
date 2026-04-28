import { createRoute } from 'honox/factory'

export const GET = createRoute((c) => {
  const slug = c.req.param('slug')
  return c.json({
    slug,
    todayTokens: 0,
    monthCostUsd: 0
  })
})

