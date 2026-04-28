import type { UsageSnapshot } from '@tokenboard/usage-core'
import { upsertUsageSnapshots } from './repository'

export async function ingestSnapshots(db: D1Database, userId: string, snapshots: UsageSnapshot[]) {
  return upsertUsageSnapshots(db, snapshots.map((snapshot) => ({ ...snapshot, userId })))
}
