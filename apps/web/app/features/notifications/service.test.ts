import { describe, expect, test, vi } from 'vitest'
import { encryptSecret } from './crypto'
import {
  createWebhookSubscription,
  parseDailyReportId,
  parseWebhookUpdateForm,
  runDueWebhookNotifications,
  sendWebhookTest,
  setWebhookSubscriptionEnabled,
  updateWebhookSubscription
} from './service'
import type { DueWebhookSubscription } from './queries'

const testEncryptionKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='

describe('notification service', () => {
  test('parses only valid daily report share ids', () => {
    expect(parseDailyReportId({
      reportId: ' drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa '
    })).toBe('drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

    expect(() => parseDailyReportId({ reportId: 'drr_1' })).toThrow('Invalid daily report id')
  })

  test('rejects update forms with more schedule times than the settings UI supports', () => {
    expect(() =>
      parseWebhookUpdateForm({
        name: '日报',
        timezone: 'Asia/Shanghai',
        'scheduleTimesLocal[]': ['00:00', '06:00', '12:00', '18:00', '23:00'],
        'scheduleWeekdays[]': ['1'],
        scheduleWeekdaysTouched: '1',
        enabled: 'on'
      })
    ).toThrow('Invalid schedule time')
  })

  test('creates a subscription with encrypted URL and a masked display value', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return {}
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await createWebhookSubscription({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: testEncryptionKey
      },
      userId: 'user_1',
      form: {
        name: '日报',
        provider: 'wecom',
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef',
        timezone: 'Asia/Shanghai',
        scheduleTimeLocal: '09:30',
        scheduleTimesLocal: ['09:30', '18:00'],
        scheduleWeekdays: [1, 2, 3, 4, 5],
        sendEmptyReport: false,
        enabled: true
      },
      now: new Date('2026-04-29T00:00:00.000Z')
    })

    expect(statements[0]).toContain('INSERT INTO webhook_subscriptions')
    expect(bindings[0][4]).not.toContain('abcdef')
    expect(bindings[0][5]).toBe('qyapi.weixin.qq.com')
    expect(bindings[0][6]).toBe('qyapi.weixin.qq.com/...')
    expect(bindings[0][10]).toBe('09:30,18:00')
    expect(bindings[0][11]).toBe('1,2,3,4,5')
    expect(bindings[0][14]).toBe('2026-04-29T01:30:00.000Z')
  })

  test('creates a subscription using the next same-day schedule time', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return {}
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await createWebhookSubscription({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: testEncryptionKey
      },
      userId: 'user_1',
      form: {
        name: '日报',
        provider: 'wecom',
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef',
        timezone: 'Asia/Shanghai',
        scheduleTimeLocal: '09:30',
        scheduleTimesLocal: ['09:30', '18:00'],
        scheduleWeekdays: [0, 1, 2, 3, 4, 5, 6],
        sendEmptyReport: false,
        enabled: true
      },
      now: new Date('2026-04-29T02:00:00.000Z')
    })

    expect(bindings[0][14]).toBe('2026-04-29T10:00:00.000Z')
  })

  test('rejects unsupported webhook hosts before storing secrets', async () => {
    const db = {
      prepare() {
        throw new Error('should not write')
      }
    } as unknown as D1Database

    await expect(createWebhookSubscription({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: testEncryptionKey
      },
      userId: 'user_1',
      form: {
        name: 'bad',
        provider: 'wecom',
        webhookUrl: 'https://example.com/webhook',
        timezone: 'UTC',
        scheduleTimeLocal: '09:30',
        scheduleTimesLocal: ['09:30'],
        scheduleWeekdays: [0, 1, 2, 3, 4, 5, 6],
        sendEmptyReport: false,
        enabled: true
      }
    })).rejects.toThrow('Webhook URL host or path is not supported')
  })

  test('returns failure for failed test sends', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return dueSubscriptionRow(encryptedUrl, { dailyReportShareEnabled: false })
                }
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await sendWebhookTest({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com',
        TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
      },
      userId: 'user_1',
      subscriptionId: 'sub_1',
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async () => new Response('provider failed', { status: 500 })
    })

    expect(result).toEqual({ status: 'failure' })
    expect(statements.some((sql) => sql.includes('last_failure_at') && !sql.includes('pending_report_date'))).toBe(true)
    expect(bindings.flat()).toContain('Webhook returned 500: provider failed')
  })

  test('uses a this-safe default fetcher for test webhook delivery', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const fetchCalls: Array<{ url: string; body: string }> = []
    const statements: string[] = []
    const bindings: unknown[][] = []
    const originalFetch = globalThis.fetch
    const thisSensitiveFetch = function (
      this: unknown,
      url: RequestInfo | URL,
      init?: RequestInit
    ) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.')
      }
      fetchCalls.push({ url: String(url), body: String(init?.body) })
      return Promise.resolve(new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 }))
    } as typeof fetch
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return dueSubscriptionRow(encryptedUrl, {
                    lastError: 'Illegal invocation: function called with incorrect `this` reference.'
                  })
                }
                if (sql.includes('INSERT INTO daily_report_history')) return testReportShareRow()
                if (sql.includes('sessionCount')) return reportTotalsRow()
                return null
              },
              async all() {
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      vi.stubGlobal('fetch', thisSensitiveFetch)

      const result = await sendWebhookTest({
        env: {
          DB: db,
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com',
          TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
        },
        userId: 'user_1',
        subscriptionId: 'sub_1',
        now: new Date('2026-04-29T01:31:00.000Z')
      })

      expect(result).toEqual({ status: 'success' })
      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0].url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef')
      expect(fetchCalls[0].body).toContain('## 测试预览：Example token 日报')
      expect(fetchCalls[0].body).toContain('2026-04-29 / Asia/Shanghai')
      expect(fetchCalls[0].body).toContain('https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      expect(statements.some((sql) => sql.includes('INSERT INTO daily_report_history'))).toBe(true)
      expect(bindings.some((values) => values.includes('test-preview'))).toBe(true)
      expect(statements.some((sql) => sql.includes('last_success_at') && sql.includes('last_error = NULL'))).toBe(true)
      expect(bindings.flat()).toContain('2026-04-29T01:31:00.000Z')
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  test('links test webhook deliveries to public leaderboards when report sharing is disabled', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const fetchCalls: Array<{ url: string; body: string }> = []
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return dueSubscriptionRow(encryptedUrl, { dailyReportShareEnabled: false })
                }
                if (sql.includes('sessionCount')) return reportTotalsRow()
                return null
              },
              async all() {
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await sendWebhookTest({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com',
        TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
      },
      userId: 'user_1',
      subscriptionId: 'sub_1',
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async (url, init) => {
        fetchCalls.push({ url: String(url), body: String(init?.body) })
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      }
    })

    expect(result).toEqual({ status: 'success' })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].body).toContain('[查看排行榜](https://tokenboard.example.com/leaderboards)')
    expect(fetchCalls[0].body).not.toContain('/dashboard')
    expect(fetchCalls[0].body).not.toContain('/reports/daily/')
    expect(statements.some((sql) => sql.includes('INSERT INTO daily_report_history'))).toBe(false)
    expect(bindings.some((values) => values.includes('test-preview'))).toBe(false)
  })

  test('redacts webhook secrets before persisting delivery failures', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return dueSubscriptionRow(encryptedUrl, { dailyReportShareEnabled: false })
                }
                if (sql.includes('sessionCount')) return reportTotalsRow()
                return null
              },
              async all() {
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await sendWebhookTest({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com',
        TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
      },
      userId: 'user_1',
      subscriptionId: 'sub_1',
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async () => new Response(
        [
          'provider failed',
          'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef',
          'https://oapi.dingtalk.com/robot/send?access_token=dingtalk-secret&sign=dingtalk-signature',
          'https://open.feishu.cn/open-apis/bot/v2/hook/feishu-secret'
        ].join(' '),
        { status: 500 }
      )
    })
    const persisted = bindings.flat().map(String).join('\n')

    expect(result).toEqual({ status: 'failure' })
    expect(persisted).toContain('Webhook returned 500: provider failed')
    expect(persisted).toContain('key=[redacted]')
    expect(persisted).toContain('access_token=[redacted]')
    expect(persisted).toContain('sign=[redacted]')
    expect(persisted).toContain('/open-apis/bot/v2/hook/[redacted]')
    expect(persisted).not.toContain('abcdef')
    expect(persisted).not.toContain('dingtalk-secret')
    expect(persisted).not.toContain('dingtalk-signature')
    expect(persisted).not.toContain('feishu-secret')
  })

  test('sends due daily report once and schedules the next local run', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const reportDateBindings: unknown[][] = []
    const fetchCalls: Array<{ url: string; body: string; signal: unknown }> = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            if (sql.includes('usage_date = ?')) reportDateBindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com',
        TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async (url, init) => {
        fetchCalls.push({ url: String(url), body: String(init?.body), signal: init?.signal })
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      }
    })

    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef')
    expect(fetchCalls[0].body).toContain('## Example token 日报')
    expect(fetchCalls[0].body).toContain('2026-04-29 / Asia/Shanghai')
    expect(fetchCalls[0].body).toContain('缓存率 25%')
    expect(fetchCalls[0].body).toContain('https://tokenboard.example.com/reports/daily/drr_')
    expect(fetchCalls[0].body).not.toContain('[查看排行榜](https://tokenboard.example.com/leaderboards)')
    expect(fetchCalls[0].signal).toBeInstanceOf(AbortSignal)
    expect(statements.some((sql) => sql.includes('INSERT INTO webhook_delivery_logs'))).toBe(true)
    expect(statements.some((sql) => sql.includes('INSERT INTO daily_report_history'))).toBe(true)
    expect(statements.some((sql) => sql.includes('DELETE FROM daily_report_history WHERE user_id = ? AND report_date < ?'))).toBe(true)
    expect(statements.some((sql) => sql.includes('last_success_at'))).toBe(true)
    expect(statements.some((sql) => sql.includes('locked_until = ?'))).toBe(true)
    expect(statements.some((sql) => sql.includes('last_success_at') && sql.includes('locked_at = ?'))).toBe(true)
    expect(bindings.some((values) => values.includes('2026-04-23'))).toBe(true)
    expect(bindings.some((values) => values.includes('user_1') && values.includes('2026-04-29'))).toBe(true)
    expect(reportDateBindings).toEqual([
      ['user_1', '2026-04-29', 'user_1', '2026-04-29']
    ])
    expect(historyJsonValues(bindings)).toEqual({
      sourceSplit: [
        { source: 'codex', totalTokens: 1200, totalTokensWithoutCacheRead: 900, cacheReadRate: 0.25 }
      ],
      topModels: [
        { model: 'gpt-5', totalTokens: 1200, totalTokensWithoutCacheRead: 900, cacheReadRate: 0.25, costUsd: 1.23 }
      ]
    })
    expect(bindings.some((values) => values.includes('sub_1') && values.includes('2026-04-29T01:31:00.000Z'))).toBe(true)
    expect(bindings.flat()).toContain('2026-04-30T01:30:00.000Z')
  })

  test('uses a this-safe default fetcher for scheduled webhook delivery', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const fetchCalls: Array<{ url: string; body: string }> = []
    const originalFetch = globalThis.fetch
    const thisSensitiveFetch = function (
      this: unknown,
      url: RequestInfo | URL,
      init?: RequestInit
    ) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.')
      }
      fetchCalls.push({ url: String(url), body: String(init?.body) })
      return Promise.resolve(new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 }))
    } as typeof fetch
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      vi.stubGlobal('fetch', thisSensitiveFetch)

      const result = await runDueWebhookNotifications({
        env: {
          DB: withBatch(db),
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com',
          TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
        },
        now: new Date('2026-04-29T01:31:00.000Z')
      })

      expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0].url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef')
      expect(fetchCalls[0].body).toContain('## Example token 日报')
      expect(fetchCalls[0].body).toContain('2026-04-29 / Asia/Shanghai')
      expect(statements.some((sql) => sql.includes('last_success_at'))).toBe(true)
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  test('schedules the next same-day slot from the delivered slot when cron is delayed', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl, {
                      scheduleTimesLocal: ['09:30', '18:00'],
                      nextRunAt: '2026-04-29T01:30:00.000Z'
                    })]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com',
        TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
      },
      now: new Date('2026-04-29T10:01:00.000Z'),
      fetcher: async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    })

    const successLogIndex = statements.findIndex((sql) => sql.includes('INSERT INTO webhook_delivery_logs'))
    const successUpdateIndex = statements.findIndex(
      (sql) => sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_success_at')
    )

    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
    expect(bindings[successLogIndex][4]).toBe('2026-04-29T09:30')
    expect(bindings[successUpdateIndex][0]).toBe('2026-04-29T10:00:00.000Z')
  })

  test('fails a daily cron item when report history retention config is invalid', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const fetchCalls: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: db,
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com',
          TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '32'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async (url) => {
          fetchCalls.push(String(url))
          return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
        }
      })

      expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
      expect(fetchCalls).toHaveLength(0)
      expect(consoleError).not.toHaveBeenCalled()
      expect(statements.some((sql) => sql.includes('INSERT INTO webhook_delivery_logs'))).toBe(true)
      expect(bindings.flat()).toContain('TOKENBOARD_DAILY_REPORT_HISTORY_DAYS must be an integer from 1 to 31')
    } finally {
      consoleError.mockRestore()
    }
  })

  test('keeps the original schedule slot when a daily delivery retries', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async () => new Response('provider failed', { status: 500 })
    })

    const failureUpdateIndex = statements.findIndex(
      (sql) => sql.includes('UPDATE webhook_subscriptions') && sql.includes('pending_schedule_slot = ?')
    )

    expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
    expect(bindings[failureUpdateIndex]).toEqual([
      '2026-04-29T01:36:00.000Z',
      '2026-04-29',
      '2026-04-29T09:30',
      1,
      '2026-04-29T01:31:00.000Z',
      'Webhook returned 500: provider failed',
      '2026-04-29T01:31:00.000Z',
      'sub_1',
      '2026-04-29T01:31:00.000Z'
    ])
  })

  test('clears the original schedule slot after final daily retry exhaustion', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl, {
                      scheduleTimesLocal: ['09:30', '18:00'],
                      pendingReportDate: '2026-04-29',
                      pendingScheduleSlot: '2026-04-29T09:30',
                      failureCount: 2,
                      nextRunAt: '2026-04-29T02:00:00.000Z'
                    })]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T02:01:00.000Z'),
      fetcher: async () => new Response('provider failed', { status: 500 })
    })

    const failureUpdateIndex = statements.findIndex(
      (sql) => sql.includes('UPDATE webhook_subscriptions') && sql.includes('pending_schedule_slot = ?')
    )

    expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
    expect(bindings[failureUpdateIndex]).toEqual([
      '2026-04-29T10:00:00.000Z',
      null,
      null,
      0,
      '2026-04-29T02:01:00.000Z',
      'Webhook returned 500: provider failed',
      '2026-04-29T02:01:00.000Z',
      'sub_1',
      '2026-04-29T02:01:00.000Z'
    ])
  })

  test('preserves the queued next slot after an exhausted pending slot succeeds', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl, {
                      scheduleTimesLocal: ['09:30', '18:00'],
                      pendingReportDate: '2026-04-29',
                      pendingScheduleSlot: '2026-04-29T09:30',
                      failureCount: 0,
                      nextRunAt: '2026-04-29T10:00:00.000Z'
                    })]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com',
        TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
      },
      now: new Date('2026-04-29T10:01:00.000Z'),
      fetcher: async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    })

    const successLogIndex = statements.findIndex((sql) => sql.includes('INSERT INTO webhook_delivery_logs'))
    const successUpdateIndex = statements.findIndex(
      (sql) => sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_success_at')
    )

    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
    expect(bindings[successLogIndex][4]).toBe('2026-04-29T09:30')
    expect(bindings[successUpdateIndex][0]).toBe('2026-04-29T10:00:00.000Z')
  })

  test('clears stale pending state after a final failure and resumes the current schedule', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl, {
                      scheduleTimesLocal: ['09:30', '18:00'],
                      pendingReportDate: '2026-04-29',
                      pendingScheduleSlot: '2026-04-29T09:30',
                      failureCount: 2,
                      nextRunAt: '2026-04-29T02:00:00.000Z'
                    })]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com',
        TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
      },
      now: new Date('2026-04-29T02:01:00.000Z'),
      fetcher: async () => new Response('provider failed', { status: 500 })
    })

    const failureUpdateIndex = statements.findIndex(
      (sql) => sql.includes('UPDATE webhook_subscriptions') && sql.includes('pending_schedule_slot = ?')
    )

    expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
    expect(bindings[failureUpdateIndex]).toEqual([
      '2026-04-29T10:00:00.000Z',
      null,
      null,
      0,
      '2026-04-29T02:01:00.000Z',
      'Webhook returned 500: provider failed',
      '2026-04-29T02:01:00.000Z',
      'sub_1',
      '2026-04-29T02:01:00.000Z'
    ])
  })

  test('final failure advances from the failed slot instead of the delayed cron time', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl, {
                      scheduleTimesLocal: ['09:30', '18:00'],
                      pendingReportDate: '2026-04-29',
                      pendingScheduleSlot: '2026-04-29T09:30',
                      failureCount: 2,
                      nextRunAt: '2026-04-29T02:00:00.000Z'
                    })]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T10:01:00.000Z'),
      fetcher: async () => new Response('provider failed', { status: 500 })
    })

    const failureUpdateIndex = statements.findIndex(
      (sql) => sql.includes('UPDATE webhook_subscriptions') && sql.includes('pending_schedule_slot = ?')
    )

    expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
    expect(bindings[failureUpdateIndex]).toEqual([
      '2026-04-29T10:00:00.000Z',
      null,
      null,
      0,
      '2026-04-29T10:01:00.000Z',
      'Webhook returned 500: provider failed',
      '2026-04-29T10:01:00.000Z',
      'sub_1',
      '2026-04-29T10:01:00.000Z'
    ])
  })

  test.each([
    ['success log write', 'log'],
    ['success state update', 'state']
  ])('does not schedule retry when provider succeeded but %s fails', async (_label, failAt) => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const deliveryStatuses: string[] = []
    const fetchCalls: string[] = []
    let failureUpdateSeen = false
    let successUpdateSeen = false
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO webhook_delivery_logs')) {
                  const status = String(values[6])
                  deliveryStatuses.push(status)
                  if (status === 'success' && failAt === 'log') {
                    throw new Error('success log failed')
                  }
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_success_at')) {
                  successUpdateSeen = true
                  if (failAt === 'state') throw new Error('success state failed')
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_failure_at')) {
                  failureUpdateSeen = true
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: withBatch(db),
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async (url) => {
          fetchCalls.push(String(url))
          return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
        }
      })

      expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
      expect(fetchCalls).toHaveLength(1)
      expect(deliveryStatuses).toContain('success')
      expect(deliveryStatuses).not.toContain('failure')
      expect(failureUpdateSeen).toBe(false)
      if (failAt === 'state') expect(successUpdateSeen).toBe(true)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('success'))
    } finally {
      consoleError.mockRestore()
    }
  })

  test.each([
    ['success log write', 'log'],
    ['success state update', 'state']
  ])('retries success persistence when %s fails once', async (_label, failAt) => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    let successLogAttempts = 0
    let successStateAttempts = 0
    let failureUpdateSeen = false
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO webhook_delivery_logs') && values[6] === 'success') {
                  successLogAttempts += 1
                  if (failAt === 'log' && successLogAttempts === 1) {
                    throw new Error('success log failed once')
                  }
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_success_at')) {
                  successStateAttempts += 1
                  if (failAt === 'state' && successStateAttempts === 1) {
                    throw new Error('success state failed once')
                  }
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_failure_at')) {
                  failureUpdateSeen = true
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    })

    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
    expect(successLogAttempts).toBe(2)
    expect(successStateAttempts).toBe(failAt === 'state' ? 2 : 1)
    expect(failureUpdateSeen).toBe(false)
  })

  test('reports a cron failure when provider succeeded but success persistence never completes', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const deliveryStatuses: string[] = []
    const fetchCalls: string[] = []
    let failureUpdateSeen = false
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO webhook_delivery_logs')) {
                  deliveryStatuses.push(String(values[6]))
                  if (values[6] === 'success') throw new Error('success log unavailable')
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_success_at')) {
                  throw new Error('success state unavailable')
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_failure_at')) {
                  failureUpdateSeen = true
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: withBatch(db),
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async (url) => {
          fetchCalls.push(String(url))
          return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
        }
      })

      expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
      expect(fetchCalls).toHaveLength(1)
      expect(deliveryStatuses).toEqual(['success', 'success', 'success'])
      expect(deliveryStatuses).not.toContain('failure')
      expect(failureUpdateSeen).toBe(false)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('success persistence failed'))
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('cron failed'))
    } finally {
      consoleError.mockRestore()
    }
  })

  test('uses the due schedule date when cron runs after local midnight', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const reportDateBindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql.includes('usage_date = ?')) reportDateBindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl, {
                      nextRunAt: '2026-04-29T15:50:00.000Z',
                      scheduleTimeLocal: '23:50',
                      scheduleTimesLocal: ['23:50']
                    })]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T16:01:00.000Z'),
      fetcher: async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    })

    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
    expect(reportDateBindings).toEqual([
      ['user_1', '2026-04-29', 'user_1', '2026-04-29']
    ])
  })

  test('prunes old webhook delivery logs during the daily prune window', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const pruneBindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql.includes('DELETE FROM webhook_delivery_logs')) pruneBindings.push(values)
            return {
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return { results: [dueSubscriptionRow(encryptedUrl)] }
                }
                return { results: [] }
              },
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return {
                    totalTokens: 0,
                    totalTokensWithoutCacheRead: 0,
                    costUsd: 0,
                    sessionCount: 0
                  }
                }
                return null
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await runDueWebhookNotifications({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com',
        TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS: '7'
      },
      now: new Date('2026-04-29T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    })

    expect(pruneBindings).toEqual([['2026-04-22T00:00:00.000Z']])
  })

  test('skips webhook delivery log pruning outside the daily prune window', async () => {
    const secret = testEncryptionKey
    const pruneBindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql.includes('DELETE FROM webhook_delivery_logs')) pruneBindings.push(values)
            return {
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) return { results: [] }
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com',
        TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS: '7'
      },
      now: new Date('2026-04-29T01:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    })

    expect(result).toEqual({ checked: 0, sent: 0, failed: 0, skipped: 0 })
    expect(pruneBindings).toEqual([])
  })

  test('does not send when another cron worker already claimed the subscription', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 0 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database
    const fetchCalls: string[] = []

    const result = await runDueWebhookNotifications({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async (url) => {
        fetchCalls.push(String(url))
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      }
    })

    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, skipped: 1 })
    expect(fetchCalls).toHaveLength(0)
  })

  test('continues processing due subscriptions after one subscription throws', async () => {
    const secret = testEncryptionKey
    const badEncryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=bad', secret)
    const goodEncryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=good', secret)
    const fetchCalls: Array<{ url: string; body: string; signal: unknown }> = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [
                      dueSubscriptionRow(badEncryptedUrl, { id: 'sub_bad' }),
                      dueSubscriptionRow(goodEncryptedUrl, { id: 'sub_good' })
                    ]
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('UPDATE webhook_subscriptions') && values.includes('sub_bad')) {
                  throw new Error('claim failed')
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: withBatch(db),
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async (url, init) => {
          fetchCalls.push({ url: String(url), body: String(init?.body), signal: init?.signal })
          return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
        }
      })

      expect(result).toEqual({ checked: 2, sent: 1, failed: 1, skipped: 0 })
      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0].url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=good')
      expect(fetchCalls[0].body).toContain('## Example token 日报')
      expect(fetchCalls[0].body).toContain('2026-04-29 / Asia/Shanghai')
      expect(fetchCalls[0].signal).toBeInstanceOf(AbortSignal)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('sub_bad'))
    } finally {
      consoleError.mockRestore()
    }
  })

  test('recomputes next run and clears stale state when re-enabling a subscription', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return dueSubscriptionRow('encrypted-url', {
                    enabled: false,
                    nextRunAt: '2026-04-29T01:30:00.000Z',
                    pendingReportDate: '2026-04-29',
                    pendingScheduleSlot: '2026-04-29T09:30',
                    failureCount: 2,
                    lastError: 'stale failure'
                  })
                }
                return null
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await setWebhookSubscriptionEnabled({
      db,
      userId: 'user_1',
      subscriptionId: 'sub_1',
      enabled: true,
      now: new Date('2026-04-30T02:00:00.000Z')
    })

    const updateSql = statements.find((sql) => sql.includes('UPDATE webhook_subscriptions')) ?? ''
    expect(updateSql).toContain('pending_report_date = NULL')
    expect(updateSql).toContain('pending_schedule_slot = NULL')
    expect(updateSql).toContain('failure_count = CASE')
    expect(updateSql).toContain('last_error = CASE')
    expect(bindings.at(-1)).toEqual([
      1,
      1,
      '2026-05-01T01:30:00.000Z',
      1,
      1,
      '2026-04-30T02:00:00.000Z',
      'user_1',
      'sub_1'
    ])
  })

  test('preserves pending retry state when updating non-schedule subscription fields', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const existing = dueSubscriptionRow('encrypted-url', {
      name: '日报',
      timezone: 'Asia/Shanghai',
      scheduleTimeLocal: '09:30',
      scheduleTimesLocal: ['09:30', '18:00'],
      scheduleWeekdays: [1, 2, 3, 4, 5],
      sendEmptyReport: false,
      enabled: true,
      pendingReportDate: '2026-04-29',
      pendingScheduleSlot: '2026-04-29T09:30',
      lockedAt: '2026-04-29T01:31:00.000Z',
      failureCount: 1,
      nextRunAt: '2026-04-29T01:36:00.000Z'
    })
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_subscriptions')) return existing
                return null
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await updateWebhookSubscription({
      env: { DB: db },
      userId: 'user_1',
      subscriptionId: 'sub_1',
      form: {
        name: '更新后的日报',
        timezone: 'Asia/Shanghai',
        scheduleTimeLocal: '09:30',
        scheduleTimesLocal: ['09:30', '18:00'],
        scheduleWeekdays: [1, 2, 3, 4, 5],
        sendEmptyReport: true,
        enabled: true
      },
      now: new Date('2026-04-29T01:32:00.000Z')
    })

    const updateSql = statements.find((sql) => sql.includes('UPDATE webhook_subscriptions')) ?? ''
    const updateBindings = bindings.at(-1)
    expect(updateSql).toContain('next_run_at = CASE WHEN ? = 1 THEN ? ELSE next_run_at END')
    expect(updateSql).toContain('pending_report_date = CASE WHEN ? = 1 THEN NULL ELSE pending_report_date END')
    expect(updateSql).toContain('pending_schedule_slot = CASE WHEN ? = 1 THEN NULL ELSE pending_schedule_slot END')
    expect(updateBindings).toEqual([
      '更新后的日报',
      'Asia/Shanghai',
      '09:30',
      '09:30,18:00',
      '1,2,3,4,5',
      1,
      1,
      0,
      null,
      0,
      0,
      0,
      0,
      0,
      '2026-04-29T01:32:00.000Z',
      'user_1',
      'sub_1'
    ])
  })

  test('clears pending retry state when updating schedule fields', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const existing = dueSubscriptionRow('encrypted-url', {
      timezone: 'Asia/Shanghai',
      scheduleTimeLocal: '09:30',
      scheduleTimesLocal: ['09:30', '18:00'],
      scheduleWeekdays: [1, 2, 3, 4, 5],
      pendingReportDate: '2026-04-29',
      pendingScheduleSlot: '2026-04-29T09:30',
      lockedAt: '2026-04-29T01:31:00.000Z',
      failureCount: 1,
      nextRunAt: '2026-04-29T01:36:00.000Z'
    })
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_subscriptions')) return existing
                return null
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await updateWebhookSubscription({
      env: { DB: db },
      userId: 'user_1',
      subscriptionId: 'sub_1',
      form: {
        name: '日报',
        timezone: 'Asia/Shanghai',
        scheduleTimeLocal: '18:00',
        scheduleTimesLocal: ['18:00'],
        scheduleWeekdays: [1, 2, 3, 4, 5],
        sendEmptyReport: false,
        enabled: true
      },
      now: new Date('2026-04-29T01:32:00.000Z')
    })

    expect(bindings.at(-1)).toEqual([
      '日报',
      'Asia/Shanghai',
      '18:00',
      '18:00',
      '1,2,3,4,5',
      0,
      1,
      1,
      '2026-04-29T10:00:00.000Z',
      1,
      1,
      1,
      1,
      1,
      '2026-04-29T01:32:00.000Z',
      'user_1',
      'sub_1'
    ])
  })

  test('skips empty daily reports without changing the last success timestamp', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return {
                    totalTokens: 0,
                    totalTokensWithoutCacheRead: 0,
                    costUsd: 0,
                    sessionCount: 0
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database
    const fetchCalls: string[] = []

    const result = await runDueWebhookNotifications({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async (url) => {
        fetchCalls.push(String(url))
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      }
    })

    const updateStatements = statements.filter((sql) => sql.includes('UPDATE webhook_subscriptions'))
    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, skipped: 1 })
    expect(fetchCalls).toHaveLength(0)
    expect(bindings.flat()).toContain('skipped')
    expect(statements.some((sql) => sql.includes('INSERT INTO daily_report_history'))).toBe(false)
    expect(updateStatements.some((sql) => sql.includes('last_success_at'))).toBe(false)
    expect(updateStatements.some((sql) => sql.includes('locked_at = ?'))).toBe(true)
    expect(bindings.some((values) => values.includes('sub_1') && values.includes('2026-04-29T01:31:00.000Z'))).toBe(true)
  })

  test('preserves the queued next slot after an exhausted pending slot is skipped', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return {
                    totalTokens: 0,
                    totalTokensWithoutCacheRead: 0,
                    costUsd: 0,
                    sessionCount: 0
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl, {
                      scheduleTimesLocal: ['09:30', '18:00'],
                      pendingReportDate: '2026-04-29',
                      pendingScheduleSlot: '2026-04-29T09:30',
                      failureCount: 0,
                      nextRunAt: '2026-04-29T10:00:00.000Z'
                    })]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database
    const fetchCalls: string[] = []

    const result = await runDueWebhookNotifications({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T10:01:00.000Z'),
      fetcher: async (url) => {
        fetchCalls.push(String(url))
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      }
    })

    const skippedLogIndex = statements.findIndex((sql) => sql.includes('INSERT INTO webhook_delivery_logs'))
    const skippedUpdateIndex = statements.findIndex(
      (sql) => sql.includes('UPDATE webhook_subscriptions') && sql.includes('pending_schedule_slot = NULL')
    )

    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, skipped: 1 })
    expect(fetchCalls).toHaveLength(0)
    expect(bindings[skippedLogIndex][4]).toBe('2026-04-29T09:30')
    expect(bindings[skippedUpdateIndex][0]).toBe('2026-04-29T10:00:00.000Z')
  })

  test('removes the prewritten daily report history when provider delivery fails', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return { results: [dueSubscriptionRow(encryptedUrl)] }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async () => new Response('provider failed', { status: 500 })
    })

    expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
    expect(statements.some((sql) => sql.includes('INSERT INTO daily_report_history'))).toBe(true)
    expect(statements.some((sql) => sql.includes('DELETE FROM daily_report_history'))).toBe(true)
    expect(bindings.some((values) => (
      values[0] === 'user_1' &&
      typeof values[1] === 'string' &&
      values[1].startsWith('drr_')
    ))).toBe(true)
  })

  test('keeps provider failure state when prewritten report history cleanup fails', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return { results: [dueSubscriptionRow(encryptedUrl)] }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('DELETE FROM daily_report_history')) {
                  throw new Error('cleanup failed')
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: withBatch(db),
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async () => new Response('provider failed', { status: 500 })
      })

      expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
      expect(statements.some((sql) => sql.includes('DELETE FROM daily_report_history'))).toBe(true)
      expect(bindings.flat()).toContain('Webhook returned 500: provider failed')
      expect(bindings.flat()).not.toContain('cleanup failed')
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('history cleanup failed'))
    } finally {
      consoleError.mockRestore()
    }
  })

  test('keeps a successful delivery when old report history pruning fails', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const fetchCalls: string[] = []
    let failureUpdateSeen = false
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return { results: [dueSubscriptionRow(encryptedUrl)] }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('DELETE FROM daily_report_history WHERE user_id = ? AND report_date < ?')) {
                  throw new Error('prune failed')
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_failure_at')) {
                  failureUpdateSeen = true
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: withBatch(db),
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com',
          TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async (url) => {
          fetchCalls.push(String(url))
          return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
        }
      })

      expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
      expect(fetchCalls).toHaveLength(1)
      expect(failureUpdateSeen).toBe(false)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('history prune failed'))
      expect(statements.some((sql) => sql.includes('last_success_at'))).toBe(true)
    } finally {
      consoleError.mockRestore()
    }
  })

  test('does not overwrite an existing daily report history row when another delivery fails', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const fetchBodies: string[] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('INSERT INTO daily_report_history')) {
                  return null
                }
                if (sql.includes('UPDATE daily_report_history')) {
                  throw new Error('should not update history before provider success')
                }
                if (sql.includes('FROM daily_report_history')) {
                  return {
                    id: 'drr_dddddddddddddddddddddddddddddddd',
                    shareRevokedAt: null
                  }
                }
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return reportTotalsRow()
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return { results: [dueSubscriptionRow(encryptedUrl)] }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: withBatch(db, { synthesizeDailyReportInsert: false }),
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async (_url, init) => {
        fetchBodies.push(String(init?.body))
        return new Response('provider failed', { status: 500 })
      }
    })

    expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
    expect(statements.some((sql) => sql.includes('INSERT INTO daily_report_history'))).toBe(true)
    expect(statements.some((sql) => sql.includes('FROM daily_report_history'))).toBe(true)
    expect(statements.some((sql) => sql.includes('UPDATE daily_report_history'))).toBe(false)
    expect(statements.some((sql) => sql.includes('DELETE FROM daily_report_history'))).toBe(false)
    expect(fetchBodies[0]).toContain('https://tokenboard.example.com/reports/daily/drr_dddddddddddddddddddddddddddddddd')
  })

  test('does not record webhook failure when skipped delivery state fails', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const deliveryStatuses: string[] = []
    let failureUpdateSeen = false
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('sessionCount')) {
                  return {
                    totalTokens: 0,
                    totalTokensWithoutCacheRead: 0,
                    costUsd: 0,
                    sessionCount: 0
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO webhook_delivery_logs')) {
                  deliveryStatuses.push(String(values[6]))
                  if (values[6] === 'skipped') throw new Error('skipped log failed')
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_failure_at')) {
                  failureUpdateSeen = true
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: withBatch(db),
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async () => new Response('should not send', { status: 200 })
      })

      expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
      expect(deliveryStatuses).toEqual(['skipped'])
      expect(deliveryStatuses).not.toContain('failure')
      expect(failureUpdateSeen).toBe(false)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('cron failed'))
    } finally {
      consoleError.mockRestore()
    }
  })
})

function dueSubscriptionRow(
  encryptedUrl: string,
  overrides: Partial<DueWebhookSubscription> = {}
): DueWebhookSubscription {
  return {
    id: 'sub_1',
    userId: 'user_1',
    displayName: 'Example',
    dailyReportShareEnabled: true,
    name: '日报',
    provider: 'wecom',
    webhookUrlEncrypted: encryptedUrl,
    webhookUrlHost: 'qyapi.weixin.qq.com',
    webhookUrlMasked: 'qyapi.weixin.qq.com/...',
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
    updatedAt: '2026-04-28T00:00:00.000Z',
    ...overrides
  }
}

function reportTotalsRow() {
  return {
    totalTokens: 1200,
    totalTokensWithoutCacheRead: 900,
    costUsd: 1.23,
    sessionCount: 4,
    sourceSplit: JSON.stringify([
      { source: 'codex', totalTokens: 1200, totalTokensWithoutCacheRead: 900 }
    ]),
    topModels: JSON.stringify([
      { model: 'gpt-5', totalTokens: 1200, totalTokensWithoutCacheRead: 900, costUsd: 1.23 }
    ])
  }
}

function testReportShareRow() {
  return {
    id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shareRevokedAt: null,
    isNew: 1
  }
}

function historyJsonValues(bindings: unknown[][]) {
  const historyBindings = bindings.find((values) =>
    values.includes('https://tokenboard.example.com/leaderboards') &&
    values.includes('2026-04-29T01:31:00.000Z')
  )
  if (!historyBindings) throw new Error('Missing daily report history bindings')
  return {
    sourceSplit: JSON.parse(String(historyBindings[12])),
    topModels: JSON.parse(String(historyBindings[13]))
  }
}

function withBatch(
  db: D1Database,
  options: { synthesizeDailyReportInsert?: boolean } = {}
): D1Database {
  const synthesizeDailyReportInsert = options.synthesizeDailyReportInsert ?? true
  return {
    ...db,
    prepare(sql: string) {
      const statement = db.prepare(sql)
      return {
        ...statement,
        bind(...values: unknown[]) {
          const bound = statement.bind(...values)
          return {
            ...bound,
            async first<T = unknown>(column?: string) {
              const row = await bound.first<T>(column as never)
              if (row || !sql.includes('INSERT INTO daily_report_history')) return row
              if (!synthesizeDailyReportInsert) return row
              return { id: values[0], isNew: 1, shareRevokedAt: null } as T
            }
          }
        }
      }
    },
    batch: async (statements) => {
      const results: D1Result<unknown>[] = []
      for (const statement of statements) {
        results.push(await statement.run())
      }
      return results
    }
  } as D1Database
}
