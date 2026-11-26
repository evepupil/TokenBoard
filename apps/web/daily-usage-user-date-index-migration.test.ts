import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runSqliteScript } from './app/test/sqlite-script'

const migrationsDir = resolve(import.meta.dirname, 'db/migrations')
const indexMigrationFile = '0041_drop_daily_usage_user_date_index.sql'

// `daily_usage_user_date_idx(user_id, usage_date)` is a strict prefix of
// `daily_usage_logical_key_device_idx(user_id, usage_date, source, model, device_id)`, so it
// only adds an index write to every new device-granularity row. This test pins the drop and
// the representative read plans that must keep their bounded seek afterwards.
describe('daily_usage user/date index migration', () => {
  test('drops the redundant index without losing bounded user/date seeks', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-daily-usage-index-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      for (const migration of migrationsBeforeTarget()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }

      expect(indexNames(dbPath)).toContain('daily_usage_user_date_idx')
      expect(indexNames(dbPath)).toContain('daily_usage_logical_key_device_idx')

      const migration = readFileSync(join(migrationsDir, indexMigrationFile), 'utf8')
      expect(runSqlite(dbPath, migration).status).toBe(0)

      const names = indexNames(dbPath)
      expect(names).not.toContain('daily_usage_user_date_idx')
      expect(names).toContain('daily_usage_logical_key_device_idx')
      expect(names).toContain('daily_usage_user_device_date_idx')

      // The newest-date probe and the user/date range still use a bounded index seek, now on
      // the logical-key index instead of the dropped prefix.
      const maxPlan = queryPlan(dbPath, `SELECT MAX(usage_date) FROM daily_usage WHERE user_id = 'index-user';`)
      expect(maxPlan).toContain('daily_usage_logical_key_device_idx')

      const rangePlan = queryPlan(
        dbPath,
        `SELECT source, model, usage_date
         FROM daily_usage
         WHERE user_id = 'index-user'
           AND usage_date BETWEEN '2026-11-01' AND '2026-11-25';`
      )
      expect(rangePlan).toContain('daily_usage_logical_key_device_idx')

      // The device-filtered path stays a bounded index lookup too (the planner may prefer the
      // covering logical-key index over daily_usage_user_device_date_idx for this projection).
      const devicePlan = queryPlan(
        dbPath,
        `SELECT source, model, usage_date
         FROM daily_usage
         WHERE user_id = 'index-user'
           AND device_id = 'device-1'
           AND usage_date BETWEEN '2026-11-01' AND '2026-11-25';`
      )
      expect(devicePlan).toContain('USING')
      expect(devicePlan).not.toContain('SCAN daily_usage')

      // The migration is idempotent.
      expect(runSqlite(dbPath, migration).status).toBe(0)
      expect(indexNames(dbPath)).not.toContain('daily_usage_user_date_idx')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)
})

function migrationsBeforeTarget() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && name < indexMigrationFile)
    .sort()
}

function indexNames(dbPath: string) {
  return runSqlite(
    dbPath,
    `SELECT name FROM sqlite_master
     WHERE type = 'index' AND tbl_name = 'daily_usage'
     ORDER BY name;`
  )
    .stdout.trim()
    .split('\n')
}

function queryPlan(dbPath: string, sql: string) {
  return runSqlite(dbPath, `EXPLAIN QUERY PLAN ${sql}`).stdout
}

function runSqlite(dbPath: string, sql: string) {
  const result = runSqliteScript(dbPath, sql, { foreignKeys: true })
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite exited with status ${result.status}`)
  }
  return result
}
