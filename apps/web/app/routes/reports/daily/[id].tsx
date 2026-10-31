import { createRoute } from 'honox/factory'
import { getOptionalUser } from '../../../features/auth/middleware'
import { getDailyReportHistoryById, isDailyReportId } from '../../../features/notifications/report-share'
import { dailyReportHistoryRetentionDays } from '../../../features/notifications/report-history'
import { MissingDailyReportPage, SharedDailyReportPage } from '../../../features/notifications/report-page'
import { clientIpRateLimitSubject, enforceRateLimit, readRateLimitPolicies } from '../../../lib/rate-limit'

export const GET = createRoute(async (c) => {
  c.header('Cache-Control', 'no-store')
  c.header('X-Robots-Tag', 'noindex, nofollow')
  const params = c.req.param() as Record<string, string | undefined>
  const id = params.id ?? ''
  if (!isDailyReportId(id)) {
    c.status(404)
    return c.render(<MissingDailyReportPage />)
  }

  // The report lookup is a D1 query every request, and the page is `no-store`, so a random
  // (well-formed) id is an anonymous read. Malformed ids never reach here, so the ceiling sits
  // exactly where the read starts — the same placement as the other anonymous read paths.
  await enforceRateLimit(c.env.DB, {
    policy: readRateLimitPolicies.publicReportRead,
    subject: clientIpRateLimitSubject(c.req.raw.headers)
  })

  const user = await getOptionalUser(c)
  const report = await getDailyReportHistoryById({
    db: c.env.DB,
    id,
    viewerUserId: user?.id ?? null,
    retentionDays: dailyReportHistoryRetentionDays(c.env),
    now: new Date()
  })

  if (!report) {
    c.status(404)
    return c.render(<MissingDailyReportPage viewerEmail={user?.email} />)
  }

  return c.render(<SharedDailyReportPage report={report} viewerEmail={user?.email} />)
})
