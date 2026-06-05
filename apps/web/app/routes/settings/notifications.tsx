import { createRoute } from 'honox/factory'
import { requireUser } from '../../features/auth/middleware'
import { NotificationsPage } from '../../features/notifications/components'
import {
  dailyReportHistoryRetentionDays,
  listDailyReportHistory
} from '../../features/notifications/report-history'
import { getDailyReportShareSettings } from '../../features/notifications/report-share'
import { scheduleTimeSlotCount } from '../../features/notifications/schedule-fields'
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  hasValidEncryptionKey,
  listWebhookSubscriptions,
  parseDailyReportId,
  parseWebhookAction,
  parseWebhookCreateForm,
  parseWebhookId,
  parseWebhookUpdateForm,
  revokeDailyReportShare,
  sendWebhookTest,
  setWebhookSubscriptionEnabled,
  updateDailyReportShareSettings,
  updateWebhookSubscription
} from '../../features/notifications/service'
import { getCanonicalPublicOrigin, getProfileSettings } from '../../features/settings/service'
import { jsonError } from '../../lib/http'

export { NotificationsPage }

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const publicOrigin = getCanonicalPublicOrigin({
    configuredOrigin: c.env.BETTER_AUTH_URL,
    requestOrigin: new URL(c.req.url).origin
  })
  const reportHistoryRetentionDays = dailyReportHistoryRetentionDays(c.env)
  const [profile, subscriptions, reportHistory, shareSettings] = await Promise.all([
    getProfileSettings(c.env.DB, user.id, publicOrigin),
    listWebhookSubscriptions(c.env.DB, user.id),
    listDailyReportHistory({
      db: c.env.DB,
      userId: user.id,
      limit: reportHistoryRetentionDays * scheduleTimeSlotCount
    }),
    getDailyReportShareSettings({
      db: c.env.DB,
      userId: user.id
    })
  ])

  return c.render(
    <NotificationsPage
      email={user.email}
      timezone={profile.timezone}
      subscriptions={subscriptions}
      reportHistory={reportHistory}
      dailyReportShareEnabled={shareSettings.dailyReportShareEnabled}
      reportHistoryRetentionDays={reportHistoryRetentionDays}
      saved={c.req.query('saved') === '1'}
      tested={c.req.query('tested') === '1'}
      testFailed={c.req.query('testFailed') === '1'}
      encryptionConfigured={hasValidEncryptionKey(c.env)}
    />
  )
})

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const form = await c.req.parseBody({ all: true })
    const action = parseWebhookAction(form)

    if (action === 'update-share-settings') {
      await updateDailyReportShareSettings({
        db: c.env.DB,
        userId: user.id,
        enabled: form.dailyReportShareEnabled === 'on'
      })
      return c.redirect('/settings/notifications?saved=1', 303)
    }

    if (action === 'revoke-report-share') {
      await revokeDailyReportShare({
        db: c.env.DB,
        userId: user.id,
        reportId: parseDailyReportId(form)
      })
      return c.redirect('/settings/notifications?saved=1', 303)
    }

    const subscriptionId = parseWebhookId(form)

    if (action === 'create') {
      await createWebhookSubscription({
        env: c.env,
        userId: user.id,
        form: parseWebhookCreateForm(form)
      })
      return c.redirect('/settings/notifications?saved=1', 303)
    }

    if (action === 'update') {
      await updateWebhookSubscription({
        env: c.env,
        userId: user.id,
        subscriptionId,
        form: parseWebhookUpdateForm(form)
      })
      return c.redirect('/settings/notifications?saved=1', 303)
    }

    if (action === 'enable' || action === 'disable') {
      await setWebhookSubscriptionEnabled({
        db: c.env.DB,
        userId: user.id,
        subscriptionId,
        enabled: action === 'enable'
      })
      return c.redirect('/settings/notifications?saved=1', 303)
    }

    if (action === 'delete') {
      await deleteWebhookSubscription({
        db: c.env.DB,
        userId: user.id,
        subscriptionId
      })
      return c.redirect('/settings/notifications?saved=1', 303)
    }

    if (action === 'test') {
      const result = await sendWebhookTest({
        env: c.env,
        userId: user.id,
        subscriptionId
      })
      if (result.status !== 'success') {
        return c.redirect('/settings/notifications?testFailed=1', 303)
      }
      return c.redirect('/settings/notifications?tested=1', 303)
    }

    return c.redirect('/settings/notifications', 303)
  } catch (error) {
    return jsonError(c, error)
  }
})
