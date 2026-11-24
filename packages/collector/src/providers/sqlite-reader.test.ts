import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  antigravityMaxSqliteOutputBytes,
  assertWithinOutputBudget,
  querySqliteJsonRows,
  querySqliteText
} from './sqlite-reader'

// `querySqliteText` exists so a caller whose SQL renders its result set as text (the
// Antigravity sources parse `idx|hex` lines) can still benefit from `node:sqlite`, which
// needs nothing installed. The contract is that both readers produce the *same bytes* — a
// cursor hashes that text, so a rendering difference would silently change row identity
// depending on which reader ran.
describe('querySqliteText', () => {
  test('renders rows exactly as the sqlite3 executable does', async () => {
    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch {
      return // Runtime without node:sqlite; the executable path is covered elsewhere.
    }

    const root = await mkdtemp(join(tmpdir(), 'tokenboard-sqlite-text-'))
    try {
      const dbPath = join(root, 'probe.db')
      const seed = new sqlite.DatabaseSync(dbPath)
      seed.exec('CREATE TABLE t (n INTEGER, b BLOB, s TEXT);')
      // Every shape the CLI renders differently: a blob through hex(), a null column, an
      // empty blob, a string containing the delimiter, and a multi-byte value.
      seed.exec("INSERT INTO t VALUES (1, x'0A0B0C', 'a|b'), (2, NULL, ''), (3, x'', '多字节'), (4, NULL, NULL);")
      seed.close()

      const queries = [
        'select n, hex(b) from t order by n',
        'select max(n) from t',
        'select n, s from t order by n',
        'select n from t where n > 999'
      ]
      for (const sql of queries) {
        const builtin = await querySqliteText(dbPath, sql, { label: 'Probe' })
        const external = await querySqliteText(dbPath, sql, { label: 'Probe', forceExternalSqlite: true })
        expect(builtin, `readers disagree for: ${sql}`).toBe(external)
      }

      // And the rendering itself, so a change to both readers at once cannot hide here.
      expect(await querySqliteText(dbPath, 'select n, hex(b) from t order by n', { label: 'Probe' })).toBe(
        '1|0A0B0C\n2|\n3|\n4|\n'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // `maxBuffer` caps the executable's stdout. Without the same ceiling in-process, the
  // reader that is supposed to be the *default* would succeed on a result set the forced
  // external reader fails on — so `TOKENBOARD_SQLITE_BIN`, documented as choosing how to
  // read rather than what can be read, would change the outcome.
  test('applies the executable output ceiling to the in-process reader too', async () => {
    // Driven through `querySqliteText` rather than the helper, so this fails if the reader
    // stops enforcing the budget — calling the helper directly would pass either way. The
    // data is built with a recursive CTE inside SQLite rather than in JS so the test's own
    // allocation stays small; the row count is kept to the minimum that crosses 64 MiB.
    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch {
      return
    }

    const root = await mkdtemp(join(tmpdir(), 'tokenboard-sqlite-budget-'))
    try {
      const dbPath = join(root, 'big.db')
      const seed = new sqlite.DatabaseSync(dbPath)
      seed.exec('CREATE TABLE t (s TEXT);')
      seed.exec(
        'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 20) INSERT INTO t SELECT hex(zeroblob(2 * 1024 * 1024)) FROM c;'
      )
      seed.close()

      await expect(querySqliteText(dbPath, 'select s from t', { label: 'Probe' })).rejects.toThrow(/exceeded \d+ bytes/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  // The budget has to be measured on the bytes this path actually returns. Measuring the rows
  // as JSON while emitting the `|`-separated rendering sizes them differently, so the
  // in-process reader rejected at a different point than the executable's `maxBuffer` — which
  // is the disagreement the ceiling above exists to prevent.
  //
  // Driven through `querySqliteText` (not the helper) so it fails if the reader goes back to
  // measuring JSON: the ceiling sits between the rendered size and the JSON size of the same
  // rows, so only a reader that measures the real output accepts them.
  test('measures the budget on the text it emits, not on the rows as JSON', async () => {
    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch {
      return
    }

    const root = await mkdtemp(join(tmpdir(), 'tokenboard-sqlite-text-budget-'))
    try {
      const dbPath = join(root, 'text-budget.db')
      const seed = new sqlite.DatabaseSync(dbPath)
      seed.exec('CREATE TABLE t (idx INTEGER, data TEXT);')
      // Two rows whose JSON encoding is larger than their `idx|data` rendering: JSON adds the
      // key names, quotes and braces, while the text form adds only a `|`.
      seed.exec("INSERT INTO t VALUES (1, printf('%.*c', 4096, 'a')), (2, printf('%.*c', 4096, 'b'));")
      seed.close()

      const rows = [
        { idx: 1, data: 'a'.repeat(4096) },
        { idx: 2, data: 'b'.repeat(4096) }
      ]
      const renderedBytes = Buffer.byteLength(
        `${rows[0].idx}|${rows[0].data}\n${rows[1].idx}|${rows[1].data}\n`,
        'utf8'
      )
      const jsonBytes = rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0)
      // The premise: JSON is the larger encoding, which is why measuring it lets a result set
      // through that the text measurement rejects.
      expect(jsonBytes).toBeGreaterThan(renderedBytes)

      // Ceiling just below the JSON size and just above the rendered size: measured on the
      // real output the read succeeds; measured on JSON it would throw.
      const ceiling = Math.floor((renderedBytes + jsonBytes) / 2)
      await expect(
        querySqliteText(dbPath, 'select idx, data from t order by idx', { label: 'Probe', maxOutputBytes: ceiling })
      ).resolves.toBe(`${rows[0].idx}|${rows[0].data}\n${rows[1].idx}|${rows[1].data}\n`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  // The text-path tests above pin the ceiling for `querySqliteText`; the JSON reader is the
  // path most callers take (OpenCode projects with `json_extract`), and its in-process budget
  // is a separate call that a refactor could drop without any other test noticing. Driven
  // through `querySqliteJsonRows`, with the same data read under two ceilings so a parse
  // failure cannot be mistaken for a budget rejection.
  test('applies the output ceiling to the in-process JSON reader too', async () => {
    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch {
      return
    }

    const root = await mkdtemp(join(tmpdir(), 'tokenboard-sqlite-json-budget-'))
    try {
      const dbPath = join(root, 'json-budget.db')
      const seed = new sqlite.DatabaseSync(dbPath)
      seed.exec('CREATE TABLE t (s TEXT);')
      seed.exec("INSERT INTO t VALUES (printf('%.*c', 4096, 'a'));")
      seed.close()

      const row = { s: 'a'.repeat(4096) }
      // Below the JSON size of the row, so the ceiling must reject it...
      await expect(
        querySqliteJsonRows(dbPath, 'select s from t', { label: 'Probe', maxOutputBytes: 512 })
      ).rejects.toThrow(/exceeded 512 bytes/)
      // ...and above it the same query resolves, so the rejection above was the budget.
      await expect(
        querySqliteJsonRows(dbPath, 'select s from t', { label: 'Probe', maxOutputBytes: 1024 * 1024 })
      ).resolves.toEqual([row])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // The executable path is capped by `maxBuffer` on the whole `-json` document the CLI prints.
  // The in-process budget must measure that same document, framing included: `[row,\nrow]\n`
  // adds 2n+1 bytes (brackets, a comma-newline per separator, the trailing newline) that
  // per-row `JSON.stringify(row)` summation misses. The gap grows one byte per row after the
  // first, so near the ceiling the two readers disagree — a result the executable rejects can
  // pass in-process — breaking the documented `TOKENBOARD_SQLITE_BIN` parity.
  test('the JSON budget measures the whole document, not per-row fragments', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: index, s: 'x'.repeat(64) }))
    const fragmentBytes = rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0)
    const documentBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8')
    // What `sqlite3 -json` actually writes: fragments plus brackets, inter-row commas, and one
    // newline after every row including the last (verified against real CLI output).
    const cliBytes = fragmentBytes + rows.length * 2 + 1

    expect(documentBytes - fragmentBytes).toBe(rows.length + 1)
    expect(cliBytes - documentBytes).toBe(rows.length)

    // A ceiling the old fragment sum accepts but the framed document exceeds — the exact
    // disagreement the per-row summation produced.
    expect(() => assertWithinOutputBudget(rows, 'any.db', 'Probe', fragmentBytes + rows.length)).toThrow(
      `Probe SQLite result exceeded ${fragmentBytes + rows.length} bytes`
    )
    // Exactly the CLI's byte count still fits; one byte less does not.
    expect(() => assertWithinOutputBudget(rows, 'any.db', 'Probe', cliBytes)).not.toThrow()
    expect(() => assertWithinOutputBudget(rows, 'any.db', 'Probe', cliBytes - 1)).toThrow(
      `Probe SQLite result exceeded ${cliBytes - 1} bytes`
    )
  })
  // Unifying the read path onto the 64 MiB default silently halved the ceiling the Antigravity
  // sources had before it. They are the one caller that can reach it — they read a whole page
  // of `hex(data)`, which doubles each blob — so the value is pinned here: a reader refactor
  // that drops it again is a capacity regression for those sources, not a tidy-up.
  test('keeps the Antigravity ceiling above the shared default', () => {
    expect(antigravityMaxSqliteOutputBytes).toBe(128 * 1024 * 1024)
  })

  // The Antigravity sources carry a larger ceiling than the shared default because they read
  // whole pages of `hex(data)`. This pins the override mechanism itself.
  test('honours a caller-supplied output ceiling', async () => {
    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch {
      return
    }

    const root = await mkdtemp(join(tmpdir(), 'tokenboard-sqlite-override-'))
    try {
      const dbPath = join(root, 'override.db')
      const seed = new sqlite.DatabaseSync(dbPath)
      seed.exec('CREATE TABLE t (s TEXT);')
      seed.exec(
        'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 20) INSERT INTO t SELECT hex(zeroblob(2 * 1024 * 1024)) FROM c;'
      )
      seed.close()

      // Above the 64 MiB default this result set is rejected...
      await expect(querySqliteText(dbPath, 'select s from t', { label: 'Probe' })).rejects.toThrow(/exceeded \d+ bytes/)
      // ...and with the Antigravity ceiling it is read, which is the behaviour the unified
      // reader had to preserve.
      await expect(
        querySqliteText(dbPath, 'select s from t', { label: 'Probe', maxOutputBytes: 128 * 1024 * 1024 })
      ).resolves.toContain('00')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test('reports the executable as unavailable when it is missing', async () => {
    await expect(
      querySqliteText('/tmp/does-not-matter.db', 'select 1', {
        label: 'Probe',
        forceExternalSqlite: true,
        sqliteBin: 'tokenboard-sqlite3-does-not-exist'
      })
    ).rejects.toThrow('Probe SQLite reader unavailable')
  })

  test('prefers the injected reader so callers keep control of the query path', async () => {
    const result = await querySqliteText('/tmp/ignored.db', 'select 1', {
      label: 'Probe',
      runQuery: async () => 'injected\n'
    })
    expect(result).toBe('injected\n')
  })
})

// The external sqlite binary is a third-party program, and execFile inherits
// the whole process environment when `env` is omitted. The upload token lives
// there, so a reader that leaked it would hand the credential to whatever
// `sqlite3` the machine happens to have on PATH. A stand-in binary reports
// whether it can see the variable.
describe('the external sqlite binary never inherits credentials', () => {
  test('both query paths scrub the environment first', async () => {
    if (process.platform === 'win32') {
      return // A POSIX shell script is how the stand-in reports what it saw.
    }
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-sqlite-env-'))
    try {
      const standIn = join(root, 'sqlite3')
      await writeFile(
        standIn,
        // The stand-in prints valid JSON either way, so each reader parses it;
        // the payload is what reveals whether the variable reached it.
        '#!/bin/sh\nif [ -n "$TOKENBOARD_UPLOAD_TOKEN" ]; then echo \'[{"token":"LEAKED"}]\'; else echo \'[{"token":"CLEAN"}]\'; fi\n',
        { mode: 0o755 }
      )
      const previous = process.env.TOKENBOARD_UPLOAD_TOKEN
      process.env.TOKENBOARD_UPLOAD_TOKEN = 'tb_probe_secret'
      try {
        const text = await querySqliteText(join(root, 'unused.db'), 'select 1', {
          sqliteBin: standIn,
          label: 'Antigravity',
          forceExternalSqlite: true
        })
        const json = await querySqliteJsonRows(join(root, 'unused.db'), 'select 1', {
          sqliteBin: standIn,
          label: 'Antigravity',
          forceExternalSqlite: true
        })
        expect(text).toContain('CLEAN')
        expect(text).not.toContain('LEAKED')
        expect(JSON.stringify(json)).toContain('CLEAN')
        expect(JSON.stringify(json)).not.toContain('LEAKED')
      } finally {
        if (previous === undefined) delete process.env.TOKENBOARD_UPLOAD_TOKEN
        else process.env.TOKENBOARD_UPLOAD_TOKEN = previous
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
