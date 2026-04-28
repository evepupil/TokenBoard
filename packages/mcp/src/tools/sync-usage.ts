import { uploadSnapshots, type CollectorConfig } from '@tokenboard/collector'
import type { UsageSnapshot } from '@tokenboard/usage-core'

export async function syncUsage(config: CollectorConfig, snapshots: UsageSnapshot[]) {
  return uploadSnapshots(config, snapshots)
}

