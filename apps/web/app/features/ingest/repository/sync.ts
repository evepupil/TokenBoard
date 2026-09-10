import { runStatementBatches } from './types'

export async function markIngestSynced(
  db: D1Database,
  input: {
    uploadTokenHash: string
    deviceId: string | null
    installationId?: string | null
    syncedAt: string
  }
) {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE upload_tokens
       SET last_used_at = ?
       WHERE token_hash = ?
         AND (last_used_at IS NULL OR last_used_at <= ?)`
      )
      .bind(input.syncedAt, input.uploadTokenHash, input.syncedAt)
  ]

  if (input.deviceId) {
    statements.push(
      db
        .prepare(
          `UPDATE devices
         SET last_synced_at = ?, updated_at = ?
         WHERE id = ?
           AND (last_synced_at IS NULL OR last_synced_at <= ?)`
        )
        .bind(input.syncedAt, input.syncedAt, input.deviceId, input.syncedAt)
    )
  }

  if (input.installationId) {
    statements.push(
      db
        .prepare(
          `
          UPDATE device_installations
          SET last_seen_at = ?, updated_at = ?
          WHERE id = ?
            AND (last_seen_at IS NULL OR last_seen_at <= ?)
            AND user_id = (
              SELECT user_id FROM upload_tokens WHERE token_hash = ? LIMIT 1
            )
        `
        )
        .bind(input.syncedAt, input.syncedAt, input.installationId, input.syncedAt, input.uploadTokenHash)
    )
  }
  await runStatementBatches(db, statements)
}
