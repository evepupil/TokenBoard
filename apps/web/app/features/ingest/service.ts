import type { UsageSnapshot, UsageSnapshotKey } from '@tokenboard/usage-core'
import type { AuthenticatedUser } from '../auth/middleware'
import { findExistingSnapshotHashes, markIngestSynced, upsertUsageSnapshots } from './repository'

const legacyDeviceId = 'legacy'

export async function ingestSnapshots(
  db: D1Database,
  user: AuthenticatedUser,
  snapshots: UsageSnapshot[],
  syncedAt = new Date().toISOString()
) {
  const result = await upsertUsageSnapshots(
    db,
    snapshots.map((snapshot) => ({
      ...snapshot,
      userId: user.id,
      deviceId: user.deviceId ?? legacyDeviceId
    }))
  )
  await markIngestSynced(db, {
    uploadTokenHash: user.uploadTokenHash,
    deviceId: user.deviceId,
    syncedAt
  })
  return result
}

export async function checkExistingSnapshots(
  db: D1Database,
  user: AuthenticatedUser,
  keys: UsageSnapshotKey[]
) {
  const existing = await findExistingSnapshotHashes(db, {
    userId: user.id,
    deviceId: user.deviceId ?? legacyDeviceId,
    keys
  })
  return { existing }
}
