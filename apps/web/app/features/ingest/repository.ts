import { snapshotHashPayload, type UsageSnapshot, type UsageSnapshotKey } from '@tokenboard/usage-core'

export type IngestRecord = UsageSnapshot & {
  userId: string
  deviceId: string
}

export type ExistingSnapshotHash = UsageSnapshotKey & {
  snapshotHash: string
}

const snapshotHashQueryChunkSize = 250
const snapshotUpsertBatchSize = 100

export async function upsertUsageSnapshots(db: D1Database, records: IngestRecord[]) {
  const sql = `
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
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd,
      session_count = excluded.session_count,
      snapshot_hash = excluded.snapshot_hash,
      synced_at = excluded.synced_at
  `

  for (let index = 0; index < records.length; index += snapshotUpsertBatchSize) {
    const batch = records.slice(index, index + snapshotUpsertBatchSize)
    const statements = await Promise.all(
      batch.map(async (record) =>
        db.prepare(sql).bind(
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
          record.collectedAt
        )
      )
    )

    if (statements.length > 0) {
      await db.batch(statements)
    }
  }

  return { upserted: records.length }
}

async function snapshotHash(snapshot: UsageSnapshot) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(snapshotHashPayload(snapshot))
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function findExistingSnapshotHashes(
  db: D1Database,
  input: {
    userId: string
    deviceId: string
    keys: UsageSnapshotKey[]
  }
): Promise<ExistingSnapshotHash[]> {
  if (input.keys.length === 0) {
    return []
  }

  const existing: ExistingSnapshotHash[] = []
  for (let index = 0; index < input.keys.length; index += snapshotHashQueryChunkSize) {
    const keys = input.keys.slice(index, index + snapshotHashQueryChunkSize)
    const predicates = keys.map(() => '(source = ? AND usage_date = ? AND model = ?)').join(' OR ')
    const bindings = keys.flatMap((key) => [key.source, key.usageDate, key.model])
    const rows = await db
      .prepare(
        `
          SELECT
            source,
            usage_date as usageDate,
            model,
            snapshot_hash as snapshotHash
          FROM daily_usage
          WHERE user_id = ?
            AND device_id = ?
            AND snapshot_hash IS NOT NULL
            AND (${predicates})
        `
      )
      .bind(input.userId, input.deviceId, ...bindings)
      .all<ExistingSnapshotHash>()

    existing.push(...(rows.results ?? []))
  }

  return existing
}

export async function markIngestSynced(
  db: D1Database,
  input: {
    uploadTokenHash: string
    deviceId: string | null
    syncedAt: string
  }
) {
  await db
    .prepare('UPDATE upload_tokens SET last_used_at = ? WHERE token_hash = ?')
    .bind(input.syncedAt, input.uploadTokenHash)
    .run()

  if (input.deviceId) {
    await db
      .prepare('UPDATE devices SET last_synced_at = ?, updated_at = ? WHERE id = ?')
      .bind(input.syncedAt, input.syncedAt, input.deviceId)
      .run()
  }
}
