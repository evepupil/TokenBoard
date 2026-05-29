import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { requireUser } from '../../features/auth/middleware'
import { listUserDevices } from '../../features/device/service'
import { UsageDetailsPanel } from '../../features/usage/components/usage-details-panel'
import { getUsageDetails } from '../../features/usage/queries'
import { parseUsageDetailsFilters } from '../../features/usage/service'

export default createRoute(async (c) => {
  const user = await requireUser(c)
  const filters = parseUsageDetailsFilters({
    source: c.req.query('source'),
    startDate: c.req.query('startDate'),
    endDate: c.req.query('endDate'),
    device: c.req.query('device'),
    model: c.req.query('model')
  })
  const [details, devices] = await Promise.all([
    getUsageDetails(c.env.DB, {
      userId: user.id,
      ...filters
    }),
    listUserDevices(c.env.DB, user.id)
  ])

  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>用量详情 - TokenBoard</title>
      <AppNav active="details" email={user.email} />
      <UsageDetailsPanel details={details} filters={filters} devices={devices} />
    </main>
  )
})
