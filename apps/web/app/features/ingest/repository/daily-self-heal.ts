import {
  listSummaryKeysNeedingRefresh,
  listUserIdsNeedingTotalRefresh,
  prepareSummaryRefresh,
  prepareTotalsDeltaStatement,
  prepareUserTotalFromSummaryRefresh
} from './refresh'
import { runStatementBatches, type UsageSummaryKey } from './types'

export const dailySelfHealStateId = 'daily-self-heal'
export const dailySelfHealKeyLimit = 200
export const dailySelfHealUserLimit = 50
// Each orphan needs a delta and a delete statement, so the page is capped at half the D1
// batch-statement limit; a page never spans two transactions.
export const dailySelfHealOrphanLimit = 50

type HealPhase = 'summaries' | 'totals' | 'orphans' | 'done'
type HealState = {
  phase: HealPhase
  cursor: UsageSummaryKey | null
  cursorUserId: string | null
  completedAt: string | null
  updatedAt: string | null
}

const readStateSql = `
  SELECT phase, cursor_user_id as cursorUserId, cursor_usage_date as cursorUsageDate,
         cursor_source as cursorSource, cursor_model as cursorModel,
         completed_at as completedAt, updated_at as updatedAt
  FROM usage_summary_backfill_state
  WHERE id = ?
`

const writeStateSql = `
  INSERT INTO usage_summary_backfill_state (
    id, phase, cursor_user_id, cursor_usage_date, cursor_source, cursor_model, completed_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    phase = excluded.phase,
    cursor_user_id = excluded.cursor_user_id,
    cursor_usage_date = excluded.cursor_usage_date,
    cursor_source = excluded.cursor_source,
    cursor_model = excluded.cursor_model,
    completed_at = excluded.completed_at,
    updated_at = excluded.updated_at
`

const deleteSummarySql = `
  DELETE FROM daily_usage_summary
  WHERE user_id = ? AND usage_date = ? AND source = ? AND model = ?
`

export async function runDailyUsageSelfHeal(input: { db: D1Database; now: Date }) {
  const stamp = input.now.toISOString()
  const today = stamp.slice(0, 10)
  let state = await readState(input.db)
  if (!state || !state.updatedAt?.startsWith(today)) {
    state = { phase: 'summaries', cursor: null, cursorUserId: null, completedAt: null, updatedAt: null }
  }
  if (state.phase === 'done') return { summariesHealed: 0, totalsHealed: 0, orphansRemoved: 0 }

  if (state.phase === 'summaries') {
    const candidates = await listSummaryPage(input.db, state.cursor, dailySelfHealKeyLimit + 1)
    const page = candidates.slice(0, dailySelfHealKeyLimit)
    const stale = await listSummaryKeysNeedingRefresh(input.db, page)
    if (stale.length > 0) {
      await runStatementBatches(
        input.db,
        stale.map((key) => prepareSummaryRefresh(input.db, key, stamp))
      )
    }
    const more = candidates.length > dailySelfHealKeyLimit
    await writeState(input.db, {
      phase: more ? 'summaries' : 'totals',
      // The totals phase pages by user id, so it must start from the beginning rather than
      // inherit the summary cursor (which is a full key and would skip its own user).
      cursor: more ? (page.at(-1) ?? state.cursor) : null,
      cursorUserId: null,
      completedAt: null,
      updatedAt: stamp
    })
    return { summariesHealed: stale.length, totalsHealed: 0, orphansRemoved: 0 }
  }

  if (state.phase === 'totals') {
    const candidates = await listUserPage(input.db, state.cursorUserId, dailySelfHealUserLimit + 1)
    const page = candidates.slice(0, dailySelfHealUserLimit)
    const stale = await listUserIdsNeedingTotalRefresh(input.db, page)
    if (stale.length > 0) {
      await runStatementBatches(
        input.db,
        stale.map((userId) => prepareUserTotalFromSummaryRefresh(input.db, userId, stamp))
      )
    }
    const more = candidates.length > dailySelfHealUserLimit
    await writeState(input.db, {
      phase: more ? 'totals' : 'orphans',
      cursor: null,
      cursorUserId: more ? (page.at(-1) ?? state.cursorUserId) : null,
      completedAt: null,
      updatedAt: stamp
    })
    return { summariesHealed: 0, totalsHealed: stale.length, orphansRemoved: 0 }
  }

  const orphans = await listOrphanPage(input.db, state.cursor, dailySelfHealOrphanLimit + 1)
  if (orphans.length === 0) {
    await writeState(input.db, {
      phase: 'done',
      cursor: null,
      cursorUserId: null,
      completedAt: stamp,
      updatedAt: stamp
    })
    return { summariesHealed: 0, totalsHealed: 0, orphansRemoved: 0 }
  }

  const page = orphans.slice(0, dailySelfHealOrphanLimit)
  const statements = page.flatMap((key) => [
    prepareTotalsDeltaStatement(input.db, [key], stamp),
    input.db.prepare(deleteSummarySql).bind(key.userId, key.usageDate, key.source, key.model)
  ])
  await runStatementBatches(input.db, statements)
  const next = page.at(-1) ?? state.cursor
  await writeState(input.db, {
    phase: orphans.length > dailySelfHealOrphanLimit ? 'orphans' : 'done',
    cursor: next,
    cursorUserId: null,
    completedAt: orphans.length > dailySelfHealOrphanLimit ? null : stamp,
    updatedAt: stamp
  })
  return { summariesHealed: 0, totalsHealed: 0, orphansRemoved: page.length }
}

async function readState(db: D1Database): Promise<HealState | null> {
  const row = await db.prepare(readStateSql).bind(dailySelfHealStateId).first<Record<string, unknown>>()
  if (!row) return null
  const phase = row.phase
  return {
    phase: phase === 'totals' || phase === 'orphans' || phase === 'done' ? phase : 'summaries',
    cursor: row.cursorUserId
      ? {
          userId: row.cursorUserId as string,
          usageDate: row.cursorUsageDate as string,
          source: row.cursorSource as UsageSummaryKey['source'],
          model: row.cursorModel as string
        }
      : null,
    cursorUserId: (row.cursorUserId as string | null) ?? null,
    completedAt: (row.completedAt as string | null) ?? null,
    updatedAt: (row.updatedAt as string | null) ?? null
  }
}

async function writeState(db: D1Database, state: HealState) {
  await db
    .prepare(writeStateSql)
    .bind(
      dailySelfHealStateId,
      state.phase,
      state.cursor?.userId ?? null,
      state.cursor?.usageDate ?? null,
      state.cursor?.source ?? null,
      state.cursor?.model ?? null,
      state.completedAt,
      state.updatedAt
    )
    .run()
}

async function listSummaryPage(db: D1Database, cursor: UsageSummaryKey | null, limit: number) {
  const rows = await db
    .prepare(
      `
        SELECT DISTINCT user_id as userId, usage_date as usageDate, source, model
        FROM daily_usage
        ${cursor ? `WHERE (user_id, usage_date, source, model) > (?, ?, ?, ?)` : ''}
        ORDER BY user_id, usage_date, source, model
        LIMIT ?
      `
    )
    .bind(...(cursor ? [cursor.userId, cursor.usageDate, cursor.source, cursor.model] : []), limit)
    .all<UsageSummaryKey>()
  return rows.results ?? []
}

async function listUserPage(db: D1Database, cursorUserId: string | null, limit: number) {
  const rows = await db
    .prepare(
      `
        SELECT user_id as userId
        FROM daily_usage_summary
        ${cursorUserId ? `WHERE user_id > ?` : ''}
        GROUP BY user_id
        ORDER BY user_id
        LIMIT ?
      `
    )
    .bind(...(cursorUserId ? [cursorUserId] : []), limit)
    .all<{ userId: string }>()
  return (rows.results ?? []).map((row) => row.userId)
}

async function listOrphanPage(db: D1Database, cursor: UsageSummaryKey | null, limit: number) {
  const rows = await db
    .prepare(
      `
        SELECT s.user_id as userId, s.usage_date as usageDate, s.source, s.model
        FROM daily_usage_summary s
        ${cursor ? `WHERE (s.user_id, s.usage_date, s.source, s.model) > (?, ?, ?, ?)` : ''}
        ${cursor ? 'AND' : 'WHERE'} NOT EXISTS (
          SELECT 1 FROM daily_usage d
          WHERE d.user_id = s.user_id
            AND d.usage_date = s.usage_date
            AND d.source = s.source
            AND d.model = s.model
        )
        ORDER BY s.user_id, s.usage_date, s.source, s.model
        LIMIT ?
      `
    )
    .bind(...(cursor ? [cursor.userId, cursor.usageDate, cursor.source, cursor.model] : []), limit)
    .all<UsageSummaryKey>()
  return rows.results ?? []
}
