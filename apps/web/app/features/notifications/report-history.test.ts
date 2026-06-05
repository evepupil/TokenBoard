import { describe, expect, test } from 'vitest'
import type { DailyTokenReport } from './adapters'
import {
  dailyReportHistoryRetentionDays,
  listDailyReportHistory,
  pruneExpiredDailyReportHistory,
  retentionCutoffDate
} from './report-history'

describe('daily report history', () => {
  test('uses the default retention when no override is configured', () => {
    expect(dailyReportHistoryRetentionDays({})).toBe(30)
  })

  test.each([
    ['7', 7],
    ['31', 31]
  ])('reads a configured retention value', (value, expected) => {
    expect(dailyReportHistoryRetentionDays({
      TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: value
    })).toBe(expected)
  })

  test.each(['', '0', '32', 'abc', '7.5'])('rejects invalid retention value %s', (value) => {
    expect(() => dailyReportHistoryRetentionDays({
      TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: value
    })).toThrow('TOKENBOARD_DAILY_REPORT_HISTORY_DAYS must be an integer from 1 to 31')
  })

  test('calculates the retention cutoff date including the current day', () => {
    expect(retentionCutoffDate('2026-04-29', 30)).toBe('2026-03-31')
  })

  test('lists history rows and parses stored JSON details', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = statementDb({
      statements,
      bindings,
      rows: [historyRow()]
    })

    const history = await listDailyReportHistory({ db, userId: 'user_1' })

    expect(statements[0]).toContain('ORDER BY generated_at DESC, schedule_slot DESC')
    expect(bindings[0]).toEqual(['user_1', 31])
    expect(history).toHaveLength(1)
    expect(history[0].sourceSplit[0]).toEqual({
      source: 'codex',
      totalTokens: 1200,
      totalTokensWithoutCacheRead: 900,
      cacheReadRate: 0.25
    })
    expect(history[0].scheduleSlot).toBe('2026-04-29T18:00')
    expect(history[0].reportUrl).toBe('/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(history[0].topModels[0].model).toBe('gpt-5')
  })

  test('fails on invalid stored history JSON shape', async () => {
    const db = statementDb({
      rows: [
        {
          id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          displayName: 'Example',
          reportDate: '2026-04-29',
          scheduleSlot: '2026-04-29T18:00',
          timezone: 'Asia/Shanghai',
          dashboardUrl: 'https://tokenboard.example.com/dashboard',
          totalTokens: 1200,
          totalTokensWithoutCacheRead: 900,
          cacheReadRate: 0.25,
          costUsd: 1.23,
          sessionCount: 4,
          sourceSplit: '{}',
          topModels: JSON.stringify(sampleReport().topModels),
          generatedAt: '2026-04-29T10:00:00.000Z',
          updatedAt: '2026-04-29T10:00:00.000Z'
        }
      ]
    })

    await expect(listDailyReportHistory({ db, userId: 'user_1' }))
      .rejects.toThrow('Invalid daily report history source_split')
  })

  test('fails with the same message when stored history JSON is malformed', async () => {
    const db = statementDb({
      rows: [
        {
          id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          displayName: 'Example',
          reportDate: '2026-04-29',
          scheduleSlot: '2026-04-29T18:00',
          timezone: 'Asia/Shanghai',
          dashboardUrl: 'https://tokenboard.example.com/dashboard',
          totalTokens: 1200,
          totalTokensWithoutCacheRead: 900,
          cacheReadRate: 0.25,
          costUsd: 1.23,
          sessionCount: 4,
          sourceSplit: '{',
          topModels: JSON.stringify(sampleReport().topModels),
          generatedAt: '2026-04-29T10:00:00.000Z',
          updatedAt: '2026-04-29T10:00:00.000Z'
        }
      ]
    })

    await expect(listDailyReportHistory({ db, userId: 'user_1' }))
      .rejects.toThrow('Invalid daily report history source_split')
  })

  test('prunes rows older than the configured retention window', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = statementDb({ statements, bindings })

    await pruneExpiredDailyReportHistory({
      db,
      userId: 'user_1',
      reportDate: '2026-04-29',
      retentionDays: 7
    })

    expect(statements[0]).toContain('DELETE FROM daily_report_history WHERE user_id = ? AND report_date < ?')
    expect(bindings[0]).toEqual(['user_1', '2026-04-23'])
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
    sourceSplit: [
      {
        source: 'codex',
        totalTokens: 1200,
        totalTokensWithoutCacheRead: 900,
        cacheReadRate: 0.25
      }
    ],
    topModels: [
      {
        model: 'gpt-5',
        totalTokens: 1200,
        totalTokensWithoutCacheRead: 900,
        cacheReadRate: 0.25,
        costUsd: 1.23
      }
    ]
  }
}

function historyRow() {
  return {
    id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    displayName: 'Example',
    reportDate: '2026-04-29',
    scheduleSlot: '2026-04-29T18:00',
    timezone: 'Asia/Shanghai',
    dashboardUrl: 'https://tokenboard.example.com/dashboard',
    totalTokens: 1200,
    totalTokensWithoutCacheRead: 900,
    cacheReadRate: 0.25,
    costUsd: 1.23,
    sessionCount: 4,
    sourceSplit: JSON.stringify(sampleReport().sourceSplit),
    topModels: JSON.stringify(sampleReport().topModels),
    generatedAt: '2026-04-29T10:00:00.000Z',
    updatedAt: '2026-04-29T10:00:00.000Z',
    shareRevokedAt: null,
    shareEnabled: 1
  }
}

function statementDb(input: {
  statements?: string[]
  bindings?: unknown[][]
  rows?: Array<Record<string, unknown>>
}) {
  return {
    prepare(sql: string) {
      input.statements?.push(sql)
      return {
        bind(...values: unknown[]) {
          input.bindings?.push(values)
          return {
            async run() {
              return { meta: { changes: 1 } }
            },
            async all() {
              return { results: input.rows ?? [] }
            },
            async first() {
              return input.rows?.[0] ?? null
            }
          }
        }
      }
    }
  } as unknown as D1Database
}
