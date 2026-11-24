import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { getOptionalUser } from '../../features/auth/middleware'
import { LeaderboardPanel } from '../../features/leaderboards/components/leaderboard-panel'
import { leaderboardMetricSchema, leaderboardPeriodSchema } from '../../features/leaderboards/schema'
import { getLeaderboard } from '../../features/leaderboards/service'
import { leaderboardDocumentTitle } from '../../features/leaderboards/title'
import { resolveViewerTimezone } from '../../features/leaderboards/viewer-timezone'
import { clientIpRateLimitSubject, enforceRateLimit, readRateLimitPolicies } from '../../lib/rate-limit'

export default createRoute(async (c) => {
  // The board itself is public, but the nav renders the signed-in viewer's email. This route
  // reads the session with `getOptionalUser` rather than `requireUser`, so it is outside the
  // boundary that sets `no-store` for session-gated pages; without a directive a browser may
  // cache the page heuristically and show the previous user's account on a shared machine.
  c.header('Cache-Control', 'no-store')
  // Rendering the board aggregates the whole summary table for the ranked window, and the page is
  // `no-store`, so every anonymous request reaches D1. Without a ceiling the heaviest read on the
  // site is an unbounded anonymous amplifier; the same 120/60s applies here as on the other
  // anonymous read paths. Placed before the session read so the ceiling covers that request too.
  await enforceRateLimit(c.env.DB, {
    policy: readRateLimitPolicies.publicLeaderboardRead,
    subject: clientIpRateLimitSubject(c.req.raw.headers)
  })
  const user = await getOptionalUser(c)
  const period = leaderboardPeriodSchema.catch('daily').parse(c.req.query('period'))
  const metric = leaderboardMetricSchema.catch('tokens').parse(c.req.query('metric'))
  // The board is public, so an anonymous viewer has no profile: their browser's own zone is
  // what their "today" means, and it is already in the cookie the client sets. Resolved through
  // the shared helper so this route and the fragment it swaps in cannot disagree about the day.
  const timezone = await resolveViewerTimezone({
    db: c.env.DB,
    userId: user?.id ?? null,
    cookieHeader: c.req.header('cookie')
  })
  // The panel highlights the signed-in viewer's own row, so the page and the fragment that
  // swaps in for it both pass the id from the session they already read. An anonymous viewer
  // passes `null`, and nobody is flagged.
  const view = await getLeaderboard(
    c.env.DB,
    { period, metric, viewerUserId: user?.id ?? null },
    new Date(),
    c.env,
    timezone
  )

  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>{leaderboardDocumentTitle({ period, metric })}</title>
      <AppNav active="leaderboards" email={user?.email} isAuthenticated={Boolean(user)} />
      <LeaderboardPanel
        entries={view.entries}
        period={view.period}
        metric={view.metric}
        rangeLabel={view.rangeLabel}
        timezone={view.timezone}
        timezoneLabel={view.timezoneLabel}
        limit={view.limit}
      />
    </main>
  )
})
