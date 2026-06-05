import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { listDailyReportHistory, saveDailyReportHistory } from './report-history'

const migrationsDir = join(process.cwd(), 'db/migrations')

describe('daily report history sqlite contract', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('persists new and existing rows through real sqlite RETURNING statements', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-report-history-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'report-history.db')
    runSql(dbPath, [
      readMigration('0000_initial.sql'),
      readMigration('0003_better_auth.sql'),
      readMigration('0015_daily_report_history.sql'),
      readMigration('0020_daily_report_share_controls.sql')
    ].join('\n'))
    seedUserAndProfile(dbPath)
    const db = createSqliteD1(dbPath)

    const created = await saveDailyReportHistory({
      db,
      userId: 'user_1',
      report: report(1200),
      scheduleSlot: '2026-04-29T18:00',
      generatedAt: new Date('2026-04-29T10:00:00.000Z'),
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      origin: 'https://tokenboard.example.com'
    })

    const updated = await saveDailyReportHistory({
      db,
      userId: 'user_1',
      report: report(1500),
      scheduleSlot: '2026-04-29T18:00',
      generatedAt: new Date('2026-04-29T11:00:00.000Z'),
      id: 'drr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      origin: 'https://tokenboard.example.com'
    })

    expect(created).toEqual({
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reportUrl: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      isNew: true,
      shareRevokedAt: null
    })
    expect(updated).toEqual({
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reportUrl: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      isNew: false,
      shareRevokedAt: null
    })

    const row = await db
      .prepare('SELECT id, total_tokens as totalTokens, generated_at as generatedAt FROM daily_report_history')
      .bind()
      .first<{ id: string; totalTokens: number; generatedAt: string }>()
    expect(row).toEqual({
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      totalTokens: 1500,
      generatedAt: '2026-04-29T11:00:00.000Z'
    })

    const history = await listDailyReportHistory({
      db,
      userId: 'user_1',
      limit: 1
    })

    expect(history[0]?.sourceSplit[0]).toEqual({
      source: 'codex',
      totalTokens: 1500,
      totalTokensWithoutCacheRead: 1400,
      cacheReadRate: 100 / 1500
    })
    expect(history[0]?.topModels[0]).toEqual({
      model: 'gpt-5',
      totalTokens: 1500,
      totalTokensWithoutCacheRead: 1400,
      cacheReadRate: 100 / 1500,
      costUsd: 1.23
    })
  })
})

function readMigration(name: string) {
  return readFileSync(join(migrationsDir, name), 'utf8')
}

function seedUserAndProfile(dbPath: string) {
  runSql(dbPath, [
    "INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('user_1', 'user@example.com', 1, '2026-04-29T00:00:00.000Z', '2026-04-29T00:00:00.000Z');",
    "INSERT INTO profiles (user_id, slug, display_name, created_at, updated_at) VALUES ('user_1', 'example', 'Example', '2026-04-29T00:00:00.000Z', '2026-04-29T00:00:00.000Z');"
  ].join('\n'))
}

function report(totalTokens: number) {
  return {
    displayName: 'Example',
    reportDate: '2026-04-29',
    timezone: 'Asia/Shanghai',
    dashboardUrl: 'https://tokenboard.example.com/dashboard',
    totalTokens,
    totalTokensWithoutCacheRead: totalTokens - 100,
    cacheReadRate: 100 / totalTokens,
    costUsd: 1.23,
    sessionCount: 4,
    sourceSplit: [{
      source: 'codex',
      totalTokens,
      totalTokensWithoutCacheRead: totalTokens - 100,
      cacheReadRate: 100 / totalTokens
    }],
    topModels: [{
      model: 'gpt-5',
      totalTokens,
      totalTokensWithoutCacheRead: totalTokens - 100,
      cacheReadRate: 100 / totalTokens,
      costUsd: 1.23
    }]
  }
}
