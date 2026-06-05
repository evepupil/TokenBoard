import { describe, expect, test } from 'vitest'
import type { DailyTokenReport } from './adapters'
import {
  prepareDailyReportHistoryShare,
  saveDailyReportHistory
} from './report-history'

describe('daily report history saving', () => {
  test('saves a daily report history snapshot with an upsert key', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = statementDb({ statements, bindings })

    await saveDailyReportHistory({
      db,
      userId: 'user_1',
      report: sampleReport(),
      scheduleSlot: '2026-04-29T18:00',
      generatedAt: new Date('2026-04-29T10:00:00.000Z')
    })

    expect(statements[0]).toContain('INSERT INTO daily_report_history')
    expect(statements[0]).toContain('ON CONFLICT(user_id, report_date, schedule_slot) DO NOTHING')
    expect(normalizeSql(statements[0])).toContain('RETURNING id,')
    expect(bindings[0][1]).toBe('user_1')
    expect(bindings[0][2]).toBe('2026-04-29')
    expect(bindings[0][3]).toBe('2026-04-29T18:00')
    expect(bindings[0][12]).toBe(JSON.stringify(sampleReport().sourceSplit))
    expect(bindings[0][13]).toBe(JSON.stringify(sampleReport().topModels))
    expect(bindings[0][14]).toBeNull()
    expect(bindings[0][15]).toBe('2026-04-29T10:00:00.000Z')
  })

  test('returns the saved share id and report URL', async () => {
    const db = statementDb({})

    const saved = await saveDailyReportHistory({
      db,
      userId: 'user_1',
      report: sampleReport(),
      scheduleSlot: '2026-04-29T18:00',
      generatedAt: new Date('2026-04-29T10:00:00.000Z'),
      origin: 'https://tokenboard.example.com'
    })

    expect(saved.id).toMatch(/^drr_/)
    expect(saved.reportUrl).toBe(`https://tokenboard.example.com/reports/daily/${saved.id}`)
  })

  test('saves a new daily report history row with one write', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = statementDb({ statements, bindings })

    const saved = await saveDailyReportHistory({
      db,
      userId: 'user_1',
      report: sampleReport(),
      scheduleSlot: '2026-04-29T18:00',
      generatedAt: new Date('2026-04-29T10:00:00.000Z'),
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      origin: 'https://tokenboard.example.com'
    })

    expect(statements).toHaveLength(1)
    expect(bindings[0][0]).toBe('drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(saved).toEqual({
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reportUrl: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      isNew: true,
      shareRevokedAt: null
    })
  })

  test('updates an existing row only when saving after a successful delivery', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = statementDb({
      statements,
      bindings,
      insertReturningRow: null,
      updateReturningRow: {
        id: 'drr_dddddddddddddddddddddddddddddddd',
        shareRevokedAt: '2026-04-30T00:00:00.000Z'
      }
    })

    const saved = await saveDailyReportHistory({
      db,
      userId: 'user_1',
      report: sampleReport(),
      scheduleSlot: '2026-04-29T18:00',
      generatedAt: new Date('2026-04-29T10:00:00.000Z'),
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      origin: 'https://tokenboard.example.com'
    })

    expect(statements).toHaveLength(2)
    expect(statements[1]).toContain('UPDATE daily_report_history')
    expect(bindings[1]).toContain('user_1')
    expect(saved.isNew).toBe(false)
    expect(saved.shareRevokedAt).toBe('2026-04-30T00:00:00.000Z')
  })

  test('prepares an existing share without updating its snapshot', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = statementDb({
      statements,
      bindings,
      insertReturningRow: null,
      shareReturningRow: {
        id: 'drr_dddddddddddddddddddddddddddddddd',
        shareRevokedAt: null
      }
    })

    const share = await prepareDailyReportHistoryShare({
      db,
      userId: 'user_1',
      report: sampleReport(),
      scheduleSlot: '2026-04-29T18:00',
      generatedAt: new Date('2026-04-29T10:00:00.000Z'),
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      origin: 'https://tokenboard.example.com'
    })

    expect(statements).toHaveLength(2)
    expect(statements[1]).toContain('FROM daily_report_history')
    expect(statements[1]).not.toContain('UPDATE daily_report_history')
    expect(bindings[1]).toEqual(['user_1', '2026-04-29', '2026-04-29T18:00'])
    expect(share).toEqual({
      id: 'drr_dddddddddddddddddddddddddddddddd',
      reportUrl: 'https://tokenboard.example.com/reports/daily/drr_dddddddddddddddddddddddddddddddd',
      isNew: false,
      shareRevokedAt: null
    })
  })

  test('prepares a new share with one insert', async () => {
    const statements: string[] = []
    const db = statementDb({ statements })

    const share = await prepareDailyReportHistoryShare({
      db,
      userId: 'user_1',
      report: sampleReport(),
      scheduleSlot: '2026-04-29T18:00',
      generatedAt: new Date('2026-04-29T10:00:00.000Z'),
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      origin: 'https://tokenboard.example.com'
    })

    expect(statements).toHaveLength(1)
    expect(share.isNew).toBe(true)
  })
})

function sampleReport(): DailyTokenReport {
  return {
    displayName: 'Example',
    reportDate: '2026-04-29',
    timezone: 'Asia/Shanghai',
    dashboardUrl: 'https://tokenboard.example.com/dashboard',
    totalTokens: 1200,
    totalTokensWithoutCacheRead: 900,
    cacheReadRate: 0.25,
    costUsd: 1.23,
    sessionCount: 4,
    sourceSplit: [{
      source: 'codex',
      totalTokens: 1200,
      totalTokensWithoutCacheRead: 900,
      cacheReadRate: 0.25
    }],
    topModels: [{
      model: 'gpt-5',
      totalTokens: 1200,
      totalTokensWithoutCacheRead: 900,
      cacheReadRate: 0.25,
      costUsd: 1.23
    }]
  }
}

function statementDb(input: {
  statements?: string[]
  bindings?: unknown[][]
  insertReturningRow?: Record<string, unknown> | null
  updateReturningRow?: Record<string, unknown> | null
  shareReturningRow?: Record<string, unknown> | null
}) {
  return {
    prepare(sql: string) {
      input.statements?.push(sql)
      return {
        bind(...values: unknown[]) {
          input.bindings?.push(values)
          return {
            async first() {
              if (sql.includes('INSERT INTO daily_report_history')) {
                if ('insertReturningRow' in input) return input.insertReturningRow ?? null
                return { id: values[0], isNew: 1, shareRevokedAt: null }
              }
              if (sql.includes('UPDATE daily_report_history')) {
                return input.updateReturningRow ?? null
              }
              if (sql.includes('FROM daily_report_history')) {
                return input.shareReturningRow ?? null
              }
              return null
            }
          }
        }
      }
    }
  } as unknown as D1Database
}

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, ' ').trim()
}
