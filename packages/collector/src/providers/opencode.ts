import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { usageSnapshotSchema, type UsageSnapshot } from '@tokenboard/usage-core'
import { assertValidDateFilter, isAllDateFilter } from '../iso-calendar-date'
import { mergeSnapshots } from './session-cursor'
import { formatDate } from './session-jsonl-parser-utils'
import { isMissingFileError, querySqliteJsonRows, sqliteDatabaseMtimeMs, type RunSqliteQuery } from './sqlite-reader'

const source = 'opencode'
const label = 'OpenCode'
const unknownModel = 'unknown'
const maxModelNameLength = 160

/**
 * Token and cost columns projected out of `message.data`.
 *
 * Only these fields leave SQLite. `message.data` also holds the prompt, the
 * assistant reply and a local `path`, so the query never selects the blob
 * itself.
 */
const usageRowsSql = `
SELECT
  json_extract(m.data, '$.modelID')            AS model,
  json_extract(m.data, '$.time.created')       AS createdMs,
  json_extract(m.data, '$.tokens.input')       AS inputTokens,
  json_extract(m.data, '$.tokens.output')      AS outputTokens,
  json_extract(m.data, '$.tokens.reasoning')   AS reasoningTokens,
  json_extract(m.data, '$.tokens.cache.read')  AS cacheReadTokens,
  json_extract(m.data, '$.tokens.cache.write') AS cacheWriteTokens,
  json_extract(m.data, '$.cost')               AS costUsd,
  m.session_id                                 AS sessionId
FROM message m
WHERE json_extract(m.data, '$.role') = 'assistant'
  AND json_extract(m.data, '$.tokens') IS NOT NULL
  AND json_extract(m.data, '$.time.completed') IS NOT NULL
  AND json_extract(m.data, '$.time.created') IS NOT NULL
ORDER BY createdMs
`

export type CollectOpenCodeUsageOptions = {
  timezone?: string
  collectedAt?: string
  since?: string
  dbPath?: string
  sqliteBin?: string
  runQuery?: RunSqliteQuery
  forceExternalSqlite?: boolean
  statFile?: (path: string) => Promise<{ mtimeMs: number }>
  stderr?: (line: string) => void
}

type OpenCodeUsageRow = {
  usageDate: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
  sessions: Set<string>
}

/**
 * Collect OpenCode usage from its local SQLite database.
 *
 * OpenCode aggregates per-session totals on the `session` table, but those
 * totals carry no date breakdown, so per-message rows are read and attributed
 * to a local date instead.
 */
export async function collectOpenCodeUsage(options: CollectOpenCodeUsageOptions = {}): Promise<UsageSnapshot[]> {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const dbPath = options.dbPath ?? defaultDbPath()
  const statFile = options.statFile ?? (async (path: string) => stat(path))

  try {
    // Establishes the database exists before querying, and keeps the WAL-aware
    // helper covered so a checkpoint-lagging file is never reported as absent.
    await sqliteDatabaseMtimeMs(dbPath, statFile)
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`${label} database not found: ${dbPath}`)
    }
    throw error
  }

  const sinceDate = readSinceDate(options.since, timezone)
  const rows = await querySqliteJsonRows(dbPath, usageRowsSql, {
    sqliteBin: options.sqliteBin,
    runQuery: options.runQuery,
    forceExternalSqlite: options.forceExternalSqlite ?? process.env.TOKENBOARD_SQLITE_BIN !== undefined,
    label
  })

  const aggregates = new Map<string, OpenCodeUsageRow>()
  let skippedRows = 0
  for (const row of rows) {
    const parsed = parseUsageRow(row, timezone)
    if (!parsed) {
      skippedRows += 1
      continue
    }
    if (sinceDate && parsed.usageDate < sinceDate) continue
    mergeUsageRow(aggregates, parsed)
  }
  if (skippedRows > 0) {
    options.stderr?.(`Skipped ${skippedRows} ${label} message rows without usable token metadata`)
  }

  return mergeSnapshots([...aggregates.values()].map((row) => toSnapshot(row, timezone, collectedAt)))
}

function parseUsageRow(row: Record<string, unknown>, timezone: string) {
  const createdMs = readNumber(row.createdMs)
  if (createdMs === null || createdMs <= 0) return null
  const createdAt = new Date(createdMs)
  if (Number.isNaN(createdAt.getTime())) return null

  const inputTokens = readCount(row.inputTokens)
  const outputTokens = readCount(row.outputTokens)
  const reasoningTokens = readCount(row.reasoningTokens)
  const cacheReadTokens = readCount(row.cacheReadTokens)
  const cacheCreationTokens = readCount(row.cacheWriteTokens)

  // Reasoning tokens are billed as output and are not a separate bucket.
  const billedOutputTokens = outputTokens + reasoningTokens
  if (inputTokens + billedOutputTokens + cacheReadTokens + cacheCreationTokens === 0) return null

  return {
    usageDate: formatDate(createdAt, timezone),
    model: readModel(row.model),
    inputTokens,
    outputTokens: billedOutputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    costUsd: Math.max(readNumber(row.costUsd) ?? 0, 0),
    sessions: new Set(readSessionId(row.sessionId))
  }
}

function mergeUsageRow(aggregates: Map<string, OpenCodeUsageRow>, row: OpenCodeUsageRow) {
  const key = `${row.usageDate}\0${row.model}`
  const current = aggregates.get(key)
  if (!current) {
    aggregates.set(key, row)
    return
  }
  current.inputTokens += row.inputTokens
  current.outputTokens += row.outputTokens
  current.cacheCreationTokens += row.cacheCreationTokens
  current.cacheReadTokens += row.cacheReadTokens
  current.costUsd += row.costUsd
  for (const session of row.sessions) current.sessions.add(session)
}

function toSnapshot(row: OpenCodeUsageRow, timezone: string, collectedAt: string) {
  return usageSnapshotSchema.parse({
    source,
    usageDate: row.usageDate,
    timezone,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheReadTokens: row.cacheReadTokens,
    totalTokens: row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
    costUsd: row.costUsd,
    sessionCount: row.sessions.size,
    collectedAt
  })
}

function readNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function readCount(value: unknown) {
  const parsed = readNumber(value)
  if (parsed === null || parsed <= 0) return 0
  return Math.trunc(parsed)
}

/** Model ids come from provider responses, so they are bounded before upload. */
function readModel(value: unknown) {
  if (typeof value !== 'string') return unknownModel
  const model = value.trim()
  if (!model) return unknownModel
  return model.length > maxModelNameLength ? model.slice(0, maxModelNameLength) : model
}

function readSessionId(value: unknown) {
  return typeof value === 'string' && value.trim() ? [value] : []
}

function readSinceDate(since: string | undefined, timezone: string) {
  const value = since ?? process.env.TOKENBOARD_SINCE ?? process.env.TOKENBOARD_DEFAULT_SINCE ?? ''
  if (!value) return ''
  const normalized = assertValidDateFilter(value, `${label} since value`, true)
  if (isAllDateFilter(normalized)) return ''
  const compact = normalized.replaceAll('-', '')
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}

function defaultDbPath() {
  if (process.env.TOKENBOARD_OPENCODE_DB) return process.env.TOKENBOARD_OPENCODE_DB
  const xdgDataHome = process.env.XDG_DATA_HOME
  if (xdgDataHome) return join(xdgDataHome, 'opencode', 'opencode.db')
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}
