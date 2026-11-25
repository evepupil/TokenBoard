import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { findExistingSnapshotHashes } from './repository/snapshot-hashes'
import { prepareSummaryRefresh, prepareUserTotalFromSummaryRefresh } from './repository/refresh'
import { upsertUsageSnapshots, type IngestRecord } from './repository'

const migrationsDir = resolve(import.meta.dirname, '../../../db/migrations')
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()

describe('incremental totals maintenance', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('matches a full recompute across two uploads with overlapping keys', async () => {
    const db = await createTotalsDb(tempDirs)
    await seedProfile(db, 'incremental-user')
    const first = makeRecord({
      userId: 'incremental-user',
      deviceId: 'dev_1',
      usageDate: '2026-11-24',
      totalTokens: 1000
    })
    const second = makeRecord({
      userId: 'incremental-user',
      deviceId: 'dev_2',
      usageDate: '2026-11-24',
      totalTokens: 2000
    })
    const third = makeRecord({ userId: 'incremental-user', usageDate: '2026-11-25', totalTokens: 500 })

    await upsertUsageSnapshots(db, [first, second])
    await upsertUsageSnapshots(db, [third, { ...second, totalTokens: 2500 }])

    const expected = await fullRecompute(db, 'incremental-user')
    const actual = await totals(db, 'incremental-user')
    expect(actual).toEqual(expected)
  })

  test('initializes totals from all existing summaries when the totals row is missing', async () => {
    const db = await createTotalsDb(tempDirs)
    await seedProfile(db, 'legacy-user')
    const legacy = makeRecord({ userId: 'legacy-user', deviceId: 'legacy', usageDate: '2026-11-20', totalTokens: 700 })
    await insertRawUsage(db, legacy)

    await upsertUsageSnapshots(db, [makeRecord({ userId: 'legacy-user', usageDate: '2026-11-25', totalTokens: 300 })])

    const expected = await fullRecompute(db, 'legacy-user')
    expect(await totals(db, 'legacy-user')).toEqual(expected)
  })

  test('applies deltas to the right user when a batch carries two users', async () => {
    const db = await createTotalsDb(tempDirs)
    await seedProfile(db, 'user-a')
    await seedProfile(db, 'user-b')
    await upsertUsageSnapshots(db, [
      makeRecord({ userId: 'user-a', totalTokens: 1000 }),
      makeRecord({ userId: 'user-b', totalTokens: 2000 })
    ])

    await upsertUsageSnapshots(db, [
      { ...makeRecord({ userId: 'user-a', totalTokens: 1300 }), collectedAt: '2026-11-25T11:00:00.000Z' },
      { ...makeRecord({ userId: 'user-b', totalTokens: 1800 }), collectedAt: '2026-11-25T11:00:00.000Z' }
    ])

    expect((await totals(db, 'user-a')).totalTokens).toBe(1300)
    expect((await totals(db, 'user-b')).totalTokens).toBe(1800)
    expect(await totals(db, 'user-a')).toEqual(await fullRecompute(db, 'user-a'))
    expect(await totals(db, 'user-b')).toEqual(await fullRecompute(db, 'user-b'))
  })

  test('dedupes keys repeated inside one batch before applying deltas', async () => {
    const db = await createTotalsDb(tempDirs)
    await seedProfile(db, 'dup-user')
    await upsertUsageSnapshots(db, [makeRecord({ userId: 'dup-user', totalTokens: 1000 })])

    const duplicate = makeRecord({ userId: 'dup-user', totalTokens: 1400 })
    await upsertUsageSnapshots(db, [duplicate, { ...duplicate }])

    expect((await totals(db, 'dup-user')).totalTokens).toBe(1400)
    expect(await totals(db, 'dup-user')).toEqual(await fullRecompute(db, 'dup-user'))
  })

  test('keeps existing snapshot hashes reported when totals are in sync', async () => {
    const db = await createTotalsDb(tempDirs)
    await seedProfile(db, 'hash-user')
    await upsertUsageSnapshots(db, [makeRecord({ userId: 'hash-user' })])

    const hashes = await findExistingSnapshotHashes(db, {
      userId: 'hash-user',
      deviceId: 'dev_1',
      keys: [{ source: 'codex', usageDate: '2026-11-25', model: 'gpt-5' }]
    })
    expect(hashes).toHaveLength(1)
  })
})

async function createTotalsDb(tempDirs: string[]) {
  const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-totals-delta-'))
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

async function seedProfile(db: D1Database, userId: string) {
  await db
    .prepare(
      `INSERT INTO users (id, email, name, image, created_at, updated_at, email_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, null, userId, null, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 0)
    .run()
}

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    userId: 'totals-user',
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

async function insertRawUsage(db: D1Database, record: IngestRecord) {
  await db
    .prepare(
      `INSERT INTO daily_usage (
         user_id, device_id, source, usage_date, timezone, model,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         total_tokens, cost_usd, session_count, snapshot_hash, synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.userId,
      record.deviceId,
      record.source,
      record.usageDate,
      record.timezone,
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheCreationTokens,
      record.cacheReadTokens,
      record.totalTokens,
      record.costUsd,
      record.sessionCount,
      null,
      record.collectedAt
    )
    .run()
}

async function fullRecompute(db: D1Database, userId: string) {
  const keys = await db
    .prepare(
      `SELECT DISTINCT usage_date as usageDate, source, model
       FROM daily_usage WHERE user_id = ?`
    )
    .bind(userId)
    .all<{ usageDate: string; source: 'codex'; model: string }>()
  for (const key of keys.results ?? []) {
    await prepareSummaryRefresh(db, { userId, ...key }).run()
  }
  await prepareUserTotalFromSummaryRefresh(db, userId).run()
  return totals(db, userId)
}

async function totals(db: D1Database, userId: string) {
  const row = await db
    .prepare(
      'SELECT total_tokens as totalTokens, session_count as sessionCount FROM user_usage_totals WHERE user_id = ?'
    )
    .bind(userId)
    .first<{ totalTokens: number; sessionCount: number }>()
  return { totalTokens: row?.totalTokens ?? 0, sessionCount: row?.sessionCount ?? 0 }
}
