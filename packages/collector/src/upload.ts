import {
  snapshotHashPayload,
  snapshotKey,
  type UsageSnapshot,
  type UsageSnapshotKey
} from '@tokenboard/usage-core'
import type { CollectorConfig } from './config'

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

const snapshotBatchSize = 500
const transientFetchAttempts = 3

export type ExistingSnapshotHash = UsageSnapshotKey & {
  snapshotHash: string
}

export async function uploadSnapshots(
  config: CollectorConfig,
  snapshots: UsageSnapshot[],
  fetcher: Fetcher = fetch
): Promise<unknown> {
  if (snapshots.length === 0) {
    return { upserted: 0, skipped: 0 }
  }

  let upserted = 0
  let skipped = 0
  let uploaded = false

  for (const batch of chunkSnapshots(snapshots, snapshotBatchSize)) {
    const checked = await filterChangedSnapshots(batch, (keys) =>
      fetchExistingSnapshotHashes(config, keys, fetcher)
    )
    skipped += checked.skipped

    if (checked.snapshots.length === 0) {
      continue
    }

    upserted += await uploadSnapshotBatch(config, checked.snapshots, fetcher)
    uploaded = true
  }

  if (!uploaded) {
    upserted += await uploadSnapshotBatch(config, [], fetcher)
  }

  return { upserted, skipped }
}

export async function filterChangedSnapshots(
  snapshots: UsageSnapshot[],
  readExisting: (keys: UsageSnapshotKey[]) => Promise<{ existing: ExistingSnapshotHash[] }>
) {
  const existing = await readExisting(
    snapshots.map((snapshot) => ({
      source: snapshot.source,
      usageDate: snapshot.usageDate,
      model: snapshot.model
    }))
  )
  const hashes = new Map(existing.existing.map((row) => [snapshotKey(row), row.snapshotHash]))
  const changed: UsageSnapshot[] = []
  let skipped = 0

  for (const snapshot of snapshots) {
    if (hashes.get(snapshotKey(snapshot)) === await snapshotHash(snapshot)) {
      skipped += 1
      continue
    }
    changed.push(snapshot)
  }

  return {
    snapshots: changed,
    skipped
  }
}

export async function snapshotHash(snapshot: UsageSnapshot) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(snapshotHashPayload(snapshot))
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function fetchExistingSnapshotHashes(
  config: CollectorConfig,
  keys: UsageSnapshotKey[],
  fetcher: Fetcher
) {
  if (keys.length === 0) {
    return { existing: [] }
  }

  const response = await fetchWithRetries(fetcher, `${config.endpoint}/check`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.uploadToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ keys })
  })

  if (isUnsupportedSnapshotCheckResponse(response)) {
    return { existing: [] }
  }

  if (!response.ok) {
    throw new Error(`Snapshot check failed with status ${response.status}`)
  }

  return response.json() as Promise<{ existing: ExistingSnapshotHash[] }>
}

function isUnsupportedSnapshotCheckResponse(response: Response) {
  return response.status === 404 || response.status === 405 || response.status === 501
}

async function uploadSnapshotBatch(
  config: CollectorConfig,
  snapshots: UsageSnapshot[],
  fetcher: Fetcher
) {
  const response = await fetchWithRetries(fetcher, config.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.uploadToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ snapshots })
  })

  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`)
  }

  const result = (await response.json()) as Record<string, unknown>
  return typeof result.upserted === 'number' ? result.upserted : 0
}

function chunkSnapshots(snapshots: UsageSnapshot[], size: number) {
  const batches: UsageSnapshot[][] = []
  for (let index = 0; index < snapshots.length; index += size) {
    batches.push(snapshots.slice(index, index + size))
  }
  return batches
}

async function fetchWithRetries(fetcher: Fetcher, url: string, init: RequestInit) {
  let lastError: unknown
  for (let attempt = 0; attempt < transientFetchAttempts; attempt += 1) {
    try {
      return await fetcher(url, init)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
