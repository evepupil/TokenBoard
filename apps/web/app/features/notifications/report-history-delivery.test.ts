import { describe, expect, test } from 'vitest'
import {
  canSendDailyReportLink,
  canShareDailyReportLink,
  deleteDailyReportHistoryShare
} from './report-history-delivery'

describe('daily report history delivery helpers', () => {
  test('allows share links only while global sharing is enabled and the report is not revoked', () => {
    expect(canShareDailyReportLink({ dailyReportShareEnabled: true }, { shareRevokedAt: null })).toBe(true)
    expect(canShareDailyReportLink({ dailyReportShareEnabled: false }, { shareRevokedAt: null })).toBe(false)
    expect(canShareDailyReportLink({
      dailyReportShareEnabled: true
    }, {
      shareRevokedAt: '2026-04-30T00:00:00.000Z'
    })).toBe(false)
  })

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

    await deleteDailyReportHistoryShare({
      env: { DB: db } as never,
      userId: 'user_1',
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    })

    expect(statementSql).toContain('DELETE FROM daily_report_history')
    expect(statementSql).toContain('NOT EXISTS')
    expect(statementSql).toContain('FROM webhook_delivery_logs')
    expect(statementSql).toContain("webhook_delivery_logs.status = 'success'")
    expect(statementBindings).toEqual(['user_1', 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
  })
})
