import { createRoute } from 'honox/factory'
import { LeaderboardPanel } from '../../features/leaderboards/components/leaderboard-panel'
import { leaderboardMetricSchema, leaderboardPeriodSchema } from '../../features/leaderboards/schema'
import { getLeaderboard } from '../../features/leaderboards/service'
import { resolveViewerTimezone } from '../../features/leaderboards/viewer-timezone'
import { getOptionalUser } from '../../features/auth/middleware'
import { jsonError } from '../../lib/http'
import { clientIpRateLimitSubject, enforceRateLimit, readRateLimitPolicies } from '../../lib/rate-limit'

export const GET = createRoute(async (c) => {
  // The panel's day boundaries depend on the viewer's zone, so the rendered board is
  // viewer-specific even though it carries no identity. A shared browser cache replaying it
  // would show the next person another viewer's day — the full page route sets `no-store` for
  // its own reasons, and the fragment must not be the cached way around it.
  c.header('Cache-Control', 'no-store')
  try {
    // The fragment builds the same aggregate the full page does, so it is the same anonymous
    // read amplifier: cap it at the same ceiling the page now applies.
    await enforceRateLimit(c.env.DB, {
      policy: readRateLimitPolicies.publicLeaderboardRead,
      subject: clientIpRateLimitSubject(c.req.raw.headers)
    })
    const period = leaderboardPeriodSchema.catch('daily').parse(c.req.query('period'))
    const metric = leaderboardMetricSchema.catch('tokens').parse(c.req.query('metric'))
    // The fetch carries the session cookie when there is one, so this route resolves the zone
    // exactly as the full page does. Reading only the browser cookie here made a user who had
    // set their zone by hand see one day's board on load and another's after clicking a tab.
    const user = await getOptionalUser(c)
    const timezone = await resolveViewerTimezone({
      db: c.env.DB,
      userId: user?.id ?? null,
      cookieHeader: c.req.header('cookie')
    })
    // Same session read as the full page, so the fragment flags the viewer's own row exactly as
    // the panel it replaces did. Resolving the highlight from the cookie instead would drop it
    // the moment a signed-in user clicked a tab.
    const view = await getLeaderboard(
      c.env.DB,
      { period, metric, viewerUserId: user?.id ?? null },
      new Date(),
      c.env,
      timezone
    )

    return c.html(
      <LeaderboardPanel
        entries={view.entries}
        period={view.period}
        metric={view.metric}
        rangeLabel={view.rangeLabel}
        timezone={view.timezone}
        timezoneLabel={view.timezoneLabel}
        limit={view.limit}
      />
    )
  } catch (error) {
    return jsonError(c, error)
  }
})
