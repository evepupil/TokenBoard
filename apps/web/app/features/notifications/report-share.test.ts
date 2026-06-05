import { describe, expect, test } from 'vitest'
import { ApiError } from '../../lib/errors'
import {
  getDailyReportHistoryById,
  getDailyReportShareSettings,
  isDailyReportId,
  revokeDailyReportShare,
  updateDailyReportShareSettings
} from './report-share'

describe('daily report sharing', () => {
  test('recognizes generated daily report ids only', () => {
    expect(isDailyReportId('drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true)
    expect(isDailyReportId('drr_1')).toBe(false)
  })

  test('reads a shared history row by id when anonymous access is allowed', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = statementDb({
      statements,
      bindings,
      rows: [historyRow()]
    })

    const report = await getDailyReportHistoryById({
      db,
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      retentionDays: 7,
      now: new Date('2026-04-30T00:00:00.000Z')
    })

    expect(statements[0]).toContain('FROM daily_report_history')
    expect(statements[0]).toContain('profiles.daily_report_share_enabled = 1')
    expect(statements[0]).toContain('daily_report_history.share_revoked_at IS NULL')
    expect(bindings[0]).toEqual(['drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-04-24', null])
    expect(report?.id).toBe('drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(report?.displayName).toBe('Example')
  })

  test('does not read a report outside the retention window', async () => {
    const db = statementDb({
      rows: [{
        ...historyRow(),
        reportDate: '2026-04-23'
      }]
    })

    const report = await getDailyReportHistoryById({
      db,
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      retentionDays: 7,
      now: new Date('2026-04-30T00:00:00.000Z')
    })

    expect(report).toBeNull()
  })

  test('does not let the owner read a report outside the retention window', async () => {
    const db = statementDb({
      rows: [{
        ...historyRow(),
        ownerUserId: 'user_1',
        reportDate: '2026-04-23',
        shareEnabled: 0,
        shareRevokedAt: '2026-04-30T00:00:00.000Z'
      }]
    })

    const report = await getDailyReportHistoryById({
      db,
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      viewerUserId: 'user_1',
      retentionDays: 7,
      now: new Date('2026-04-30T00:00:00.000Z')
    })

    expect(report).toBeNull()
  })

  test('lets the owner read a private history row by id', async () => {
    const db = statementDb({
      rows: [{
        ...historyRow(),
        ownerUserId: 'user_1',
        shareEnabled: 0,
        shareRevokedAt: '2026-04-30T00:00:00.000Z'
      }]
    })

    const report = await getDailyReportHistoryById({
      db,
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      viewerUserId: 'user_1',
      retentionDays: 7,
      now: new Date('2026-04-30T00:00:00.000Z')
    })

    expect(report?.id).toBe('drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  test('does not expose a shared report when user sharing is disabled', async () => {
    const db = statementDb({
      rows: [{
        ...historyRow(),
        shareEnabled: 0,
        shareRevokedAt: null
      }]
    })

    const report = await getDailyReportHistoryById({ db, id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })

    expect(report).toBeNull()
  })

  test('does not expose a shared report after that report is revoked', async () => {
    const db = statementDb({
      rows: [{
        ...historyRow(),
        shareEnabled: 1,
        shareRevokedAt: '2026-04-30T00:00:00.000Z'
      }]
    })

    const report = await getDailyReportHistoryById({ db, id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })

    expect(report).toBeNull()
  })

  test('reads daily report share settings for a user', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = statementDb({
      statements,
      bindings,
      rows: [{ dailyReportShareEnabled: 0 }]
    })

    const settings = await getDailyReportShareSettings({ db, userId: 'user_1' })

    expect(statements[0]).toContain('daily_report_share_enabled')
    expect(statements[0]).toContain('FROM profiles')
    expect(bindings[0]).toEqual(['user_1'])
    expect(settings).toEqual({ dailyReportShareEnabled: false })
  })

  test('updates daily report share settings for the owner', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = statementDb({ statements, bindings })

    await updateDailyReportShareSettings({
      db,
      userId: 'user_1',
      enabled: true,
      now: '2026-04-30T00:00:00.000Z'
    })

    expect(statements[0]).toContain('UPDATE profiles')
    expect(bindings[0]).toEqual([1, '2026-04-30T00:00:00.000Z', 'user_1'])
  })

  test('fails share settings updates when the profile row is missing', async () => {
    const db = statementDb({ changes: 0 })

    await expect(updateDailyReportShareSettings({
      db,
      userId: 'user_1',
      enabled: true,
      now: '2026-04-30T00:00:00.000Z'
    })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Profile not found',
      status: 404
    } satisfies Partial<ApiError>)
  })

  test('revokes a single report share for the owner', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = statementDb({ statements, bindings })

    await revokeDailyReportShare({
      db,
      userId: 'user_1',
      reportId: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      now: '2026-04-30T00:00:00.000Z'
    })

    expect(statements[0]).toContain('UPDATE daily_report_history')
    expect(statements[0]).toContain('WHERE user_id = ?')
    expect(statements[0]).toContain('AND share_revoked_at IS NULL')
    expect(bindings[0]).toEqual([
      '2026-04-30T00:00:00.000Z',
      '2026-04-30T00:00:00.000Z',
      'user_1',
      'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ])
  })

  test('fails single report share revocation when the report is not owned by the user or already revoked', async () => {
    const db = statementDb({ changes: 0 })

    await expect(revokeDailyReportShare({
      db,
      userId: 'user_1',
      reportId: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      now: '2026-04-30T00:00:00.000Z'
    })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Daily report not found',
      status: 404
    } satisfies Partial<ApiError>)
  })
})

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
    sourceSplit: JSON.stringify([{
      source: 'codex',
      totalTokens: 1200,
      totalTokensWithoutCacheRead: 900,
      cacheReadRate: 0.25
    }]),
    topModels: JSON.stringify([{
      model: 'gpt-5',
      totalTokens: 1200,
      totalTokensWithoutCacheRead: 900,
      cacheReadRate: 0.25,
      costUsd: 1.23
    }]),
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
  changes?: number
}) {
  return {
    prepare(sql: string) {
      input.statements?.push(sql)
      return {
        bind(...values: unknown[]) {
          input.bindings?.push(values)
          return {
            async run() {
              return { meta: { changes: input.changes ?? 1 } }
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
