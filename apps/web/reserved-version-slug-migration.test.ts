import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'

const migrationsDir = resolve(import.meta.dirname, 'db/migrations')
const targetMigration = '0040_reserved_version_slug.sql'

describe('reserved version slug migration', () => {
  test('does not change profiles when the reserved slug is unused', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-version-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      insertProfile(dbPath, 'kept-user', 'eve', 'Eve')
      const before = profileSlugs(dbPath)
      runSqlite(dbPath, readFileSync(join(migrationsDir, targetMigration), 'utf8'))
      expect(profileSlugs(dbPath)).toBe(before)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('renames a legacy profile to the deterministic fallback and is idempotent', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-version-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      insertProfile(dbPath, 'legacy-user', 'version', 'Legacy Version')
      const migration = readFileSync(join(migrationsDir, targetMigration), 'utf8')

      runSqlite(dbPath, migration)
      expect(profileSlug(dbPath, 'legacy-user')).toBe('version-legacy')
      expect(profileUpdatedAt(dbPath, 'legacy-user')).not.toBe('2026-09-16T00:00:00.000Z')
      runSqlite(dbPath, migration)
      expect(profileSlug(dbPath, 'legacy-user')).toBe('version-legacy')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('repairs a case-variant legacy reserved slug', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-version-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      insertProfile(dbPath, 'legacy-user', 'Version', 'Legacy Version')
      runSqlite(dbPath, readFileSync(join(migrationsDir, targetMigration), 'utf8'))

      expect(profileSlug(dbPath, 'legacy-user')).toBe('version-legacy')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('skips a fallback slug that is already taken', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-version-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      insertProfile(dbPath, 'taken-user', 'version-legacy', 'Already Taken')
      insertProfile(dbPath, 'legacy-user', 'version', 'Legacy Version')
      runSqlite(dbPath, readFileSync(join(migrationsDir, targetMigration), 'utf8'))

      const renamed = profileSlug(dbPath, 'legacy-user')
      expect(renamed).not.toBe('version')
      expect(renamed).not.toBe('version-legacy')
      expect(profileSlug(dbPath, 'taken-user')).toBe('version-legacy')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('keeps every renamed slug within the 32-character profile slug limit', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-version-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      // A user id whose hex form is long enough to overflow the limit if the migration
      // used the whole id instead of the first seven hex characters.
      const longUserId = 'legacy-user-with-a-deliberately-long-identifier'
      insertProfile(dbPath, longUserId, 'version', 'Legacy Version')
      runSqlite(dbPath, readFileSync(join(migrationsDir, targetMigration), 'utf8'))

      const renamed = profileSlug(dbPath, longUserId)
      expect(renamed.length).toBeLessThanOrEqual(32)
      expect(renamed.startsWith('version-legacy')).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)
})

function applyMigrationsBeforeTarget(dbPath: string) {
  for (const migration of readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && name < targetMigration)
    .sort()) {
    runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
  }
}

function insertProfile(dbPath: string, userId: string, slug: string, displayName: string) {
  runSqlite(
    dbPath,
    `
      INSERT INTO users (id, name, created_at, updated_at)
      VALUES ('${userId}', '${displayName}', '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z');
      INSERT INTO profiles (
        user_id, slug, display_name, timezone, is_public, participates_in_leaderboards, created_at, updated_at
      ) VALUES (
        '${userId}', '${slug}', '${displayName}', 'UTC', 1, 0, '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z'
      );
    `
  )
}

function profileSlug(dbPath: string, userId: string) {
  return runSqlite(dbPath, `SELECT slug FROM profiles WHERE user_id = '${userId}';`).stdout.trim()
}

function profileSlugs(dbPath: string) {
  return runSqlite(dbPath, 'SELECT user_id, slug FROM profiles ORDER BY user_id;').stdout.trim()
}

function profileUpdatedAt(dbPath: string, userId: string) {
  return runSqlite(dbPath, `SELECT updated_at FROM profiles WHERE user_id = '${userId}';`).stdout.trim()
}

function runSqlite(dbPath: string, sql: string) {
  const database = new DatabaseSync(dbPath)
  try {
    const trimmedSql = sql.trim().replace(/;\s*$/, '')
    if (/^SELECT\b/i.test(trimmedSql)) {
      const rows = database.prepare(trimmedSql).all() as Array<
        Record<string, string | number | null | bigint | Uint8Array>
      >
      return {
        stdout: rows
          .map((row) =>
            Object.values(row)
              .map((value) => formatSqliteOutput(value))
              .join('|')
          )
          .join('\n'),
        stderr: '',
        status: 0
      }
    }
    database.exec(`PRAGMA foreign_keys = ON;\n${sql}`)
    return { stdout: '', stderr: '', status: 0 }
  } finally {
    database.close()
  }
}

function formatSqliteOutput(value: string | number | null | bigint | Uint8Array) {
  if (value === null) return ''
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
  return String(value)
}
