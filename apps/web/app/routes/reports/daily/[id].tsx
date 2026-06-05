import { createRoute } from 'honox/factory'
import { getOptionalUser } from '../../../features/auth/middleware'
import {
  getDailyReportHistoryById,
  isDailyReportId
} from '../../../features/notifications/report-share'
import { dailyReportHistoryRetentionDays } from '../../../features/notifications/report-history'
import { MissingDailyReportPage, SharedDailyReportPage } from '../../../features/notifications/report-page'

export const GET = createRoute(async (c) => {
  c.header('Cache-Control', 'no-store')
  c.header('X-Robots-Tag', 'noindex, nofollow')
  const params = c.req.param() as Record<string, string | undefined>
  const id = params.id ?? ''
  if (!isDailyReportId(id)) {
    c.status(404)
    return c.render(<MissingDailyReportPage />)
  }

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
