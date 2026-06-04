import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { getDailyTokenReport } from './report-queries'

describe('notification report queries', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('builds a daily report with one strict summary query', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-report-query-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    createSummarySchema(dbPath)
    const db = createSqliteD1(dbPath)

    await seedSummaryRows(db)

    const report = await getDailyTokenReport({
      db,
      userId: 'user_1',
      displayName: 'Example',
      reportDate: '2026-06-02',
      timezone: 'UTC',
      dashboardUrl: 'https://tokenboard.example/dashboard',
      summaryStrict: true
    })

    expect(report).toMatchObject({
      displayName: 'Example',
      reportDate: '2026-06-02',
      totalTokens: 2050,
      totalTokensWithoutCacheRead: 1800,
      cacheReadRate: 250 / 2050,
      costUsd: 3.15,
      sessionCount: 7,
      sourceSplit: [
        {
          source: 'codex',
          totalTokens: 1450,
          totalTokensWithoutCacheRead: 1250,
          cacheReadRate: 200 / 1450
        },
        {
          source: 'claude-code',
          totalTokens: 600,
          totalTokensWithoutCacheRead: 550,
          cacheReadRate: 50 / 600
        }
      ],
      topModels: [
        {
          model: 'gpt-5',
          totalTokens: 1000,
          totalTokensWithoutCacheRead: 900,
          cacheReadRate: 100 / 1000,
          costUsd: 1.25
        },
        {
          model: 'claude-sonnet-4-5',
          totalTokens: 600,
          totalTokensWithoutCacheRead: 550,
          cacheReadRate: 50 / 600,
          costUsd: 1.25
        },
        {
          model: 'gpt-5-mini',
          totalTokens: 450,
          totalTokensWithoutCacheRead: 350,
          cacheReadRate: 100 / 450,
          costUsd: 0.65
        }
      ]
    })
  })
})

function createSummarySchema(dbPath: string) {
  runSql(dbPath, `
    CREATE TABLE daily_usage_summary (
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT NOT NULL,
      timezone TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens_without_cache_read INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, usage_date, source, model)
    );
  `)
}

async function seedSummaryRows(db: D1Database) {
  await db
    .prepare(
      `
        INSERT INTO daily_usage_summary (
          user_id,
          usage_date,
          source,
          model,
          timezone,
          input_tokens,
          output_tokens,
          cache_creation_tokens,
          cache_read_tokens,
          total_tokens,
          total_tokens_without_cache_read,
          cost_usd,
          session_count,
          updated_at
        )
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'user_1',
      '2026-06-02',
      'codex',
      'gpt-5',
      'UTC',
      700,
      200,
      0,
      100,
      1000,
      900,
      1.25,
      3,
      '2026-06-02T10:00:00.000Z',
      'user_1',
      '2026-06-02',
      'claude-code',
      'claude-sonnet-4-5',
      'UTC',
      400,
      150,
      0,
      50,
      600,
      550,
      1.25,
      2,
      '2026-06-02T10:00:00.000Z',
      'user_1',
      '2026-06-02',
      'codex',
      'gpt-5-mini',
      'UTC',
      250,
      100,
      0,
      100,
      450,
      350,
      0.65,
      2,
      '2026-06-02T10:00:00.000Z'
    )
    .run()
}
