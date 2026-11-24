import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../../test/sqlite-d1'
import { getPublicTotals } from './totals'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations')

// The public card is served to anonymous viewers, so one public account must not be able to make
// it fail for everyone. `SUM()` over integer token columns throws "integer overflow" past int64,
// and a public account can build that sum deliberately (each row is capped at 1e12 tokens, so
// ~9.2M rows reach it). `total()` accumulates in floating point and cannot overflow; this runs
// the real statement against the real schema and proves the plain SUM failure mode is real.
describe('getPublicTotals integer overflow', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('totals built from rows that overflow int64 still return', async () => {
    const { path, db } = createDb(tempDirs)

    // Two rows at int64 max: their integer sum is exactly one past what `SUM()` can hold.
    expect(() => runSql(path, 'SELECT SUM(total_tokens) FROM daily_usage')).toThrow(/integer overflow/)

    const totals = await getPublicTotals({
      db,
      userId: 'seed-user',
      today: '2026-05-15',
      monthStart: '2026-05-01',
      summaryStrict: false,
      includeBreakdown: true,
      includeSourceSplit: true
    })

    expect(totals).not.toBeNull()
    expect(Number(totals?.totalTokens)).toBeGreaterThan(9e18)
    expect(Number.isFinite(Number(totals?.totalTokens))).toBe(true)
    expect(Number(totals?.totalTokensWithoutCacheRead)).toBeGreaterThan(9e18)
    // The month window and its per-source breakdown sum the same rows and must survive too.
    expect(Number(totals?.monthTokens)).toBeGreaterThan(9e18)
    expect(String(totals?.sourceSplit)).toContain('claude-code')
  })
})

function createDb(tempDirs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-public-totals-overflow-'))
  tempDirs.push(dir)
  const path = join(dir, 'totals.sqlite')
  runSql(
    path,
    readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => `.read ${join(migrationsDir, file)}`)
      .join('\n')
  )
  // The int64 maximum is not something the ingest API accepts; it stands in for the ~9.2M capped
  // rows an uploader would need to reach the same sum.
  runSql(
    path,
    `
    INSERT INTO users (id, email, name, image, created_at, updated_at)
    VALUES ('seed-user', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO profiles (user_id, slug, display_name, timezone, timezone_source, is_public, participates_in_leaderboards, created_at, updated_at)
    VALUES ('seed-user', 'seed', 'seed', 'UTC', 'user', 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO daily_usage (
      user_id, device_id, source, usage_date, timezone, model,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      total_tokens, cost_usd, session_count, snapshot_hash, synced_at
    ) VALUES
      ('seed-user', 'device-1', 'claude-code', '2026-05-10', 'UTC', 'model-a', 0, 0, 0, 0, 9223372036854775807, 0, 1, 'hash-a', '2026-05-10T00:00:00Z'),
      ('seed-user', 'device-2', 'claude-code', '2026-05-11', 'UTC', 'model-b', 0, 0, 0, 0, 9223372036854775807, 0, 1, 'hash-b', '2026-05-11T00:00:00Z');
  `
  )
  return { path, db: createSqliteD1(path) }
}

// `dataUpdatedAt` is what the README card's optional freshness stamp prints, so the two
// effective_totals branches must each name the instant their numbers come from: the rollup
// row's own stamp in branch A, the newest summary row in branch B. A branch that silently
// stops producing the column would blank the stamp (or, worse, leave it to the other
// branch's value) and no other test would notice — the service tests stub the whole row.
describe('getPublicTotals dataUpdatedAt', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function totalsFor(db: D1Database) {
    return getPublicTotals({
      db,
      userId: 'seed-user',
      today: '2026-05-15',
      monthStart: '2026-05-01',
      summaryStrict: false,
      includeBreakdown: false,
      includeSourceSplit: false
    })
  }

  test('branch A: the rollup stamp wins while no summary row is newer', async () => {
    const { path, db } = seed(
      tempDirs,
      `
      INSERT INTO user_usage_totals (user_id, total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at)
      VALUES ('seed-user', 100, 100, 1.5, 1, '2026-05-12T08:00:00.000Z');
      INSERT INTO daily_usage_summary (
        user_id, usage_date, source, model, timezone, total_tokens, total_tokens_without_cache_read, cost_usd, updated_at
      ) VALUES ('seed-user', '2026-05-10', 'claude-code', 'model-a', 'UTC', 100, 100, 1.5, '2026-05-11T08:00:00.000Z');
      `
    )
    expect(path).toBeTruthy()

    const totals = await totalsFor(db)
    expect(Number(totals?.totalTokens)).toBe(100)
    expect(totals?.dataUpdatedAt).toBe('2026-05-12T08:00:00.000Z')
  })

  test('branch B: the newest summary stamp is used when it overrides the rollup', async () => {
    const { db } = seed(
      tempDirs,
      `
      INSERT INTO user_usage_totals (user_id, total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at)
      VALUES ('seed-user', 100, 100, 1.5, 1, '2026-05-12T08:00:00.000Z');
      INSERT INTO daily_usage_summary (
        user_id, usage_date, source, model, timezone, total_tokens, total_tokens_without_cache_read, cost_usd, updated_at
      ) VALUES
        ('seed-user', '2026-05-10', 'claude-code', 'model-a', 'UTC', 60, 60, 0.9, '2026-05-13T09:00:00.000Z'),
        ('seed-user', '2026-05-11', 'codex', 'model-b', 'UTC', 40, 40, 0.6, '2026-05-13T09:30:00.000Z');
      `
    )

    const totals = await totalsFor(db)
    expect(Number(totals?.totalTokens)).toBe(100)
    // The newest of the two summary rows, not their sum and not the older rollup stamp.
    expect(totals?.dataUpdatedAt).toBe('2026-05-13T09:30:00.000Z')
  })

  test('no rows at all yields a null stamp rather than a fabricated time', async () => {
    const { db } = seed(tempDirs, '')

    const totals = await totalsFor(db)
    expect(Number(totals?.totalTokens)).toBe(0)
    expect(totals?.dataUpdatedAt ?? null).toBeNull()
  })
})

function seed(tempDirs: string[], dataSql: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-public-totals-stamp-'))
  tempDirs.push(dir)
  const path = join(dir, 'totals.sqlite')
  runSql(
    path,
    readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => `.read ${join(migrationsDir, file)}`)
      .join('\n')
  )
  runSql(
    path,
    `
    INSERT INTO users (id, email, name, image, created_at, updated_at)
    VALUES ('seed-user', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO profiles (user_id, slug, display_name, timezone, timezone_source, is_public, participates_in_leaderboards, created_at, updated_at)
    VALUES ('seed-user', 'seed', 'seed', 'UTC', 'user', 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    ${dataSql}
  `
  )
  return { path, db: createSqliteD1(path) }
}
