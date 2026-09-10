import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const migrationsDir = resolve(import.meta.dirname, 'db/migrations')

describe('pairing code hash index migration', () => {
  test('removes the redundant named index while retaining code hash uniqueness', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-pairing-code-index-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      for (const migration of migrationsBeforeTarget()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }

      expect(
        runSqlite(
          dbPath,
          `
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'pairing_codes_code_hash_idx';
      `
        ).stdout.trim()
      ).toBe('1')

      const migration = readFileSync(join(migrationsDir, '0029_drop_redundant_pairing_code_hash_index.sql'), 'utf8')
      expect(runSqlite(dbPath, migration).status).toBe(0)
      expect(
        runSqlite(
          dbPath,
          `
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'pairing_codes_code_hash_idx';
      `
        ).stdout.trim()
      ).toBe('0')

      runSqlite(
        dbPath,
        `
        INSERT INTO users (id, email, email_verified, name, created_at, updated_at)
        VALUES ('pairing-index-user', 'pairing-index@example.test', 1, 'Pairing Index User', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z');

        INSERT INTO pairing_codes (id, user_id, code_hash, pairing_type, expires_at, created_at)
        VALUES ('pairing-index-first', 'pairing-index-user', 'pairing-index-hash', 'new_device', '2026-07-19T00:00:00.000Z', '2026-07-18T00:00:00.000Z');
      `
      )
      const duplicate = runSqlite(
        dbPath,
        `
        INSERT INTO pairing_codes (id, user_id, code_hash, pairing_type, expires_at, created_at)
        VALUES ('pairing-index-second', 'pairing-index-user', 'pairing-index-hash', 'new_device', '2026-07-19T00:00:00.000Z', '2026-07-18T00:00:00.000Z');
      `,
        false
      )
      expect(duplicate.status).not.toBe(0)
      expect(duplicate.stderr).toContain('UNIQUE constraint failed: pairing_codes.code_hash')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)
})

function migrationsBeforeTarget() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && name < '0029_drop_redundant_pairing_code_hash_index.sql')
    .sort()
}

function runSqlite(dbPath: string, sql: string, requireSuccess = true) {
  const result = spawnSync('sqlite3', [dbPath], {
    encoding: 'utf8',
    input: `PRAGMA foreign_keys = ON;\n${sql}`
  })
  if (requireSuccess && result.status !== 0) {
    throw new Error(result.stderr || `sqlite3 exited with status ${result.status}`)
  }
  return result
}
