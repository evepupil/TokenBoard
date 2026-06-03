import { spawnSync } from 'node:child_process'

const sqliteJsonColumns = new Set(['sourceSplit', 'topModels'])

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
              runPreparedSql(dbPath, sql, values)
              return { success: true, meta: {} }
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
  const parameterCommands = bindings.map((value, index) =>
    `.parameter set ?${index + 1} ${formatSqliteParameter(value)}`
  )
  const output = runSql(dbPath, [
    '.mode json',
    '.parameter init',
    ...parameterCommands,
    sql
  ].join('\n'))

  if (!output.trim()) return []
  return parseRows(JSON.parse(output) as SqliteRow[])
}

function wrapFirstQuery(sql: string) {
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
      parsed[key] = sqliteJsonColumns.has(key) && typeof value === 'string'
        ? JSON.parse(value)
        : value
    }
    return parsed
  })
}

function formatSqliteParameter(value: unknown) {
  if (value === null) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value !== 'string') {
    throw new Error(`Unsupported sqlite test binding type: ${typeof value}`)
  }
  if (!/^[A-Za-z0-9_./:@ -]+$/.test(value)) {
    throw new Error(`Unsupported sqlite test binding value: ${value}`)
  }
  return sqlParameterStringLiteral(value)
}

function sqlParameterStringLiteral(value: string) {
  return `"${`'${value.replaceAll("'", "''")}'`.replaceAll('"', '""')}"`
}
