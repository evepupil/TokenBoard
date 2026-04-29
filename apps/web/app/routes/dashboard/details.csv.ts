import { createRoute } from 'honox/factory'
import { requireUser } from '../../features/auth/middleware'
import { getUsageDetails } from '../../features/usage/queries'
import { parseUsageDetailsFilters, usageDetailsToCsv } from '../../features/usage/service'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const filters = parseUsageDetailsFilters({
    source: c.req.query('source'),
    startDate: c.req.query('startDate'),
    endDate: c.req.query('endDate'),
    device: c.req.query('device'),
    model: c.req.query('model')
  })
  const details = await getUsageDetails(c.env.DB, {
    userId: user.id,
    ...filters
  })
  const filename = `tokenboard-${filters.startDate}-to-${filters.endDate}.csv`

  return c.body(usageDetailsToCsv(details), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`
  })
})
