import type { UsageSnapshot } from '@tokenboard/usage-core'

export type IngestRecord = UsageSnapshot & {
  userId: string
}

export async function upsertUsageSnapshots(_records: IngestRecord[]) {
  return { upserted: _records.length }
}

