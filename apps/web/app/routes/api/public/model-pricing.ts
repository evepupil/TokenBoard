import { createRoute } from 'honox/factory'
import { createModelPricingResponse } from '../../../features/model-pricing/http'

export const GET = createRoute(async (c) => {
  return createModelPricingResponse({
    db: c.env.DB,
    searchParams: new URL(c.req.url).searchParams,
    requestHeaders: c.req.raw.headers
  })
})
