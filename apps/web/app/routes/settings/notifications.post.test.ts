import { beforeEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { requireUser } from '../../features/auth/middleware'
import { NotificationFormError } from '../../features/notifications/errors'
import {
  createWebhookSubscription,
  revokeDailyReportShare,
  sendWebhookTest,
  parseWebhookCreateForm,
  updateDailyReportShareSettings
} from '../../features/notifications/service'
import { ApiError } from '../../lib/errors'
import { enforceRateLimit } from '../../lib/rate-limit'
import { POST, notificationFormErrorMessage } from './notifications'

vi.mock('../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

// The form's `test` action sends an outbound webhook request and every action writes D1 rows,
// so a per-user ceiling is applied before the action switch. Without it a signed-in user could
// turn this page into a webhook-test amplifier.
vi.mock('../../lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limit')>()),
  enforceRateLimit: vi.fn()
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
const mockedCreateWebhookSubscription = vi.mocked(createWebhookSubscription)
const mockedParseWebhookCreateForm = vi.mocked(parseWebhookCreateForm)
const mockedRevokeDailyReportShare = vi.mocked(revokeDailyReportShare)
const mockedSendWebhookTest = vi.mocked(sendWebhookTest)
const mockedUpdateDailyReportShareSettings = vi.mocked(updateDailyReportShareSettings)
const mockedEnforceRateLimit = vi.mocked(enforceRateLimit)

describe('notifications POST route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
    mockedCreateWebhookSubscription.mockReset()
    mockedParseWebhookCreateForm.mockReset()
    mockedRevokeDailyReportShare.mockReset()
    mockedSendWebhookTest.mockReset()
    mockedUpdateDailyReportShareSettings.mockReset()
    mockedEnforceRateLimit.mockReset()
  })

  test('rate-limits the form per user before any action runs', async () => {
    const context = postContext({ action: 'test', subscriptionId: 'sub_1' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedEnforceRateLimit.mockRejectedValue(new ApiError('RATE_LIMITED', 'Too many requests', 429))

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(429)
    expect(mockedSendWebhookTest).not.toHaveBeenCalled()
    expect(mockedEnforceRateLimit).toHaveBeenCalledWith(context.env.DB, {
      policy: expect.objectContaining({ id: 'notifications-form' }),
      subject: { kind: 'user', value: 'user_1' }
    })
  })

  test('does not redirect failed webhook tests as sent', async () => {
    const context = postContext({ action: 'test', subscriptionId: 'sub_1' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedSendWebhookTest.mockResolvedValue({ status: 'failure' } as never)

    const response = (await POST[0](context as never, async () => undefined)) as Response

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

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/notifications?tested=1')
  })

  test('updates daily report sharing settings', async () => {
    const context = postContext({ action: 'update-share-settings', dailyReportShareEnabled: 'on' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)

    const response = (await POST[0](context as never, async () => undefined)) as Response

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

    const response = (await POST[0](context as never, async () => undefined)) as Response

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

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/notifications?error=invalid-daily-report-id')
    expect(mockedRevokeDailyReportShare).not.toHaveBeenCalled()
  })

  test('redirects known notification form errors back to the notifications page', async () => {
    const context = postContext({ action: 'create' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedParseWebhookCreateForm.mockReturnValue({ provider: 'wecom' } as never)
    mockedCreateWebhookSubscription.mockRejectedValue(new NotificationFormError('webhook-url-not-supported') as never)

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/notifications?error=webhook-url-not-supported')
    expect(mockedCreateWebhookSubscription).toHaveBeenCalledWith({
      env: context.env,
      userId: 'user_1',
      form: { provider: 'wecom' }
    })
  })

  test('redirects zod form validation errors to generic page feedback', async () => {
    const context = postContext({ action: 'create' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedParseWebhookCreateForm.mockImplementation(() => {
      z.object({ webhookUrl: z.string().url() }).parse({ webhookUrl: 'not-a-url' })
      throw new Error('unreachable')
    })

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/notifications?error=invalid-request')
    expect(mockedCreateWebhookSubscription).not.toHaveBeenCalled()
  })

  test.each([
    // The status code a `requireEncryptionKey` failure carries; its user-facing message is the
    // generic 500 copy, with the WEBHOOK_ENCRYPTION_KEY diagnosis kept for the logs only.
    ['INTERNAL_SERVER_ERROR', 'Internal server error', 500],
    ['NOT_FOUND', 'Webhook subscription not found', 404],
    ['UNAUTHORIZED', 'Authentication required', 401]
  ] as const)('keeps %s errors as JSON responses', async (code, message, status) => {
    const context = postContext({ action: 'create' })
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedParseWebhookCreateForm.mockReturnValue({ provider: 'wecom' } as never)
    mockedCreateWebhookSubscription.mockRejectedValue(new ApiError(code, message, status) as never)

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(status)
    expect(response.headers.get('location')).toBeNull()
    await expect(response.json()).resolves.toEqual({
      error: {
        code,
        message
      }
    })
  })

  test('maps notification form error codes to page feedback copy', () => {
    expect(notificationFormErrorMessage('webhook-url-not-supported')).toBe(
      'Webhook URL host or path is not supported for this provider'
    )
    expect(notificationFormErrorMessage('invalid-daily-report-id')).toBe('Invalid daily report id')
    expect(notificationFormErrorMessage('unknown')).toBeUndefined()
    // A user-controlled `?error=` must not resolve prototype members to a function value.
    for (const key of ['constructor', 'toString', 'valueOf', '__proto__']) {
      expect(notificationFormErrorMessage(key)).toBeUndefined()
    }
  })
})

function postContext(body: Record<string, unknown>) {
  return {
    env: { DB: {} },
    req: {
      parseBody: vi.fn(async () => body)
    },
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status })),
    redirect: vi.fn((location: string, status = 302) => new Response(null, { status, headers: { location } }))
  }
}
