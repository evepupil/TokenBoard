import { createRoute } from 'honox/factory'
import { DashboardPreview } from '../features/usage/components/dashboard-preview'
import { getDashboardSummary } from '../features/usage/service'

export default createRoute(async (c) => {
  const summary = await getDashboardSummary(c.env.DB, c.env.SEED_USER_ID)

  return c.render(
    <main class="min-h-screen bg-zinc-950 px-6 py-8 text-zinc-50">
      <title>TokenBoard</title>
      <DashboardPreview summary={summary} />
    </main>
  )
})
