import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { runDailyUsageSelfHeal, dailySelfHealKeyLimit, dailySelfHealUserLimit } from './repository/daily-self-heal'
import { upsertUsageSnapshots, type IngestRecord } from './repository'

const migrationsDir = resolve(import.meta.dirname, '../../../db/migrations')
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()

describe('daily usage self-heal', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('repairs a wrong summary, a wrong totals row, and an orphan summary', async () => {
    const db = await createHealDb(tempDirs)
    await seedUser(db, 'heal-user')
    const record = makeRecord({ userId: 'heal-user' })
    await upsertUsageSnapshots(db, [record])

    await db
      .prepare(`UPDATE daily_usage_summary SET total_tokens = 7, cost_usd = 0 WHERE user_id = ?`)
      .bind('heal-user')
      .run()
    await db
      .prepare(`UPDATE user_usage_totals SET total_tokens = 9, cost_usd = 0 WHERE user_id = ?`)
      .bind('heal-user')
      .run()

    // A summary whose raw row no longer exists must be removed and subtracted from totals.
    await db
      .prepare(
        `INSERT INTO daily_usage_summary (
           user_id, usage_date, source, model, timezone, input_tokens, output_tokens,
           cache_creation_tokens, cache_read_tokens, total_tokens,
           total_tokens_without_cache_read, cost_usd, session_count, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind('heal-user', '2026-11-19', 'codex', 'gpt-5', 'UTC', 10, 10, 0, 0, 20, 20, 1, 1, '2026-11-19T00:00:00.000Z')
      .run()

    const repaired = await drainSelfHeal(db, new Date('2026-11-25T02:00:00.000Z'))

    expect(repaired.summariesHealed).toBeGreaterThan(0)
    expect(repaired.totalsHealed).toBeGreaterThan(0)
    expect(repaired.orphansRemoved).toBe(1)

    const summary = await scalar(db, `SELECT total_tokens FROM daily_usage_summary WHERE user_id = 'heal-user'`)
    expect(summary).toBe(record.totalTokens)
    const totals = await scalar(db, `SELECT total_tokens FROM user_usage_totals WHERE user_id = 'heal-user'`)
    expect(totals).toBe(record.totalTokens)

    const orphan = await scalar(
      db,
      `SELECT COUNT(*) FROM daily_usage_summary WHERE user_id = 'heal-user' AND usage_date = '2026-11-19'`
    )
    expect(orphan).toBe(0)
  })

  test('keeps its own state row and leaves the initial backfill marker alone', async () => {
    const db = await createHealDb(tempDirs)
    await seedUser(db, 'state-user')
    await upsertUsageSnapshots(db, [makeRecord({ userId: 'state-user' })])

    const initialBefore = await scalar(db, `SELECT completed_at FROM usage_summary_backfill_state WHERE id = 'initial'`)
    await drainSelfHeal(db, new Date('2026-11-25T02:00:00.000Z'))

    const initialAfter = await scalar(db, `SELECT completed_at FROM usage_summary_backfill_state WHERE id = 'initial'`)
    expect(initialAfter).toBe(initialBefore)
    expect(await scalar(db, `SELECT phase FROM usage_summary_backfill_state WHERE id = 'daily-self-heal'`)).toBe('done')
  })

  test('is a no-op for the rest of the same day and resets on the next day', async () => {
    const db = await createHealDb(tempDirs)
    await seedUser(db, 'day-user')
    await upsertUsageSnapshots(db, [makeRecord({ userId: 'day-user' })])

    const first = await runDailyUsageSelfHeal({ db, now: new Date('2026-11-25T02:00:00.000Z') })
    expect(first).toEqual({ summariesHealed: 0, totalsHealed: 0, orphansRemoved: 0 })
    // First pass advances to done; the second call in the same day is a no-op.
    const second = await runDailyUsageSelfHeal({ db, now: new Date('2026-11-25T03:00:00.000Z') })
    expect(second).toEqual({ summariesHealed: 0, totalsHealed: 0, orphansRemoved: 0 })

    await db.prepare(`UPDATE daily_usage_summary SET total_tokens = 1 WHERE user_id = 'day-user'`).bind().run()
    const nextDay = await drainSelfHeal(db, new Date('2026-11-26T02:00:00.000Z'))
    expect(nextDay.summariesHealed).toBeGreaterThan(0)
  })
})

async function createHealDb(tempDirs: string[]) {
  const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-daily-heal-'))
  tempDirs.push(tempDir)
  const dbPath = join(tempDir, 'tokenboard.db')
  runSql(dbPath, migrationFiles.map((file) => `.read '${join(migrationsDir, file).replaceAll("'", "''")}'`).join('\n'))
  const db = createSqliteD1(dbPath)
  await db
    .prepare(
      `INSERT INTO usage_summary_backfill_state (id, phase, completed_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind('initial', 'totals', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')
    .run()
  return db
}

async function seedUser(db: D1Database, userId: string) {
  await db
    .prepare(
      `INSERT INTO users (id, email, name, image, created_at, updated_at, email_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, null, userId, null, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 0)
    .run()
}

async function drainSelfHeal(db: D1Database, now: Date) {
  const totals = { summariesHealed: 0, totalsHealed: 0, orphansRemoved: 0 }
  for (let index = 0; index < 20; index += 1) {
    const result = await runDailyUsageSelfHeal({ db, now })
    totals.summariesHealed += result.summariesHealed
    totals.totalsHealed += result.totalsHealed
    totals.orphansRemoved += result.orphansRemoved
    const phase = await scalar(db, `SELECT phase FROM usage_summary_backfill_state WHERE id = 'daily-self-heal'`)
    if (phase === 'done') break
  }
  return totals
}

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    userId: 'heal-user',
    deviceId: 'dev_1',
    source: 'codex',
    usageDate: '2026-11-25',
    timezone: 'UTC',
    model: 'gpt-5',
    inputTokens: 700,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 100,
    totalTokens: 1000,
    costUsd: 1.25,
    sessionCount: 3,
    collectedAt: '2026-11-25T10:00:00.000Z',
    ...overrides
  }
}

async function scalar(db: D1Database, sql: string) {
  const row = await db.prepare(sql).bind().first<Record<string, unknown>>()
  return row ? Object.values(row)[0] : undefined
}
