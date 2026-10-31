import { describe, expect, test, vi } from 'vitest'
import { encryptSecret } from './crypto'
import type { DailyTokenReport } from './adapters'
import type { DueWebhookSubscription } from './queries'
import { sendWebhookRequest } from './webhook-client'

const testEncryptionKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='

describe('webhook client', () => {
  test('calls injected fetchers with the global context', async () => {
    const encryptedUrl = await encryptSecret(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      testEncryptionKey
    )
    const fetchCalls: Array<{ url: string; body: string }> = []
    const thisSensitiveFetch = vi.fn(function (this: unknown, url: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.')
      }
      fetchCalls.push({ url: String(url), body: String(init?.body) })
      return Promise.resolve(new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 }))
    }) as typeof fetch

    const response = await sendWebhookRequest({
      env: { DB: {} as D1Database, WEBHOOK_ENCRYPTION_KEY: testEncryptionKey },
      subscription: subscriptionRow(encryptedUrl, 'wecom'),
      report: dailyReport(),
      now: new Date('2026-04-29T01:30:00.000Z'),
      fetcher: thisSensitiveFetch
    })

    expect(response.status).toBe(200)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test')
    expect(fetchCalls[0].body).toContain('## Example token 日报')
    expect(fetchCalls[0].body).toContain('2026-04-29 / Asia/Shanghai')
  })

  // The provider host and path are pinned, so a 3xx can only be a redirect away from the verified
  // endpoint — following it would replay the payload (and DingTalk's signature) to wherever it
  // points. Every other outbound request in this worker is `manual` for the same reason.
  test('does not follow provider redirects', async () => {
    const encryptedUrl = await encryptSecret(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      testEncryptionKey
    )
    let seenRedirect: RequestRedirect | undefined
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenRedirect = init?.redirect
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    }) as typeof fetch

    await sendWebhookRequest({
      env: { DB: {} as D1Database, WEBHOOK_ENCRYPTION_KEY: testEncryptionKey },
      subscription: subscriptionRow(encryptedUrl, 'wecom'),
      report: dailyReport(),
      now: new Date('2026-04-29T01:30:00.000Z'),
      fetcher
    })

    expect(seenRedirect).toBe('manual')
  })

  test('rejects Feishu business failures returned with HTTP 200', async () => {
    const encryptedUrl = await encryptSecret('https://open.feishu.cn/open-apis/bot/v2/hook/test', testEncryptionKey)

    await expect(
      sendWebhookRequest({
        env: { DB: {} as D1Database, WEBHOOK_ENCRYPTION_KEY: testEncryptionKey },
        subscription: subscriptionRow(encryptedUrl, 'feishu'),
        report: dailyReport(),
        now: new Date('2026-04-29T01:30:00.000Z'),
        fetcher: async () =>
          new Response(
            JSON.stringify({
              StatusCode: 19021,
              StatusMessage: 'invalid signature'
            }),
            { status: 200 }
          )
      })
    ).rejects.toThrow('Webhook returned application code 19021: invalid signature')
  })

  test('accepts Feishu zero business status', async () => {
    const encryptedUrl = await encryptSecret('https://open.feishu.cn/open-apis/bot/v2/hook/test', testEncryptionKey)

    const response = await sendWebhookRequest({
      env: { DB: {} as D1Database, WEBHOOK_ENCRYPTION_KEY: testEncryptionKey },
      subscription: subscriptionRow(encryptedUrl, 'feishu'),
      report: dailyReport(),
      now: new Date('2026-04-29T01:30:00.000Z'),
      fetcher: async () =>
        new Response(
          JSON.stringify({
            StatusCode: 0,
            StatusMessage: 'success'
          }),
          { status: 200 }
        )
    })

    expect(response.status).toBe(200)
  })

  test('accepts DingTalk string zero business status', async () => {
    const encryptedUrl = await encryptSecret(
      'https://oapi.dingtalk.com/robot/send?access_token=test',
      testEncryptionKey
    )

    const response = await sendWebhookRequest({
      env: { DB: {} as D1Database, WEBHOOK_ENCRYPTION_KEY: testEncryptionKey },
      subscription: subscriptionRow(encryptedUrl, 'dingtalk'),
      report: dailyReport(),
      now: new Date('2026-04-29T01:30:00.000Z'),
      fetcher: async () =>
        new Response(
          JSON.stringify({
            errcode: '0',
            errmsg: 'ok'
          }),
          { status: 200 }
        )
    })

    expect(response.status).toBe(200)
  })

  test('rejects non-JSON provider responses returned with HTTP 200', async () => {
    const encryptedUrl = await encryptSecret(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      testEncryptionKey
    )

    await expect(
      sendWebhookRequest({
        env: { DB: {} as D1Database, WEBHOOK_ENCRYPTION_KEY: testEncryptionKey },
        subscription: subscriptionRow(encryptedUrl, 'wecom'),
        report: dailyReport(),
        now: new Date('2026-04-29T01:30:00.000Z'),
        fetcher: async () => new Response('ok', { status: 200 })
      })
    ).rejects.toThrow('Webhook returned non-JSON response')
  })

  test('rejects DingTalk string business failures returned with HTTP 200', async () => {
    const encryptedUrl = await encryptSecret(
      'https://oapi.dingtalk.com/robot/send?access_token=test',
      testEncryptionKey
    )

    await expect(
      sendWebhookRequest({
        env: { DB: {} as D1Database, WEBHOOK_ENCRYPTION_KEY: testEncryptionKey },
        subscription: subscriptionRow(encryptedUrl, 'dingtalk'),
        report: dailyReport(),
        now: new Date('2026-04-29T01:30:00.000Z'),
        fetcher: async () =>
          new Response(
            JSON.stringify({
              errcode: '310000',
              errmsg: 'sign not match'
            }),
            { status: 200 }
          )
      })
    ).rejects.toThrow('Webhook returned application code 310000: sign not match')
  })

  test('bounds failed provider response text in webhook errors', async () => {
    const encryptedUrl = await encryptSecret(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      testEncryptionKey
    )
    const tailMarker = 'tail-marker'
    const response = new Response(`${'x'.repeat(10_000)}${tailMarker}`, { status: 500 })

    let error: Error | null = null
    try {
      await sendWebhookRequest({
        env: { DB: {} as D1Database, WEBHOOK_ENCRYPTION_KEY: testEncryptionKey },
        subscription: subscriptionRow(encryptedUrl, 'wecom'),
        report: dailyReport(),
        now: new Date('2026-04-29T01:30:00.000Z'),
        fetcher: async () => response
      })
    } catch (caught) {
      if (caught instanceof Error) error = caught
    }

    if (!error) throw new Error('Expected webhook request to fail')
    expect(error.message).toMatch(/^Webhook returned 500: x+\.\.\.\[truncated\]$/)
    expect(error.message).not.toContain(tailMarker)
  })

  // A body whose length lands exactly on the 4096-byte cap is complete; the suffix must not be
  // appended, or the log would claim text was dropped when none was.
  test('does not mark a response that ends exactly on the cap as truncated', async () => {
    const encryptedUrl = await encryptSecret(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      testEncryptionKey
    )
    const body = 'y'.repeat(4096)
    const response = new Response(body, { status: 500 })

    let error: Error | null = null
    try {
      await sendWebhookRequest({
        env: { DB: {} as D1Database, WEBHOOK_ENCRYPTION_KEY: testEncryptionKey },
        subscription: subscriptionRow(encryptedUrl, 'wecom'),
        report: dailyReport(),
        now: new Date('2026-04-29T01:30:00.000Z'),
        fetcher: async () => response
      })
    } catch (caught) {
      if (caught instanceof Error) error = caught
    }

    if (!error) throw new Error('Expected webhook request to fail')
    expect(error.message).toBe(`Webhook returned 500: ${body}`)
    expect(error.message).not.toContain('[truncated]')
  })

  test('rejects decrypted webhook URLs outside the selected provider allowlist before fetch', async () => {
    const encryptedUrl = await encryptSecret('https://example.com/webhook', testEncryptionKey)
    let called = false

    await expect(
      sendWebhookRequest({
        env: { DB: {} as D1Database, WEBHOOK_ENCRYPTION_KEY: testEncryptionKey },
        subscription: subscriptionRow(encryptedUrl, 'wecom'),
        report: dailyReport(),
        now: new Date('2026-04-29T01:30:00.000Z'),
        fetcher: async () => {
          called = true
          return new Response('{}', { status: 200 })
        }
      })
    ).rejects.toThrow('Webhook URL host or path is not supported')
    expect(called).toBe(false)
  })
})

function dailyReport(): DailyTokenReport {
  return {
    displayName: 'Example',
    reportDate: '2026-04-29',
    timezone: 'Asia/Shanghai',
    dashboardUrl: 'https://tokenboard.example.com/leaderboards',
    totalTokens: 100,
    totalTokensWithoutCacheRead: 80,
    cacheReadRate: 0.2,
    costUsd: 0.1,
    sessionCount: 1,
    sourceSplit: [],
    topModels: []
  }
}

function subscriptionRow(encryptedUrl: string, provider: DueWebhookSubscription['provider']): DueWebhookSubscription {
  return {
    id: 'sub_1',
    userId: 'user_1',
    displayName: 'Example',
    dailyReportShareEnabled: false,
    name: '日报',
    provider,
    webhookUrlEncrypted: encryptedUrl,
    webhookUrlHost: 'open.feishu.cn',
    webhookUrlMasked: 'open.feishu.cn/...',
    signingSecretEncrypted: null,
    timezone: 'Asia/Shanghai',
    scheduleTimeLocal: '09:30',
    scheduleTimesLocal: ['09:30'],
    scheduleWeekdays: [0, 1, 2, 3, 4, 5, 6],
    sendEmptyReport: false,
    enabled: true,
    nextRunAt: '2026-04-29T01:30:00.000Z',
    pendingReportDate: null,
    pendingScheduleSlot: null,
    lockedAt: null,
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
}
