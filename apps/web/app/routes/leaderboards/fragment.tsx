import { createRoute } from 'honox/factory'
import { LeaderboardPanel } from '../../features/leaderboards/components/leaderboard-panel'
import { leaderboardMetricSchema, leaderboardPeriodSchema } from '../../features/leaderboards/schema'
import { getLeaderboard } from '../../features/leaderboards/service'
import { jsonError } from '../../lib/http'

export const GET = createRoute(async (c) => {
  try {
    const period = leaderboardPeriodSchema.catch('daily').parse(c.req.query('period'))
    const metric = leaderboardMetricSchema.catch('tokens').parse(c.req.query('metric'))
    const entries = await getLeaderboard(c.env.DB, { period, metric })

    return c.html(<LeaderboardPanel entries={entries} period={period} metric={metric} />)
  } catch (error) {
    return jsonError(c, error)
  }
})
