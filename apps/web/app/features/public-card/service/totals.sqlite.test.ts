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
