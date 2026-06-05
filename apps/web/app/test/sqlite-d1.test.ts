import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from './sqlite-d1'

describe('sqlite D1 test adapter', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('binds ISO date strings as strings instead of sqlite expressions', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, 'CREATE TABLE events (usage_date TEXT NOT NULL);')

    const db = createSqliteD1(dbPath)
    await db.prepare('INSERT INTO events (usage_date) VALUES (?)').bind('2026-06-02').run()

    const row = await db
      .prepare('SELECT usage_date as value FROM events')
      .bind()
      .first<{ value: string }>()

    expect(row?.value).toBe('2026-06-02')
  })

  test('binds JSON strings with quotes as string values', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, 'CREATE TABLE payloads (value TEXT NOT NULL);')

    const value = JSON.stringify([{ label: "Alice's report", total: 1200 }])
    const db = createSqliteD1(dbPath)
    await db.prepare('INSERT INTO payloads (value) VALUES (?)').bind(value).run()

    const row = await db
      .prepare('SELECT value FROM payloads')
      .bind()
      .first<{ value: string }>()

    expect(row?.value).toBe(value)
  })

  test('parses result sets with brackets inside string values', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, 'CREATE TABLE payloads (value TEXT NOT NULL);')

    const db = createSqliteD1(dbPath)
    await db.prepare('INSERT INTO payloads (value) VALUES (?), (?)')
      .bind('alpha [beta] gamma', 'tail')
      .run()

    const rows = await db
      .prepare('SELECT value FROM payloads ORDER BY value')
      .bind()
      .all<{ value: string }>()

    expect(rows.results.map((row) => row.value)).toEqual(['alpha [beta] gamma', 'tail'])
  })

  test('reports changes when run executes a returning statement', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, 'CREATE TABLE events (id TEXT NOT NULL);')

    const db = createSqliteD1(dbPath)
    const result = await db
      .prepare('INSERT INTO events (id) VALUES (?) RETURNING id')
      .bind('evt_1')
      .run()

    expect(result.meta.changes).toBe(1)
  })
})
