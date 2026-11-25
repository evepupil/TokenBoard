import { snapshotHashPayload, type UsageSnapshot, type UsageSnapshotKey } from '@tokenboard/usage-core'

export type IngestRecord = UsageSnapshot & {
  userId: string
  deviceId: string
}

export type ExistingSnapshotHash = UsageSnapshotKey & {
  snapshotHash: string
}

export type UsageSummaryKey = Pick<IngestRecord, 'userId' | 'usageDate' | 'source' | 'model'>

export const d1MaxBoundParameters = 100
export const d1MaxBatchStatements = 100
// Every derived chunk size leaves at least one parameter of headroom below the D1 limit. The
// exact-limit version is legal today, but a future change that adds a binding to the same
// statement would push it over and fail only in production. (The snapshot-hash formula already
// had two parameters of slack from its integer division, so subtracting the headroom there
// changes nothing; the other two were sitting exactly on the limit.)
export const d1BoundParameterHeadroom = 1
export const snapshotHashKeyParameterCount = 3
export const snapshotHashBaseParameterCount = 2
export const summaryRefreshCheckParameterCount = 4
export const usageSummaryBackfillStateId = 'initial'
export const backfillLookahead = 1
export const snapshotHashQueryChunkSize = Math.floor(
  (d1MaxBoundParameters - d1BoundParameterHeadroom - snapshotHashBaseParameterCount) / snapshotHashKeyParameterCount
)
export const summaryRefreshCheckChunkSize = Math.floor(
  (d1MaxBoundParameters - d1BoundParameterHeadroom) / summaryRefreshCheckParameterCount
)
export const totalRefreshCheckChunkSize = d1MaxBoundParameters - d1BoundParameterHeadroom
// Four key columns per row plus the one trailing timestamp, kept under the D1 bound-parameter
// limit. 15 keys -> 60 bindings, leaving headroom for the timestamp and future additions.
export const totalsDeltaKeyChunkSize = 15

export async function runStatementBatches(db: D1Database, statements: D1PreparedStatement[]) {
  const results: D1Result<unknown>[] = []
  for (let index = 0; index < statements.length; index += d1MaxBatchStatements) {
    const batchResults = await db.batch(statements.slice(index, index + d1MaxBatchStatements))
    assertBatchSucceeded(batchResults)
    results.push(...batchResults)
  }
  return results
}

export function statementChanged(result: D1Result<unknown> | undefined) {
  if (result?.meta?.changes === undefined) return true
  const changes = Number(result.meta.changes)
  if (!Number.isFinite(changes)) return true
  return changes > 0
}

export async function snapshotHash(snapshot: UsageSnapshot) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshotHashPayload(snapshot)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function uniqueSummaryKeys(records: UsageSummaryKey[]) {
  const keys = new Map<string, UsageSummaryKey>()
  for (const record of records) {
    const key = summaryKeyId(record)
    if (!keys.has(key)) {
      keys.set(key, {
        userId: record.userId,
        usageDate: record.usageDate,
        source: record.source,
        model: record.model
      })
    }
  }
  return [...keys.values()]
}

export function summaryKeyId(key: UsageSummaryKey) {
  return `${key.userId}\0${key.usageDate}\0${key.source}\0${key.model}`
}

export function uniqueUserIds(records: Array<Pick<IngestRecord, 'userId'>>) {
  return [...new Set(records.map((record) => record.userId))]
}

function assertBatchSucceeded(results: D1Result<unknown>[]) {
  const batchResults = results as Array<{ success?: boolean; error?: string }>
  const failedIndex = batchResults.findIndex((result) => result.success === false)
  if (failedIndex < 0) return

  const error = batchResults[failedIndex]?.error
  throw new Error(`D1 batch statement ${failedIndex + 1} failed${error ? `: ${error}` : ''}`)
}
