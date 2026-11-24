import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { runSqliteScript } from '../test/sqlite-script'

type SqliteRow = Record<string, unknown>

type SqlitePreparedStatement = {
  sql: string
  bindings: unknown[]
  bind: (...values: unknown[]) => SqlitePreparedStatement
  first: <T = Record<string, unknown>>(colName?: string) => Promise<T | null>
  all: <T = Record<string, unknown>>() => Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }>
  run: () => Promise<{ success: boolean; results?: unknown[]; meta: { changes: number } }>
  raw: <T = unknown[]>(options?: { columnNames?: boolean }) => Promise<T[]>
}

let cachedEnv: Record<string, unknown> | undefined

export function localDevAdapter() {
  if (typeof globalThis.navigator === 'undefined') {
    globalThis.navigator = { userAgent: 'Node.js' } as Navigator
  }

  cachedEnv ??= createLocalDevEnv()

  return {
    env: cachedEnv,
    executionContext: {
      waitUntil(promise: Promise<unknown>) {
        Promise.resolve(promise).catch((error) => {
          console.error('[local-dev] waitUntil task failed:', error)
        })
      },
      passThroughOnException() {}
    }
  }
}

export function createLocalDevEnv(options?: { dbPath?: string; migrationsDir?: string }): Record<string, unknown> {
  const dbPath = options?.dbPath ?? process.env.TOKENBOARD_LOCAL_DB_PATH ?? join(tmpdir(), 'tokenboard-dev.sqlite')
  const migrationsDir = options?.migrationsDir ?? resolveMigrationsDir()

  ensureDirectory(dirname(dbPath))
  applyLocalMigrations(dbPath, migrationsDir)

  return {
    DB: createLocalSqliteD1(dbPath),
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || 'dev-tokenboard-local-secret',
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || undefined,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || '',
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || '',
    WEBHOOK_ENCRYPTION_KEY: process.env.WEBHOOK_ENCRYPTION_KEY || undefined,
    TOKENBOARD_COLLECTOR_REPO_URL:
      process.env.TOKENBOARD_COLLECTOR_REPO_URL || 'https://github.com/evepupil/TokenBoard.git',
    TOKENBOARD_COLLECTOR_REF: process.env.TOKENBOARD_COLLECTOR_REF || 'master',
    TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: process.env.TOKENBOARD_DAILY_REPORT_HISTORY_DAYS || '30',
    TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT: process.env.TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT || '50',
    TOKENBOARD_USAGE_SUMMARY_STRICT: process.env.TOKENBOARD_USAGE_SUMMARY_STRICT || 'false',
    TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS: process.env.TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS || '90',
    TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE: process.env.TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE || '5',
    TOKENBOARD_MODEL_PRICING_SYNC_ENABLED: process.env.TOKENBOARD_MODEL_PRICING_SYNC_ENABLED || 'false',
    TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: process.env.TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS || '24',
    TOKENBOARD_MODEL_PRICING_SOURCE_URL:
      process.env.TOKENBOARD_MODEL_PRICING_SOURCE_URL || 'https://models.dev/api.json',
    TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: process.env.TOKENBOARD_MODEL_PRICING_SYNC_TOKEN || undefined,
    TOKENBOARD_STEP_UP_REQUIRED: process.env.TOKENBOARD_STEP_UP_REQUIRED || 'false',
    TOKENBOARD_ALLOW_DEV_IFRAME: 'true'
  }
}

function resolveMigrationsDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(currentDir, '../../db/migrations'),
    resolve(process.cwd(), 'db/migrations'),
    resolve(process.cwd(), 'apps/web/db/migrations')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

function ensureDirectory(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function applyLocalMigrations(dbPath: string, migrationsDir: string) {
  const database = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false })
  let applied: Set<string>
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS _local_d1_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `)
    const rows = database.prepare('SELECT name FROM _local_d1_migrations').all() as Array<{ name: string }>
    applied = new Set(rows.map((row) => row.name))
  } finally {
    database.close()
  }

  if (!existsSync(migrationsDir)) return

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    const result = runSqliteScript(dbPath, sql)
    if (result.status !== 0) {
      throw new Error(`Failed to apply local migration ${file}: ${result.stderr}`)
    }
    const recordDb = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false })
    try {
      recordDb
        .prepare('INSERT OR IGNORE INTO _local_d1_migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString())
    } finally {
      recordDb.close()
    }
  }
}

export function createLocalSqliteD1(dbPath: string): D1Database {
  const createStatement = (sql: string, bindings: unknown[] = []): SqlitePreparedStatement => ({
    sql,
    bindings,
    bind(...values: unknown[]) {
      return createStatement(sql, values)
    },
    async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
      const rows = runPreparedQuery(dbPath, wrapFirstQuery(sql), bindings)
      const row = rows[0]
      if (!row) return null
      if (colName !== undefined) {
        return (row[colName] ?? null) as T | null
      }
      return row as T
    },
    async all<T = Record<string, unknown>>() {
      const results = runPreparedQuery(dbPath, sql, bindings) as T[]
      return { results, success: true, meta: {} }
    },
    async run() {
      const database = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false, readBigInts: true })
      try {
        return runPreparedStatement(database, sql, bindings)
      } finally {
        database.close()
      }
    },
    async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
      const rows = runPreparedQuery(dbPath, sql, bindings)
      const values = rows.map((row) => Object.values(row)) as T[]
      if (options?.columnNames && rows.length > 0) {
        return [Object.keys(rows[0]) as unknown as T, ...values]
      }
      return values
    }
  })

  return {
    prepare(sql: string) {
      return createStatement(sql)
    },
    async batch(statements: SqlitePreparedStatement[]) {
      const database = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false, readBigInts: true })
      try {
        database.exec('BEGIN IMMEDIATE;')
        const results = statements.map((statement) =>
          runPreparedStatement(database, statement.sql, statement.bindings)
        )
        database.exec('COMMIT;')
        return results
      } catch (error) {
        try {
          database.exec('ROLLBACK;')
        } catch {
          // Ignore rollback failure when transaction is already aborted.
        }
        throw error
      } finally {
        database.close()
      }
    },
    async exec(query: string) {
      const result = runSqliteScript(dbPath, query)
      if (result.status !== 0) {
        throw new Error(`sqlite exec failed: ${result.stderr}`)
      }
      return { count: 1, duration: 0 }
    }
  } as unknown as D1Database
}

function runPreparedQuery(dbPath: string, sql: string, bindings: unknown[]): SqliteRow[] {
  const database = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false, readBigInts: true })
  try {
    return parseRows(database.prepare(sql).all(...(normalizeBindings(bindings) as never[])) as SqliteRow[])
  } finally {
    database.close()
  }
}

function runPreparedStatement(database: DatabaseSync, sql: string, bindings: unknown[]) {
  const normalizedBindings = normalizeBindings(bindings) as never[]
  const statement = database.prepare(sql)
  if (statementReturnsRows(sql)) {
    const rows = parseRows(statement.all(...normalizedBindings) as SqliteRow[])
    return {
      success: true,
      results: rows,
      meta: { changes: hasReturningClause(sql) ? rows.length : 0 }
    }
  }

  const result = statement.run(...normalizedBindings)
  return { success: true, meta: { changes: Number(result.changes) } }
}

function wrapFirstQuery(sql: string) {
  if (/\bRETURNING\b/i.test(sql)) return sql
  return `SELECT * FROM (${sql.trim().replace(/;\s*$/, '')}) LIMIT 1`
}

function parseRows(rows: SqliteRow[]): SqliteRow[] {
  return rows.map((row) => {
    const parsed: SqliteRow = {}
    for (const [key, value] of Object.entries(row)) {
      parsed[key] = normalizeSqliteValue(value)
    }
    return parsed
  })
}

function statementReturnsRows(sql: string) {
  const normalized = sql.trim()
  return /^(?:SELECT|VALUES|PRAGMA|EXPLAIN|WITH)\b/i.test(normalized) || hasReturningClause(sql)
}

function hasReturningClause(sql: string) {
  return /\bRETURNING\b/i.test(sql)
}

function normalizeSqliteValue(value: unknown) {
  if (typeof value !== 'bigint') return value
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value
}

function normalizeBindings(values: unknown[]) {
  return values.map((value) => {
    if (value === undefined || value === null) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'number' && !Number.isFinite(value)) return null
    if (
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'string' ||
      value instanceof Uint8Array
    ) {
      return value
    }
    if (value instanceof Date) return value.toISOString()
    return String(value)
  })
}
