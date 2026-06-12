import {
  maxUsageModelNameLength,
  snapshotHashPayload,
  snapshotKey,
  type UsageSnapshot,
  type UsageSnapshotKey
} from '@tokenboard/usage-core'
import type { CollectorConfig } from './config'

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

const snapshotBatchSize = 30
const transientFetchAttempts = 3
const defaultRetryDelayMs = 250
const maxRetryDelayMs = 5_000
const usageDatePattern = /^\d{4}-\d{2}-\d{2}$/
const snapshotHashPattern = /^[a-f0-9]{64}$/

export type ExistingSnapshotHash = UsageSnapshotKey & {
  snapshotHash: string
}

export async function uploadSnapshots(
  config: CollectorConfig,
  snapshots: UsageSnapshot[],
  fetcher: Fetcher = fetch
): Promise<unknown> {
  if (snapshots.length === 0) {
    const upserted = await uploadSnapshotBatch(config, [], fetcher)
    return { upserted, skipped: 0 }
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

  return parseExistingSnapshotHashResponse(await response.json())
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

  return parseUploadResponse(await response.json())
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
      const response = await fetcher.call(globalThis, url, init)
      if (!isRetryableResponse(response) || attempt === transientFetchAttempts - 1) {
        return response
      }
      await wait(readRetryDelayMs(response, attempt))
    } catch (error) {
      lastError = error
      if (attempt < transientFetchAttempts - 1) {
        await wait(readRetryDelayMs(undefined, attempt))
      }
    }
  }
  throw lastError
}

function parseExistingSnapshotHashResponse(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.existing)) {
    throw new Error('Snapshot check returned invalid response')
  }
  const existing = value.existing
  if (!existing.every(isExistingSnapshotHash)) {
    throw new Error('Snapshot check returned invalid response')
  }
  return { existing }
}

function isExistingSnapshotHash(value: unknown): value is ExistingSnapshotHash {
  if (!isRecord(value)) return false
  return isUsageSource(value.source) &&
    isUsageDate(value.usageDate) &&
    isModelName(value.model) &&
    isSnapshotHash(value.snapshotHash)
}

function parseUploadResponse(value: unknown) {
  if (!isRecord(value) || !isNonNegativeInteger(value.upserted)) {
    throw new Error('Upload returned invalid response')
  }
  return value.upserted
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isUsageSource(value: unknown): value is ExistingSnapshotHash['source'] {
  return value === 'claude-code' || value === 'codex'
}

function isUsageDate(value: unknown): value is string {
  return typeof value === 'string' && usageDatePattern.test(value)
}

function isModelName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxUsageModelNameLength
}

function isSnapshotHash(value: unknown): value is string {
  return typeof value === 'string' && snapshotHashPattern.test(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isRetryableResponse(response: Response) {
  return response.status === 408 ||
    response.status === 429 ||
    response.status === 500 ||
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504
}

function readRetryDelayMs(response: Response | undefined, attempt: number) {
  return readRetryAfterMs(response) ?? readDefaultRetryDelayMs(attempt)
}

function readRetryAfterMs(response: Response | undefined) {
  const header = response?.headers?.get?.('retry-after')
  if (!header) return null
  const seconds = Number.parseFloat(header)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maxRetryDelayMs, seconds * 1000)
  }
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs)) {
    return Math.min(maxRetryDelayMs, Math.max(0, dateMs - Date.now()))
  }
  return null
}

function readDefaultRetryDelayMs(attempt: number) {
  const configured = Number.parseInt(process.env.TOKENBOARD_FETCH_RETRY_DELAY_MS || '', 10)
  const base = Number.isFinite(configured) && configured >= 0 ? configured : defaultRetryDelayMs
  return Math.min(maxRetryDelayMs, base * 2 ** attempt)
}

function wait(delayMs: number) {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}
