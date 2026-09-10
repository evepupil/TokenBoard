import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { errorMessage } from '../error-message'

const execFileAsync = promisify(execFile)
const maxSqliteOutputBytes = 64 * 1024 * 1024
const defaultTimeoutMs = 20_000

/** Injectable reader so tests can drive the query layer without a `sqlite3` binary. */
export type RunSqliteQuery = (dbFile: string, sql: string) => Promise<string>

export type SqliteQueryOptions = {
  sqliteBin?: string
  runQuery?: RunSqliteQuery
  timeoutMs?: number
  /** Skips `node:sqlite` and reads through the executable; for covering that path. */
  forceExternalSqlite?: boolean
  /** Names the tool in error messages, e.g. `OpenCode`. */
  label: string
}

export function resolveSqliteBin(sqliteBin?: string) {
  return sqliteBin ?? process.env.TOKENBOARD_SQLITE_BIN ?? 'sqlite3'
}

/**
 * Run one read-only query and return each result row as a plain object.
 *
 * The query must project scalar columns only. Callers narrow rows inside SQL
 * (`json_extract`) rather than reading blobs into the collector, so prompt and
 * path fields in a source database never enter this process.
 *
 * Node's built-in `node:sqlite` is used when available, which is the common
 * case and needs nothing installed. Runtimes without it fall back to the
 * `sqlite3` executable. Both paths open the database read-only, so a query can
 * never mutate the tool's own store.
 */
export async function querySqliteJsonRows(
  dbFile: string,
  sql: string,
  options: SqliteQueryOptions
): Promise<Record<string, unknown>[]> {
  if (options.runQuery) {
    return parseSqliteJsonRows(await options.runQuery(dbFile, sql), dbFile, options.label)
  }
  if (!options.forceExternalSqlite && (await loadNodeSqlite())) {
    return queryWithNodeSqlite(dbFile, sql, options)
  }
  return queryWithSqliteBinary(dbFile, sql, options)
}

/**
 * Read through `node:sqlite`, which ships with the runtime.
 *
 * Row values arrive already typed, so there is no text round-trip. `BigInt`
 * columns are narrowed to `number` because token counts are far below the safe
 * integer limit, and `Uint8Array` blobs are dropped: a projected token column is
 * never a blob, and passing one on would risk carrying opaque bytes forward.
 */
async function queryWithNodeSqlite(
  dbFile: string,
  sql: string,
  options: SqliteQueryOptions
): Promise<Record<string, unknown>[]> {
  const sqlite = await loadNodeSqlite()
  if (!sqlite) throw new Error(`${options.label} SQLite reader unavailable: node:sqlite missing`)
  let database: { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } | undefined
  try {
    database = new sqlite.DatabaseSync(dbFile, { readOnly: true })
    const rows = database.prepare(sql).all()
    return rows.map((row) => normalizeNodeSqliteRow(row, dbFile, options.label))
  } catch (error) {
    if (await isMissingDatabaseError(error, dbFile)) {
      throw new Error(`${options.label} database not found: ${dbFile}`)
    }
    throw new Error(`Failed to read ${options.label} SQLite data from ${dbFile}: ${errorMessage(error)}`)
  } finally {
    try {
      database?.close()
    } catch {
      // A close failure cannot invalidate rows already read.
    }
  }
}

function normalizeNodeSqliteRow(row: unknown, dbFile: string, label: string) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`Unexpected ${label} SQLite row from ${dbFile}`)
  }
  const normalized: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
    if (typeof value === 'bigint') {
      normalized[column] = Number(value)
      continue
    }
    if (value instanceof Uint8Array) continue
    normalized[column] = value
  }
  return normalized
}

/**
 * Read through the `sqlite3` executable, for runtimes without `node:sqlite`.
 *
 * `-readonly` keeps the tool's database immutable and `-json` avoids
 * delimiter-escaping guesswork.
 */
async function queryWithSqliteBinary(
  dbFile: string,
  sql: string,
  options: SqliteQueryOptions
): Promise<Record<string, unknown>[]> {
  const sqliteBin = resolveSqliteBin(options.sqliteBin)
  let stdout: string
  try {
    stdout = (
      await execFileAsync(sqliteBin, ['-readonly', '-json', '-batch', dbFile, sql], {
        maxBuffer: maxSqliteOutputBytes,
        timeout: options.timeoutMs ?? defaultTimeoutMs,
        killSignal: 'SIGKILL'
      })
    ).stdout
  } catch (error) {
    if (isMissingBinaryError(error)) {
      throw new Error(`${options.label} SQLite reader unavailable: ${sqliteBin} not found`)
    }
    if (await isMissingDatabaseError(error, dbFile)) {
      throw new Error(`${options.label} database not found: ${dbFile}`)
    }
    throw new Error(`Failed to read ${options.label} SQLite data from ${dbFile}: ${errorMessage(error)}`)
  }
  return parseSqliteJsonRows(stdout, dbFile, options.label)
}

type NodeSqliteModule = {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean }
  ) => {
    prepare: (sql: string) => { all: () => unknown[] }
    close: () => void
  }
}

let nodeSqlitePromise: Promise<NodeSqliteModule | null> | undefined

/** Resolves to `node:sqlite` when the runtime provides it, else `null`. */
async function loadNodeSqlite() {
  nodeSqlitePromise ??= import('node:sqlite')
    .then((module) => {
      const candidate = module as unknown as NodeSqliteModule
      return typeof candidate?.DatabaseSync === 'function' ? candidate : null
    })
    .catch(() => null)
  return nodeSqlitePromise
}

/** `sqlite3 -json` prints nothing for an empty result and a JSON array otherwise. */
export function parseSqliteJsonRows(stdout: string, dbFile: string, label: string) {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`Invalid ${label} SQLite JSON output from ${dbFile}: ${errorMessage(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected ${label} SQLite JSON output from ${dbFile}`)
  }
  return parsed.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Unexpected ${label} SQLite JSON row from ${dbFile}`)
    }
    return row as Record<string, unknown>
  })
}

/**
 * Latest mtime across a SQLite database and its WAL sidecar.
 *
 * A database in WAL mode commits into `-wal` first and only updates the main
 * file at checkpoint, so watching the main file alone misses usage written
 * since the last checkpoint.
 */
export async function sqliteDatabaseMtimeMs(dbFile: string, statFile: (path: string) => Promise<{ mtimeMs: number }>) {
  const main = await statFile(dbFile)
  let latest = main.mtimeMs
  for (const sidecar of [`${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      const stats = await statFile(sidecar)
      latest = Math.max(latest, stats.mtimeMs)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
  return latest
}

export function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function isMissingDatabaseError(error: unknown, dbFile: string) {
  if (isMissingFileError(error)) return true
  if (!isSqliteOpenError(error)) return false
  try {
    await stat(dbFile)
    return false
  } catch (statError) {
    return isMissingFileError(statError)
  }
}

function isSqliteOpenError(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? error.code : undefined
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  return (
    (code === 'ERR_SQLITE_ERROR' || code === 1) && /unable to open database file/i.test(`${error.message}\n${stderr}`)
  )
}

function isMissingBinaryError(error: unknown) {
  if (!(error instanceof Error) || !('code' in error)) return false
  return error.code === 'ENOENT'
}
