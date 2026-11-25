import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UsageSource } from '@tokenboard/usage-core'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { prepareSummaryRefresh, prepareUserTotalFromSummaryRefresh } from './repository/refresh'

const migrationsDir = resolve(import.meta.dirname, '../../../db/migrations')
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()

// Both refresh statements used to write on every call. The value-equality guards keep an
// unchanged row's `updated_at` in place, which is what the public-card cache key and the
// "recently synced" freshness check read. These tests pin both directions: unchanged stays put,
// changed still advances and updates the stored values.
describe('summary and totals refresh guards', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('unchanged summary values keep updated_at and changed values advance it', async () => {
    const db = await createGuardDb(tempDirs)
    const key: { userId: string; usageDate: string; source: UsageSource; model: string } = {
      userId: 'guard-user',
      usageDate: '2026-11-25',
      source: 'codex',
      model: 'gpt-5'
    }
    await insertUsage(db, key, 1000)
    await prepareSummaryRefresh(db, key).run()
    await setUpdatedAt(db, 'daily_usage_summary', `updated_at = '2000-01-01T00:00:00.000Z'`)

    await prepareSummaryRefresh(db, key).run()

    await expectScalar(db, `SELECT updated_at FROM daily_usage_summary`, '2000-01-01T00:00:00.000Z')

    await db
      .prepare(
        `UPDATE daily_usage
         SET input_tokens = 600, output_tokens = 400, total_tokens = 1200
         WHERE user_id = ? AND device_id = ? AND source = ? AND usage_date = ? AND model = ?`
      )
      .bind(key.userId, 'dev_1', key.source, key.usageDate, key.model)
      .run()
    await prepareSummaryRefresh(db, key).run()

    await expectScalar(db, `SELECT total_tokens FROM daily_usage_summary`, 1200)
    const advanced = await scalar(db, `SELECT updated_at FROM daily_usage_summary`)
    expect(advanced).not.toBe('2000-01-01T00:00:00.000Z')
  })

  test('unchanged totals keep updated_at and changed totals advance it', async () => {
    const db = await createGuardDb(tempDirs)
    const key: { userId: string; usageDate: string; source: UsageSource; model: string } = {
      userId: 'guard-user',
      usageDate: '2026-11-25',
      source: 'codex',
      model: 'gpt-5'
    }
    await insertUsage(db, key, 1000)
    await prepareSummaryRefresh(db, key).run()
    await prepareUserTotalFromSummaryRefresh(db, key.userId).run()
    await setUpdatedAt(db, 'user_usage_totals', `updated_at = '2000-01-01T00:00:00.000Z'`)

    await prepareUserTotalFromSummaryRefresh(db, key.userId).run()

    await expectScalar(db, `SELECT updated_at FROM user_usage_totals`, '2000-01-01T00:00:00.000Z')

    await db
      .prepare(
        `UPDATE daily_usage
         SET input_tokens = 600, output_tokens = 400, total_tokens = 1200
         WHERE user_id = ? AND device_id = ? AND source = ? AND usage_date = ? AND model = ?`
      )
      .bind(key.userId, 'dev_1', key.source, key.usageDate, key.model)
      .run()
    await prepareSummaryRefresh(db, key).run()
    await prepareUserTotalFromSummaryRefresh(db, key.userId).run()

    await expectScalar(db, `SELECT total_tokens FROM user_usage_totals`, 1200)
    const advanced = await scalar(db, `SELECT updated_at FROM user_usage_totals`)
    expect(advanced).not.toBe('2000-01-01T00:00:00.000Z')
  })
})

async function createGuardDb(tempDirs: string[]) {
  const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-refresh-guards-'))
  tempDirs.push(tempDir)
  const dbPath = join(tempDir, 'tokenboard.db')
  runSql(dbPath, migrationFiles.map((file) => `.read '${join(migrationsDir, file).replaceAll("'", "''")}'`).join('\n'))
  const db = createSqliteD1(dbPath)
  await db
    .prepare(
      `INSERT INTO users (id, email, name, image, created_at, updated_at, email_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind('guard-user', null, 'Guard User', null, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 0)
    .run()
  await db
    .prepare(
      `INSERT INTO usage_summary_backfill_state (id, phase, completed_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind('initial', 'totals', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')
    .run()
  return db
}

async function insertUsage(
  db: D1Database,
  key: { userId: string; usageDate: string; source: UsageSource; model: string },
  totalTokens: number
) {
  await db
    .prepare(
      `INSERT INTO daily_usage (
         user_id, device_id, source, usage_date, timezone, model,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         total_tokens, cost_usd, session_count, snapshot_hash, synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      key.userId,
      'dev_1',
      key.source,
      key.usageDate,
      'UTC',
      key.model,
      totalTokens - 300,
      300,
      0,
      0,
      totalTokens,
      1.25,
      1,
      null,
      '2026-11-25T00:00:00.000Z'
    )
    .run()
}

async function setUpdatedAt(db: D1Database, table: 'daily_usage_summary' | 'user_usage_totals', assignment: string) {
  await db.prepare(`UPDATE ${table} SET ${assignment}`).bind().run()
}

async function expectScalar(db: D1Database, sql: string, expected: unknown) {
  expect(await scalar(db, sql)).toBe(expected)
}

async function scalar(db: D1Database, sql: string) {
  const rows = await db.prepare(sql).bind().all<Record<string, unknown>>()
  const row = rows.results?.[0]
  return row ? Object.values(row)[0] : undefined
}
