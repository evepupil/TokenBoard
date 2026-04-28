import type { UsageSnapshot } from '@tokenboard/usage-core'
import type { AuthenticatedUser } from '../auth/middleware'
import { markIngestSynced, upsertUsageSnapshots } from './repository'

export async function ingestSnapshots(
  db: D1Database,
  user: AuthenticatedUser,
  snapshots: UsageSnapshot[],
  syncedAt = new Date().toISOString()
) {
  const result = await upsertUsageSnapshots(
    db,
    snapshots.map((snapshot) => ({ ...snapshot, userId: user.id }))
  )
  await markIngestSynced(db, {
    uploadTokenHash: user.uploadTokenHash,
    deviceId: user.deviceId,
    syncedAt
  })
  return result
}
