import {
  listSummaryKeysNeedingRefresh,
  prepareSummaryRefresh,
  prepareTotalsDeltaStatement,
  prepareUserTotalFromSummaryRefresh
} from './refresh'
import {
  runStatementBatches,
  snapshotHash,
  statementChanged,
  totalsDeltaKeyChunkSize,
  uniqueSummaryKeys,
  uniqueUserIds,
  type IngestRecord,
  type UsageSummaryKey
} from './types'

const snapshotUpsertBatchSize = 30

export async function upsertUsageSnapshots(db: D1Database, records: IngestRecord[]) {
  // One point read per request, before any batch: a user whose totals row is already there
  // gets delta maintenance; only a missing row falls back to the full refresh.
  const existingTotalsUserIds = await findExistingTotalsUserIds(db, uniqueUserIds(records))
  let upserted = 0
  for (let index = 0; index < records.length; index += snapshotUpsertBatchSize) {
    const batch = records.slice(index, index + snapshotUpsertBatchSize)
    upserted += await upsertUsageSnapshotBatch(db, batch, existingTotalsUserIds)
  }

  return { upserted }
}

async function upsertUsageSnapshotBatch(db: D1Database, records: IngestRecord[], existingTotalsUserIds: Set<string>) {
  if (records.length === 0) return 0
  const usageStatements = await Promise.all(records.map((record) => prepareUsageUpsert(db, record)))
  const results = await runStatementBatches(db, usageStatements)
  const changedRecords = records.filter((_, index) => statementChanged(results[index]))
  const unchangedRecords = records.filter((_, index) => !statementChanged(results[index]))
  const missingOrStaleSummaryKeys = await listSummaryKeysNeedingRefresh(db, unchangedRecords)
  const summaryKeysToRefresh = uniqueSummaryKeys([...changedRecords, ...missingOrStaleSummaryKeys])
  if (summaryKeysToRefresh.length === 0) {
    return changedRecords.length
  }

  const stamp = new Date().toISOString()
  const refreshStatements = [
    ...totalsDeltaStatements(
      db,
      summaryKeysToRefresh.filter((key) => existingTotalsUserIds.has(key.userId)),
      stamp
    ),
    ...summaryKeysToRefresh.map((key) => prepareSummaryRefresh(db, key, stamp)),
    ...uniqueUserIds(summaryKeysToRefresh)
      .filter((userId) => !existingTotalsUserIds.has(userId))
      .map((userId) => prepareUserTotalFromSummaryRefresh(db, userId, stamp))
  ]
  await runStatementBatches(db, refreshStatements)
  return changedRecords.length
}

const userTotalsExistsSql = `
  SELECT user_id as userId
  FROM user_usage_totals
  WHERE user_id IN (SELECT value FROM json_each(?))
`

async function findExistingTotalsUserIds(db: D1Database, userIds: string[]) {
  if (userIds.length === 0) return new Set<string>()
  const bound = db.prepare(userTotalsExistsSql).bind(JSON.stringify(userIds)) as {
    all?: () => Promise<{ results?: { userId: string }[] }>
  }
  if (typeof bound.all !== 'function') return new Set<string>()
  const rows = await bound.all()
  return new Set((rows.results ?? []).map((row) => row.userId))
}

function totalsDeltaStatements(db: D1Database, keys: UsageSummaryKey[], stamp: string) {
  const statements = []
  for (let index = 0; index < keys.length; index += totalsDeltaKeyChunkSize) {
    statements.push(prepareTotalsDeltaStatement(db, keys.slice(index, index + totalsDeltaKeyChunkSize), stamp))
  }
  return statements
}

async function prepareUsageUpsert(db: D1Database, record: IngestRecord) {
  const correctionFlag = record.correction ? 1 : 0
  return db.prepare(upsertUsageSql).bind(
    record.userId,
    record.deviceId,
    record.source,
    record.usageDate,
    record.timezone,
    record.model,
    record.inputTokens,
    record.outputTokens,
    record.cacheCreationTokens,
    record.cacheReadTokens,
    record.totalTokens,
    record.costUsd,
    record.sessionCount,
    await snapshotHash(record),
    // This column is the last-writer-wins freshness marker for the snapshot;
    // server receipt time is tracked separately by the device heartbeat rows.
    record.collectedAt,
    // One correction-flag bind per `?` that guards a correction exemption: six in the
    // token/cost CASE arms, and one in the WHERE clause.
    ...Array.from({ length: 7 }, () => correctionFlag)
  )
}

const preserveCodexSessionOnlySql = `
  ? = 0
  AND excluded.source = 'codex'
  AND excluded.input_tokens = 0
  AND excluded.output_tokens = 0
  AND excluded.cache_creation_tokens = 0
  AND excluded.cache_read_tokens = 0
  AND excluded.total_tokens = 0
  AND excluded.session_count > 0
  AND (
    daily_usage.input_tokens > 0
    OR daily_usage.output_tokens > 0
    OR daily_usage.cache_creation_tokens > 0
    OR daily_usage.cache_read_tokens > 0
    OR daily_usage.total_tokens > 0
    OR daily_usage.cost_usd > 0
  )
`

/**
 * A re-upload whose only difference is `costUsd` overwrites the stored cost.
 *
 * The snapshot hash covers `costUsd`, so a re-price IS a different snapshot by the protocol's
 * own definition, and the `snapshot_hash <> excluded.snapshot_hash` guard below lets that update
 * through. The cost column therefore has to follow the payload. Freezing it on the theory that
 * "identical token counts mean the old measurement" left the row describing a snapshot that was
 * never stored: `snapshot_hash` was still assigned `excluded.snapshot_hash`, so the stored hash
 * no longer matched the stored row, and anything that recomputes the hash from the row would
 * read it as never delivered.
 *
 * This is the accepted semantic of the native-client design (D7,
 * `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md` §9.4.1): a cost-accounting
 * change reaches history through the client's next upload, and the diff is tracked in
 * `docs/research/2026-11-13-s5-migration-diff-ledger.md` rather than blocked here.
 *
 * Not every branch below keeps `snapshot_hash` equal to the stored row, and it is worth being
 * precise about that: `preserveCodexSessionOnlySql` deliberately keeps the stored tokens AND cost
 * while the statement still writes the incoming hash — that is its whole purpose (a token-less
 * session-only report must not wipe a row's usage), so a recomputation from the row would differ
 * there by design. The invariant this file guarantees is the narrower, checkable one: **for a row
 * whose tokens the statement replaced, the stored cost is the payload's cost** — which is what
 * `idempotency.sqlite.test.ts` asserts.
 */
const upsertUsageSql = `
  INSERT INTO daily_usage (
    user_id,
    device_id,
    source,
    usage_date,
    timezone,
    model,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    total_tokens,
    cost_usd,
    session_count,
    snapshot_hash,
    synced_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, device_id, source, usage_date, model) DO UPDATE SET
    timezone = excluded.timezone,
    input_tokens = CASE WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.input_tokens ELSE excluded.input_tokens END,
    output_tokens = CASE WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.output_tokens ELSE excluded.output_tokens END,
    cache_creation_tokens = CASE WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.cache_creation_tokens ELSE excluded.cache_creation_tokens END,
    cache_read_tokens = CASE WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.cache_read_tokens ELSE excluded.cache_read_tokens END,
    total_tokens = CASE WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.total_tokens ELSE excluded.total_tokens END,
    cost_usd = CASE
      WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.cost_usd
      ELSE excluded.cost_usd
    END,
    session_count = excluded.session_count,
    snapshot_hash = excluded.snapshot_hash,
    synced_at = excluded.synced_at
  WHERE (
    daily_usage.snapshot_hash IS NULL
    OR daily_usage.snapshot_hash <> excluded.snapshot_hash
  )
  AND NOT (
    ? = 0
    AND
    excluded.source = 'codex'
    AND excluded.input_tokens = 0
    AND excluded.output_tokens = 0
    AND excluded.cache_creation_tokens = 0
    AND excluded.cache_read_tokens = 0
    AND excluded.total_tokens = 0
    AND excluded.session_count = 0
    AND (
      daily_usage.input_tokens > 0
      OR daily_usage.output_tokens > 0
      OR daily_usage.cache_creation_tokens > 0
      OR daily_usage.cache_read_tokens > 0
      OR daily_usage.total_tokens > 0
      OR daily_usage.cost_usd > 0
    )
  )
  AND (
    julianday(daily_usage.synced_at) IS NULL
    OR julianday(excluded.synced_at) >= julianday(daily_usage.synced_at)
  )
`
