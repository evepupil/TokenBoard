import {
  prepareSummaryRefresh,
  prepareUserTotalFromSummaryRefresh
} from './refresh'
import {
  backfillLookahead,
  runStatementBatches,
  usageSummaryBackfillStateId,
  type UsageSummaryKey
} from './types'
import {
  summaryBackfillCursorSql,
  summaryBackfillInitialSql,
  totalsBackfillCursorSql,
  totalsBackfillInitialSql
} from './backfill-sql'

type UsageSummaryBackfillEnv = {
  TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT?: string
}
type UsageSummaryBackfillPhase = 'summaries' | 'totals'
type UsageSummaryBackfillState = {
  phase: UsageSummaryBackfillPhase
  cursorUserId: string | null
  cursorUsageDate: string | null
  cursorSource: string | null
  cursorModel: string | null
  completedAt: string | null
}
type UsageSummaryBackfillRow = {
  phase: string | null
  cursorUserId: string | null
  cursorUsageDate: string | null
  cursorSource: string | null
  cursorModel: string | null
  completedAt: string | null
}

export const defaultUsageSummaryBackfillLimit = 50
export const maxUsageSummaryBackfillLimit = 500

export async function backfillUsageSummaryCache(input: {
  db: D1Database
  limit: number
}) {
  const state = await readUsageSummaryBackfillState(input.db)
  if (state.completedAt) return { backfilled: 0, totalsRefreshed: 0 }
  if (state.phase === 'totals') {
    return refreshBackfillTotals(input, state.cursorUserId)
  }
  return refreshBackfillSummaries(input, state)
}

export function usageSummaryBackfillLimit(env: UsageSummaryBackfillEnv) {
  const raw = env.TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT
  if (raw === undefined) return defaultUsageSummaryBackfillLimit
  const value = raw.trim()
  if (!/^\d+$/.test(value)) throw invalidUsageSummaryBackfillLimitError()
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxUsageSummaryBackfillLimit) {
    throw invalidUsageSummaryBackfillLimitError()
  }
  return limit
}

async function refreshBackfillSummaries(
  input: {
    db: D1Database
    limit: number
  },
  state: UsageSummaryBackfillState
) {
  const keys = await listSummaryKeysForBackfill({
    db: input.db,
    limit: input.limit + backfillLookahead,
    state
  })
  const keysToRefresh = keys.slice(0, input.limit)
  await runStatementBatches(input.db, keysToRefresh.map((key) => prepareSummaryRefresh(input.db, key)))

  const hasMoreSummaries = keys.length > input.limit
  if (hasMoreSummaries) {
    await writeUsageSummaryBackfillState(input.db, summaryStateFromCursor(keysToRefresh.at(-1)))
    return { backfilled: keysToRefresh.length, totalsRefreshed: 0 }
  }

  await writeUsageSummaryBackfillState(input.db, totalsBackfillState(null))
  const totalsLimit = input.limit - keysToRefresh.length
  if (totalsLimit < 1) {
    return { backfilled: keysToRefresh.length, totalsRefreshed: 0 }
  }

  const totals = await refreshBackfillTotals(
    { db: input.db, limit: totalsLimit },
    null
  )
  return {
    backfilled: keysToRefresh.length,
    totalsRefreshed: totals.totalsRefreshed
  }
}

async function refreshBackfillTotals(
  input: {
    db: D1Database
    limit: number
  },
  cursorUserId: string | null
) {
  const userIds = await listUserIdsForTotalsBackfill({
    db: input.db,
    limit: input.limit + backfillLookahead,
    cursorUserId
  })
  const userIdsToRefresh = userIds.slice(0, input.limit)
  await runStatementBatches(
    input.db,
    userIdsToRefresh.map((userId) => prepareUserTotalFromSummaryRefresh(input.db, userId))
  )

  if (userIds.length > input.limit) {
    await writeUsageSummaryBackfillState(input.db, totalsBackfillState(userIdsToRefresh.at(-1) ?? null))
  } else {
    await writeUsageSummaryBackfillState(input.db, completedBackfillState())
  }

  return { backfilled: 0, totalsRefreshed: userIdsToRefresh.length }
}

async function listSummaryKeysForBackfill(input: {
  db: D1Database
  limit: number
  state: UsageSummaryBackfillState
}) {
  const cursor = summaryBackfillCursor(input.state)
  const statement = cursor
    ? input.db.prepare(summaryBackfillCursorSql).bind(...cursor, input.limit)
    : input.db.prepare(summaryBackfillInitialSql).bind(input.limit)
  const rows = await statement.all<UsageSummaryKey>()

  return rows.results ?? []
}

async function listUserIdsForTotalsBackfill(input: {
  db: D1Database
  limit: number
  cursorUserId: string | null
}) {
  const statement = input.cursorUserId
    ? input.db.prepare(totalsBackfillCursorSql).bind(input.cursorUserId, input.limit)
    : input.db.prepare(totalsBackfillInitialSql).bind(input.limit)
  const rows = await statement.all<{ userId: string }>()

  return (rows.results ?? []).map((row) => row.userId)
}

async function readUsageSummaryBackfillState(db: D1Database): Promise<UsageSummaryBackfillState> {
  const row = await db
    .prepare(
      `
        SELECT
          phase,
          cursor_user_id as cursorUserId,
          cursor_usage_date as cursorUsageDate,
          cursor_source as cursorSource,
          cursor_model as cursorModel,
          completed_at as completedAt
        FROM usage_summary_backfill_state
        WHERE id = ?
      `
    )
    .bind(usageSummaryBackfillStateId)
    .first<UsageSummaryBackfillRow>()

  return normalizeBackfillState(row)
}

async function writeUsageSummaryBackfillState(
  db: D1Database,
  state: UsageSummaryBackfillState
) {
  await db
    .prepare(
      `
        INSERT INTO usage_summary_backfill_state (
          id,
          phase,
          cursor_user_id,
          cursor_usage_date,
          cursor_source,
          cursor_model,
          completed_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(id) DO UPDATE SET
          phase = excluded.phase,
          cursor_user_id = excluded.cursor_user_id,
          cursor_usage_date = excluded.cursor_usage_date,
          cursor_source = excluded.cursor_source,
          cursor_model = excluded.cursor_model,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `
    )
    .bind(
      usageSummaryBackfillStateId,
      state.phase,
      state.cursorUserId,
      state.cursorUsageDate,
      state.cursorSource,
      state.cursorModel,
      state.completedAt
    )
    .run()
}

function normalizeBackfillState(
  row: UsageSummaryBackfillRow | null
): UsageSummaryBackfillState {
  if (!row) return summariesBackfillState(null)
  const phase = row.phase === 'totals' ? 'totals' : 'summaries'
  return {
    phase,
    cursorUserId: row.cursorUserId ?? null,
    cursorUsageDate: row.cursorUsageDate ?? null,
    cursorSource: row.cursorSource ?? null,
    cursorModel: row.cursorModel ?? null,
    completedAt: row.completedAt ?? null
  }
}

function summaryStateFromCursor(
  cursor: UsageSummaryKey | undefined
): UsageSummaryBackfillState {
  if (!cursor) return summariesBackfillState(null)
  return summariesBackfillState(cursor)
}

function summariesBackfillState(
  cursor: UsageSummaryKey | null
): UsageSummaryBackfillState {
  return {
    phase: 'summaries',
    cursorUserId: cursor?.userId ?? null,
    cursorUsageDate: cursor?.usageDate ?? null,
    cursorSource: cursor?.source ?? null,
    cursorModel: cursor?.model ?? null,
    completedAt: null
  }
}

function totalsBackfillState(cursorUserId: string | null): UsageSummaryBackfillState {
  return {
    phase: 'totals',
    cursorUserId,
    cursorUsageDate: null,
    cursorSource: null,
    cursorModel: null,
    completedAt: null
  }
}

function completedBackfillState(): UsageSummaryBackfillState {
  return {
    phase: 'totals',
    cursorUserId: null,
    cursorUsageDate: null,
    cursorSource: null,
    cursorModel: null,
    completedAt: new Date().toISOString()
  }
}

function summaryBackfillCursor(state: UsageSummaryBackfillState) {
  const values = [state.cursorUserId, state.cursorUsageDate, state.cursorSource, state.cursorModel]
  const hasCursor = values.some((value) => value !== null && value !== undefined)
  if (!hasCursor) return null
  if (values.some((value) => value === null || value === undefined || value === '')) {
    throw new Error('Usage summary backfill cursor is incomplete')
  }
  return [state.cursorUserId, state.cursorUsageDate, state.cursorSource, state.cursorModel] as const
}

function invalidUsageSummaryBackfillLimitError() {
  return new Error(
    `TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to ${maxUsageSummaryBackfillLimit}`
  )
}
