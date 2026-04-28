import type { UsageSnapshot } from '@tokenboard/usage-core'
import { upsertUsageSnapshots } from './repository'

export async function ingestSnapshots(userId: string, snapshots: UsageSnapshot[]) {
  return upsertUsageSnapshots(snapshots.map((snapshot) => ({ ...snapshot, userId })))
}

