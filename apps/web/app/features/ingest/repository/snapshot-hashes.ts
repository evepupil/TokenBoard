import { listSummaryKeysNeedingRefresh } from './refresh'
import { snapshotHashQueryChunkSize, summaryKeyId, type ExistingSnapshotHash, type UsageSummaryKey } from './types'
import type { UsageSnapshotKey } from '@tokenboard/usage-core'

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
    const predicates = `(${keys.map(() => '?, ?, ?').join('), (')})`
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
            AND (source, usage_date, model) IN (VALUES ${predicates})
        `
      )
      .bind(input.userId, input.deviceId, ...bindings)
      .all<ExistingSnapshotHash>()

    existing.push(...(rows.results ?? []))
  }

  return filterExistingHashesWithCurrentCaches(db, input.userId, existing)
}

async function filterExistingHashesWithCurrentCaches(db: D1Database, userId: string, rows: ExistingSnapshotHash[]) {
  if (rows.length === 0) return []
  const staleSummaryKeys = await listSummaryKeysNeedingRefresh(
    db,
    rows.map((row) => ({
      userId,
      usageDate: row.usageDate,
      source: row.source,
      model: row.model
    }))
  )
  const staleKeyIds = new Set(staleSummaryKeys.map(summaryKeyId))
  return rows.filter((row) => !staleKeyIds.has(summaryKeyId({ userId, ...row } as UsageSummaryKey)))
}
