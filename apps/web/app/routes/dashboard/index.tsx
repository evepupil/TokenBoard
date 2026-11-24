import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { requireUser } from '../../features/auth/middleware'
import { getProfileDisplayName, getProfileTimezoneSettings } from '../../features/settings/service'
import { DashboardPreview } from '../../features/usage/components/dashboard-preview'
import { getDashboardSummary } from '../../features/usage/service'
import { timezoneOffsetLabel } from '../../lib/time'

export default createRoute(async (c) => {
  const user = await requireUser(c)
  // `requireUser` has just synced the profile timezone from the browser cookie, so this is the
  // same zone the public card renders and the same one the collector stamped its dates with.
  const [{ timezone }, displayName] = await Promise.all([
    getProfileTimezoneSettings(c.env.DB, user.id),
    getProfileDisplayName(c.env.DB, user.id, user.name || user.email)
  ])
  const summary = await getDashboardSummary(c.env.DB, user.id, new Date(), c.env, timezone)

  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-8 sm:py-6">
      <title>控制台 - TokenBoard</title>
      <AppNav active="dashboard" email={user.email} compact />
      <DashboardPreview
        summary={summary}
        userName={displayName}
        timezone={timezone}
        timezoneLabel={timezoneOffsetLabel(timezone)}
      />
    </main>
  )
})
