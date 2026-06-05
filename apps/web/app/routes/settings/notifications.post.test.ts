import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requireUser } from '../../features/auth/middleware'
import {
  revokeDailyReportShare,
  sendWebhookTest,
  updateDailyReportShareSettings
} from '../../features/notifications/service'
import { POST } from './notifications'

vi.mock('../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

vi.mock('../../features/settings/service', () => ({
  getCanonicalPublicOrigin: vi.fn(),
  getProfileSettings: vi.fn()
}))

vi.mock('../../features/notifications/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/notifications/service')>()
  return {
    createWebhookSubscription: vi.fn(),
    deleteWebhookSubscription: vi.fn(),
    hasValidEncryptionKey: vi.fn(),
    listWebhookSubscriptions: vi.fn(),
    parseDailyReportId: actual.parseDailyReportId,
    parseWebhookAction: (form: Record<string, unknown>) => String(form.action ?? ''),
    parseWebhookCreateForm: vi.fn(),
    parseWebhookId: (form: Record<string, unknown>) => String(form.subscriptionId ?? '').trim(),
    parseWebhookUpdateForm: vi.fn(),
    revokeDailyReportShare: vi.fn(),
    sendWebhookTest: vi.fn(),
    setWebhookSubscriptionEnabled: vi.fn(),
    updateDailyReportShareSettings: vi.fn(),
    updateWebhookSubscription: vi.fn()
  }
})

const mockedRequireUser = vi.mocked(requireUser)
const mockedRevokeDailyReportShare = vi.mocked(revokeDailyReportShare)
const mockedSendWebhookTest = vi.mocked(sendWebhookTest)
const mockedUpdateDailyReportShareSettings = vi.mocked(updateDailyReportShareSettings)

describe('notifications POST route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
    mockedRevokeDailyReportShare.mockReset()
    mockedSendWebhookTest.mockReset()
    mockedUpdateDailyReportShareSettings.mockReset()
  })

  test('does not redirect failed webhook tests as sent', async () => {
    const context = postContext({ action: 'test', subscriptionId: 'sub_1' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedSendWebhookTest.mockResolvedValue({ status: 'failure' } as never)

    const response = await POST[0](context as never, async () => undefined) as Response

    expect(mockedSendWebhookTest).toHaveBeenCalledWith({
      env: context.env,
      userId: 'user_1',
      subscriptionId: 'sub_1'
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/notifications?testFailed=1')
  })

  test('redirects successful webhook tests as sent', async () => {
    const context = postContext({ action: 'test', subscriptionId: 'sub_1' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedSendWebhookTest.mockResolvedValue({ status: 'success' } as never)

    const response = await POST[0](context as never, async () => undefined) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/notifications?tested=1')
  })

  test('updates daily report sharing settings', async () => {
    const context = postContext({ action: 'update-share-settings', dailyReportShareEnabled: 'on' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)

    const response = await POST[0](context as never, async () => undefined) as Response

    expect(mockedUpdateDailyReportShareSettings).toHaveBeenCalledWith({
      db: context.env.DB,
      userId: 'user_1',
      enabled: true
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/notifications?saved=1')
  })

  test('revokes a single daily report share link', async () => {
    const context = postContext({ action: 'revoke-report-share', reportId: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)

    const response = await POST[0](context as never, async () => undefined) as Response

    expect(mockedRevokeDailyReportShare).toHaveBeenCalledWith({
      db: context.env.DB,
      userId: 'user_1',
      reportId: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/notifications?saved=1')
  })

  test('rejects an invalid daily report id before revoking a share link', async () => {
    const context = postContext({ action: 'revoke-report-share', reportId: 'drr_1' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)

    const response = await POST[0](context as never, async () => undefined) as Response

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid daily report id'
      }
    })
    expect(mockedRevokeDailyReportShare).not.toHaveBeenCalled()
  })
})

function postContext(body: Record<string, unknown>) {
  return {
    env: { DB: {} },
    req: {
      parseBody: vi.fn(async () => body)
    },
    json: vi.fn((body: unknown, status = 200) => (
      Response.json(body, { status })
    )),
    redirect: vi.fn((location: string, status = 302) => (
      new Response(null, { status, headers: { location } })
    ))
  }
}
