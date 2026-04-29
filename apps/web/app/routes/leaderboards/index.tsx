import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { getOptionalUser } from '../../features/auth/middleware'
import { LeaderboardPanel } from '../../features/leaderboards/components/leaderboard-panel'
import { leaderboardMetricSchema, leaderboardPeriodSchema } from '../../features/leaderboards/schema'
import { getLeaderboard } from '../../features/leaderboards/service'

export default createRoute(async (c) => {
  const user = await getOptionalUser(c)
  const period = leaderboardPeriodSchema.catch('daily').parse(c.req.query('period'))
  const metric = leaderboardMetricSchema.catch('tokens').parse(c.req.query('metric'))
  const entries = await getLeaderboard(c.env.DB, { period, metric })

  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-5 py-6 text-[var(--app-text)]">
      <title>排行榜 - TokenBoard</title>
      <AppNav active="leaderboards" email={user?.email} isAuthenticated={Boolean(user)} />
      <LeaderboardPanel entries={entries} period={period} metric={metric} />
    </main>
  )
})
