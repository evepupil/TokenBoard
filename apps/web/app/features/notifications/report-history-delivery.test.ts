import { describe, expect, test } from 'vitest'
import {
  canSendDailyReportLink,
  cleanupNewDailyReportHistoryShare
} from './report-history-delivery'

describe('daily report history delivery helpers', () => {
  test('sends report links to webhooks only when the URL is absolute HTTPS', () => {
    const subscription = { dailyReportShareEnabled: true }

    expect(canSendDailyReportLink(subscription, {
      reportUrl: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shareRevokedAt: null
    })).toBe(true)
    expect(canSendDailyReportLink(subscription, {
      reportUrl: '/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shareRevokedAt: null
    })).toBe(false)
    expect(canSendDailyReportLink(subscription, {
      reportUrl: 'http://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shareRevokedAt: null
    })).toBe(false)
    expect(canSendDailyReportLink({ dailyReportShareEnabled: false }, {
      reportUrl: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shareRevokedAt: null
    })).toBe(false)
    expect(canSendDailyReportLink(subscription, {
      reportUrl: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shareRevokedAt: '2026-04-30T00:00:00.000Z'
    })).toBe(false)
  })

  test('deletes only unused prewritten report history rows during cleanup', async () => {
    let statementSql = ''
    let statementBindings: unknown[] = []
    const db = {
      prepare(sql: string) {
        statementSql = sql
        return {
          bind(...values: unknown[]) {
            statementBindings = values
            return {
              async run() {
                return { meta: { changes: 0 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await cleanupNewDailyReportHistoryShare({
      env: { DB: db } as never,
      subscription: { id: 'sub_1', userId: 'user_1' } as never,
      share: {
        id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reportUrl: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        isNew: true,
        shareRevokedAt: null
      }
    })

    expect(statementSql).toContain('DELETE FROM daily_report_history')
    expect(statementSql).toContain('NOT EXISTS')
    expect(statementSql).toContain('FROM webhook_delivery_logs')
    expect(statementSql).toContain("webhook_delivery_logs.status = 'success'")
    expect(statementBindings).toEqual(['user_1', 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
  })

  test('does not delete existing report history rows during cleanup', async () => {
    let prepareCalled = false
    const db = {
      prepare() {
        prepareCalled = true
        throw new Error('cleanup should not run')
      }
    } as unknown as D1Database

    await cleanupNewDailyReportHistoryShare({
      env: { DB: db } as never,
      subscription: { id: 'sub_1', userId: 'user_1' } as never,
      share: {
        id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reportUrl: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        isNew: false,
        shareRevokedAt: null
      }
    })

    expect(prepareCalled).toBe(false)
  })
})
