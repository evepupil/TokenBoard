import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { childProcessEnv } from '../child-env'
import { errorMessage } from '../error-message'

const execFileAsync = promisify(execFile)
const maxSqliteOutputBytes = 64 * 1024 * 1024
// The Antigravity sources project blobs as `hex(data)`, which doubles them, and read a whole
// page of rows at a time. They carried their own 128 MiB ceiling before the read path was
// shared here; keeping it as an override means unifying the reader did not silently halve the
// capacity of the one caller that can legitimately reach it.
export const antigravityMaxSqliteOutputBytes = 128 * 1024 * 1024
const defaultTimeoutMs = 20_000

/** Injectable reader so tests can drive the query layer without a `sqlite3` binary. */
export type RunSqliteQuery = (dbFile: string, sql: string) => Promise<string>

export type SqliteQueryOptions = {
  sqliteBin?: string
  runQuery?: RunSqliteQuery
  timeoutMs?: number
  /** Skips `node:sqlite` and reads through the executable; for covering that path. */
  forceExternalSqlite?: boolean
  /** Output ceiling in bytes; defaults to {@link maxSqliteOutputBytes}. */
  maxOutputBytes?: number
  /** Names the tool in error messages, e.g. `OpenCode`. */
  label: string
}

/** Options for {@link querySqliteText}, which returns the CLI's raw output. */
export type SqliteTextQueryOptions = Pick<
  SqliteQueryOptions,
  'sqliteBin' | 'runQuery' | 'timeoutMs' | 'forceExternalSqlite' | 'maxOutputBytes' | 'label'
>

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
 * Run one read-only query and return the CLI's own text output.
 *
 * For callers whose SQL formats its result set as text rather than JSON — the
 * Antigravity sources project blobs with `hex(data)` and parse `idx|hex` lines —
 * routing them through `node:sqlite` means reproducing that exact rendering here,
 * so a row looks the same whichever reader produced it. Columns are joined with
 * `|`, rows with `\n`, and `null` renders as empty, matching `sqlite3`'s default
 * list mode for the column types callers project: text, integer, and `null`.
 *
 * Two types sit outside that contract and render differently from the CLI:
 * a REAL value goes through JavaScript number formatting (`1.0` prints as `1`,
 * `1e20` as a long integer), and a raw blob is hex-encoded rather than printed
 * as bytes. No caller projects either — blobs are hexed in SQL, so they arrive
 * as text — and a new caller that does must extend this function rather than
 * assume byte parity.
 */
export async function querySqliteText(dbFile: string, sql: string, options: SqliteTextQueryOptions): Promise<string> {
  if (options.runQuery) return options.runQuery(dbFile, sql)
  if (!options.forceExternalSqlite && (await loadNodeSqlite())) {
    return queryTextWithNodeSqlite(dbFile, sql, options)
  }
  return queryTextWithSqliteBinary(dbFile, sql, options)
}

async function queryTextWithNodeSqlite(dbFile: string, sql: string, options: SqliteTextQueryOptions): Promise<string> {
  const sqlite = await loadNodeSqlite()
  if (!sqlite) throw new Error(`${options.label} SQLite reader unavailable: node:sqlite missing`)
  let database: { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } | undefined
  try {
    database = new sqlite.DatabaseSync(dbFile, { readOnly: true })
    const rows = database.prepare(sql).all()
    const rendered = rows.map(renderSqliteTextRow)
    // Measured on the text this path actually returns, not on the rows as JSON: the two
    // encodings differ in size, and budgeting one while emitting the other makes this path
    // reject at a different point than `maxBuffer` rejects the executable. Like the JSON
    // path, the check runs after the rows are materialised, so it bounds what the reader
    // accepts, not peak memory.
    assertTextWithinOutputBudget(rendered, options.label, resolveMaxOutputBytes(options))
    return rendered.join('\n') + (rows.length ? '\n' : '')
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

/**
 * Render one row the way `sqlite3`'s default list mode does for the column types
 * callers project: `|`-separated columns, `null` as an empty field. `node:sqlite`
 * hands back `BigInt` for integer columns where the CLI would have printed a
 * number, so those are narrowed the same way `normalizeNodeSqliteRow` does. See
 * the contract note on {@link querySqliteText} for the two types — REAL and raw
 * blob — that deliberately render differently from the CLI.
 */
function renderSqliteTextRow(row: unknown) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('Unexpected SQLite row')
  }
  return Object.values(row as Record<string, unknown>)
    .map((value) => {
      if (value === null || value === undefined) return ''
      if (typeof value === 'bigint') return String(Number(value))
      if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
      return String(value)
    })
    .join('|')
}

async function queryTextWithSqliteBinary(
  dbFile: string,
  sql: string,
  options: SqliteTextQueryOptions
): Promise<string> {
  const sqliteBin = resolveSqliteBin(options.sqliteBin)
  try {
    return (
      await execFileAsync(sqliteBin, ['-readonly', '-batch', dbFile, sql], {
        // The upload token and pairing code live in the same environment this
        // process was handed. execFile inherits all of it when `env` is
        // omitted, so a third-party sqlite binary would have seen them.
        env: childProcessEnv(process.env),
        maxBuffer: resolveMaxOutputBytes(options),
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
    assertWithinOutputBudget(rows, dbFile, options.label, resolveMaxOutputBytes(options))
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

/**
 * Apply the same size ceiling to `node:sqlite` that `maxBuffer` applies to the executable.
 *
 * Without this the two readers disagree at the top of the range: the executable path fails
 * once its output exceeds the ceiling, while the in-process path would happily build the same
 * result set. That makes `TOKENBOARD_SQLITE_BIN` — which is documented as forcing the external
 * reader, not as changing behaviour — turn a working collection into a failing one.
 *
 * The rows are measured as the `-json` CLI would print them, which is what the executable's
 * `maxBuffer` counts: `[row,\nrow]\n`. Summing `JSON.stringify(row)` per row instead drops that
 * framing — 2 bytes per row plus the outer `[`, `]` and trailing newline — so the in-process
 * reader would accept a result set the executable rejects. The gap grows one byte per row
 * after the first, which is exactly the kind of drift a parity check exists to prevent.
 *
 * The check runs after `all()` has already materialised the result set, so it bounds which
 * result sets the reader accepts — parity with the executable, plus a sanity ceiling — not
 * peak memory. Callers that need a hard memory bound cap their SQL (the Antigravity sources
 * page with `limit`).
 */
export function assertWithinOutputBudget(
  rows: unknown[],
  dbFile: string,
  label: string,
  maxOutputBytes = maxSqliteOutputBytes
) {
  // Empty result: `sqlite3 -json` prints nothing. Otherwise the document framing is the two
  // brackets, a `,\n` between each pair of rows, and a trailing newline: 2n + 1 bytes.
  let bytes = rows.length === 0 ? 0 : rows.length * 2 + 1
  for (const row of rows) {
    try {
      bytes += Buffer.byteLength(JSON.stringify(row) ?? '', 'utf8')
    } catch {
      // A value that cannot be serialised is not something this budget can measure; the
      // row is passed on and rejected by the caller's own validation.
      continue
    }
    if (bytes > maxOutputBytes) {
      throw new Error(`${label} SQLite result exceeded ${maxOutputBytes} bytes`)
    }
  }
}

/**
 * The text-path counterpart of {@link assertWithinOutputBudget}. It measures the rendered
 * `|`-separated lines that {@link queryTextWithNodeSqlite} returns, not the rows as JSON: the
 * two encodings differ in size, so budgeting one while emitting the other would make this path
 * reject at a different point than the executable's `maxBuffer`.
 */
function assertTextWithinOutputBudget(rendered: string[], label: string, maxOutputBytes: number) {
  let bytes = 0
  for (const line of rendered) {
    bytes += Buffer.byteLength(line, 'utf8') + 1
    if (bytes > maxOutputBytes) {
      throw new Error(`${label} SQLite result exceeded ${maxOutputBytes} bytes`)
    }
  }
}

function resolveMaxOutputBytes(options: { maxOutputBytes?: number }) {
  return options.maxOutputBytes ?? maxSqliteOutputBytes
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
        // Same scrubbing as the text query: this path launches the same
        // third-party binary.
        env: childProcessEnv(process.env),
        maxBuffer: resolveMaxOutputBytes(options),
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
