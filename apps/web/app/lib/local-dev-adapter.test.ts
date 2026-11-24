import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createLocalDevEnv } from './local-dev-adapter'

test('localDevAdapter applies all D1 migrations cleanly and executes D1 queries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-dev-test-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    const env = createLocalDevEnv({ dbPath })
    const db = env.DB as D1Database

    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>()
    const tableNames = new Set(tables.results.map((row) => row.name))

    assert.equal(tableNames.has('users'), true)
    assert.equal(tableNames.has('profiles'), true)
    assert.equal(tableNames.has('daily_usage'), true)
    assert.equal(tableNames.has('api_rate_limits'), true)
    assert.equal(tableNames.has('model_pricing'), true)

    // Re-running migrations on the same DB should be idempotent.
    const env2 = createLocalDevEnv({ dbPath })
    const countRow = await (env2.DB as D1Database)
      .prepare('SELECT COUNT(*) as total FROM _local_d1_migrations')
      .first<{ total: number }>()
    assert.ok((countRow?.total ?? 0) >= 40)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
