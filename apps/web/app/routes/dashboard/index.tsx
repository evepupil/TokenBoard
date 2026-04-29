import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { requireUser } from '../../features/auth/middleware'
import { getProfileDisplayName } from '../../features/settings/service'
import { DashboardPreview } from '../../features/usage/components/dashboard-preview'
import { getDashboardSummary } from '../../features/usage/service'

export default createRoute(async (c) => {
  const user = await requireUser(c)
  const summary = await getDashboardSummary(c.env.DB, user.id)
  const displayName = await getProfileDisplayName(c.env.DB, user.id, user.name || user.email)

  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-5 py-6 text-[var(--app-text)]">
      <title>控制台 - TokenBoard</title>
      <AppNav active="dashboard" email={user.email} />
      <DashboardPreview summary={summary} userName={displayName} />
    </main>
  )
})
