import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'

type SqliteRow = Record<string, unknown>

export function createSqliteD1(dbPath: string): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async <T>() => {
              return runPreparedSql(dbPath, wrapFirstQuery(sql), values)[0] as T | null
            },
            all: async <T>() => {
              return { results: runPreparedSql(dbPath, sql, values) as T[] }
            },
            run: async () => {
              const rows = runPreparedSql(dbPath, `${sql}; SELECT changes() AS changes`, values)
              const changes = Number(rows.at(-1)?.changes ?? 0)
              return { success: true, meta: { changes } }
            }
          }
        }
      }
    },
    batch: async (statements: Array<{
      run?: () => Promise<unknown>
    }>) => {
      const results = []
      for (const statement of statements) {
        results.push(await statement.run?.())
      }
      return results as D1Result[]
    }
  } as unknown as D1Database
}

export function runSql(dbPath: string, input: string) {
  const result = spawnSync('sqlite3', [dbPath], {
    input,
    encoding: 'utf8'
  })
  if (result.error) {
    throw new Error(`sqlite3 failed to start: ${result.error.message}\nSQL:\n${input}`)
  }
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed: ${result.stderr}\nSQL:\n${input}`)
  }
  return result.stdout
}

function runPreparedSql(dbPath: string, sql: string, bindings: unknown[]) {
  const parameterCommands = bindings.map((value, index) => parameterInsertSql(index, value))
  const output = runSql(dbPath, [
    '.mode json',
    '.parameter init',
    'DELETE FROM temp.sqlite_parameters;',
    ...parameterCommands,
    sql
  ].join('\n'))

  if (!output.trim()) return []
  return parseRows(parseSqliteJsonRows(output))
}

function wrapFirstQuery(sql: string) {
  if (/\bRETURNING\b/i.test(sql)) return sql
  return `SELECT * FROM (${sql}) LIMIT 1`
}

function parseRows(rows: SqliteRow[]) {
  return rows.map((row) => {
    const parsed: SqliteRow = {}
    const entries = Object.entries(row)
    if (entries.length === 1 && entries[0]?.[0].startsWith('COUNT(')) {
      parsed.value = entries[0][1]
      return parsed
    }
    for (const [key, value] of entries) {
      parsed[key] = value
    }
    return parsed
  })
}

function parseSqliteJsonRows(output: string) {
  return sqliteJsonResultSets(output).flatMap((json) => JSON.parse(json) as SqliteRow[])
}

function sqliteJsonResultSets(output: string) {
  const resultSets: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && inString) {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '[') {
      if (depth === 0) start = index
      depth += 1
    }
    if (char === ']') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        resultSets.push(output.slice(start, index + 1))
        start = -1
      }
    }
  }
  return resultSets
}

function parameterInsertSql(index: number, value: unknown) {
  return [
    'INSERT INTO temp.sqlite_parameters(key, value)',
    `VALUES('?${index + 1}', ${formatSqliteParameter(value)});`
  ].join(' ')
}

function formatSqliteParameter(value: unknown) {
  if (value === null) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value !== 'string') {
    throw new Error(`Unsupported sqlite test binding type: ${typeof value}`)
  }
  return sqlParameterStringLiteral(value)
}

function sqlParameterStringLiteral(value: string) {
  return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`
}
