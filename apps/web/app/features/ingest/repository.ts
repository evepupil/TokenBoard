import type { UsageSnapshot } from '@tokenboard/usage-core'

export type IngestRecord = UsageSnapshot & {
  userId: string
  deviceId: string
}

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
      synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, source, usage_date, model) DO UPDATE SET
      timezone = excluded.timezone,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd,
      session_count = excluded.session_count,
      synced_at = excluded.synced_at
  `

  for (const record of records) {
    await db
      .prepare(sql)
      .bind(
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
        record.collectedAt
      )
      .run()
  }

  return { upserted: records.length }
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
