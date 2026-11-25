import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { prepareSummaryRefresh, prepareUserTotalFromSummaryRefresh } from './repository/refresh'
import { findExistingSnapshotHashes } from './repository/snapshot-hashes'

const migrationsDir = resolve(import.meta.dirname, '../../../db/migrations')
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()

describe('snapshot hash query plan', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('row-value IN hits the logical key index and returns the same hashes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-snapshot-hash-plan-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    runSql(
      dbPath,
      migrationFiles.map((file) => `.read '${join(migrationsDir, file).replaceAll("'", "''")}'`).join('\n')
    )
    const db = createSqliteD1(dbPath)
    await db
      .prepare(
        `INSERT INTO users (id, email, name, image, created_at, updated_at, email_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind('snapshot-user', null, 'Snapshot User', null, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 0)
      .run()
    await db
      .prepare(
        `INSERT INTO usage_summary_backfill_state (id, phase, completed_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind('initial', 'totals', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')
      .run()
    await db
      .prepare(
        `INSERT INTO daily_usage (
           user_id, device_id, source, usage_date, timezone, model,
           input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
           total_tokens, cost_usd, session_count, snapshot_hash, synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        'snapshot-user',
        'dev_1',
        'codex',
        '2026-11-25',
        'UTC',
        'gpt-5',
        100,
        50,
        0,
        0,
        150,
        1,
        1,
        'hash-1',
        '2026-11-25T00:00:00.000Z'
      )
      .run()
    const key = { userId: 'snapshot-user', usageDate: '2026-11-25', source: 'codex' as const, model: 'gpt-5' }
    await prepareSummaryRefresh(db, key).run()
    await prepareUserTotalFromSummaryRefresh(db, 'snapshot-user').run()

    const plan = runSql(
      dbPath,
      `EXPLAIN QUERY PLAN
       SELECT source, usage_date, model, snapshot_hash
       FROM daily_usage
       WHERE user_id = 'snapshot-user'
         AND device_id = 'dev_1'
         AND snapshot_hash IS NOT NULL
         AND (source, usage_date, model) IN (VALUES ('codex', '2026-11-25', 'gpt-5'));`
    )
    expect(plan).toContain('daily_usage_logical_key_device_idx')

    const result = await findExistingSnapshotHashes(db, {
      userId: 'snapshot-user',
      deviceId: 'dev_1',
      keys: [
        { source: 'codex', usageDate: '2026-11-25', model: 'gpt-5' },
        { source: 'codex', usageDate: '2026-11-24', model: 'gpt-5' }
      ]
    })

    expect(result).toEqual([{ source: 'codex', usageDate: '2026-11-25', model: 'gpt-5', snapshotHash: 'hash-1' }])
  })
})
