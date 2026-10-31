import {
  maxUsageModelNameLength,
  snapshotHashPayload,
  snapshotKey,
  uploadIsoDateIssue,
  usageSourceSchema,
  type UsageSnapshot,
  type UsageSnapshotKey
} from '@tokenboard/usage-core'
import type { CollectorConfig } from './config'

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

const snapshotBatchSize = 30
const transientFetchAttempts = 3
const defaultRetryDelayMs = 250
const maxRetryDelayMs = 5_000
const defaultRequestTimeoutMs = 30_000
const maxRequestTimeoutMs = 120_000
const usageDatePattern = /^\d{4}-\d{2}-\d{2}$/
const snapshotHashPattern = /^[a-f0-9]{64}$/
const positiveIntegerPattern = /^[1-9]\d*$/

export type ExistingSnapshotHash = UsageSnapshotKey & {
  snapshotHash: string
}

export async function uploadSnapshots(
  config: CollectorConfig,
  snapshots: UsageSnapshot[],
  fetcher: Fetcher = fetch,
  options: { now?: Date; stderr?: (line: string) => void } = {}
): Promise<unknown> {
  // The server rejects a whole batch when any snapshot's usageDate falls outside
  // [minUploadIsoDate, today + 1], and the client cannot retry its way out of that: the
  // date is a property of the row, not of the request. Left in, one such row fails the
  // batch it lands in on every run, and five consecutive non-transient failures pause
  // uploads for 24 hours — a single bad date taking the whole machine offline.
  //
  // Dropping it here is not a silent downgrade: the caller gets the count and the
  // offending dates back through `stderr`, and a snapshot that can never be accepted is
  // not data this run could have delivered.
  const now = options.now ?? new Date()
  const uploadable: UsageSnapshot[] = []
  const rejected: Array<{ snapshot: UsageSnapshot; issue: string }> = []
  for (const snapshot of snapshots) {
    const issue = uploadIsoDateIssue(snapshot.usageDate, now)
    if (issue === null) uploadable.push(snapshot)
    else rejected.push({ snapshot, issue })
  }
  if (rejected.length > 0) {
    for (const { snapshot, issue } of rejected.slice(0, 10)) {
      options.stderr?.(
        `TokenBoard upload: dropping ${snapshot.source} ${snapshot.model} with usageDate ${snapshot.usageDate} (${issue}); the server rejects any batch containing it`
      )
    }
    if (rejected.length > 10) {
      options.stderr?.(`TokenBoard upload: ${rejected.length - 10} more snapshots dropped for the same reason`)
    }
  }

  if (uploadable.length === 0) {
    // Nothing left to send. Still post the empty batch when the caller had snapshots at
    // all, so the server's `upserted: 0` keeps answering the same way it does for a
    // genuinely empty run, but never send the rows it would reject.
    const upserted = snapshots.length === 0 ? await uploadSnapshotBatch(config, [], fetcher) : 0
    return withRejectionCount({ upserted, skipped: 0 }, rejected.length)
  }

  let upserted = 0
  let skipped = 0
  let uploaded = false

  for (const batch of chunkSnapshots(uploadable, snapshotBatchSize)) {
    const checked = await filterChangedSnapshots(batch, (keys) => fetchExistingSnapshotHashes(config, keys, fetcher))
    skipped += checked.skipped

    if (checked.snapshots.length === 0) {
      continue
    }

    upserted += await uploadSnapshotBatch(config, checked.snapshots, fetcher)
    uploaded = true
  }

  // The empty batch is the keep-alive the server answers with `upserted: 0`; it is posted
  // when nothing needed uploading, which covers both "every snapshot was already there"
  // and the genuinely-empty run handled above.
  if (!uploaded) {
    upserted += await uploadSnapshotBatch(config, [], fetcher)
  }

  return withRejectionCount({ upserted, skipped }, rejected.length)
}

// Only surfaces the count when something was actually dropped, so a clean run's result
// keeps the shape callers have always seen.
function withRejectionCount(result: { upserted: number; skipped: number }, rejected: number) {
  return rejected > 0 ? { ...result, rejectedUsageDates: rejected } : result
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
    if (hashes.get(snapshotKey(snapshot)) === (await snapshotHash(snapshot))) {
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshotHashPayload(snapshot)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function fetchExistingSnapshotHashes(config: CollectorConfig, keys: UsageSnapshotKey[], fetcher: Fetcher) {
  if (keys.length === 0) {
    return { existing: [] }
  }

  const { response, value } = await fetchWithRetries(
    fetcher,
    `${config.endpoint}/check`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.uploadToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ keys })
    },
    async (candidate) => {
      if (isUnsupportedSnapshotCheckResponse(candidate) || !candidate.ok) return undefined
      return parseExistingSnapshotHashResponse(await candidate.json())
    }
  )

  if (isUnsupportedSnapshotCheckResponse(response)) {
    return { existing: [] }
  }

  if (!response.ok) {
    throw new Error(`Snapshot check failed with status ${response.status}`)
  }

  return value as { existing: ExistingSnapshotHash[] }
}

function isUnsupportedSnapshotCheckResponse(response: Response) {
  return response.status === 404 || response.status === 405 || response.status === 501
}

async function uploadSnapshotBatch(config: CollectorConfig, snapshots: UsageSnapshot[], fetcher: Fetcher) {
  const { response, value } = await fetchWithRetries(
    fetcher,
    config.endpoint,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.uploadToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ snapshots })
    },
    async (candidate) => {
      if (!candidate.ok) return undefined
      return parseUploadResponse(await candidate.json())
    }
  )

  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`)
  }

  return value as number
}

function chunkSnapshots(snapshots: UsageSnapshot[], size: number) {
  const batches: UsageSnapshot[][] = []
  for (let index = 0; index < snapshots.length; index += size) {
    batches.push(snapshots.slice(index, index + size))
  }
  return batches
}

async function fetchWithRetries<T>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  parseResponse: (response: Response) => Promise<T>
) {
  let lastError: unknown
  for (let attempt = 0; attempt < transientFetchAttempts; attempt += 1) {
    try {
      const result = await runWithinRequestDeadline(fetcher, url, init, async (response) => {
        if (isRetryableResponse(response)) {
          return { response, parsed: false as const }
        }
        try {
          return {
            response,
            parsed: true as const,
            value: await parseResponse(response)
          }
        } catch (error) {
          if (error instanceof RequestTimeoutError) throw error
          throw new ResponseParsingError(error)
        }
      })
      if (result.parsed || attempt === transientFetchAttempts - 1) {
        return result
      }
      await wait(readRetryDelayMs(result.response, attempt))
    } catch (error) {
      if (error instanceof ResponseParsingError) throw error.cause
      lastError = error
      if (attempt < transientFetchAttempts - 1) {
        await wait(readRetryDelayMs(undefined, attempt))
      }
    }
  }
  throw lastError
}

class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`TokenBoard request timed out after ${timeoutMs}ms`)
  }
}

class ResponseParsingError extends Error {
  constructor(readonly cause: unknown) {
    super('TokenBoard response parsing failed')
  }
}

async function runWithinRequestDeadline<T>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  consumeResponse: (response: Response) => Promise<T>
) {
  const timeoutMs = readRequestTimeoutMs()
  const controller = new AbortController()
  const detachCallerAbort = forwardAbort(init.signal, controller)
  const timeoutError = new RequestTimeoutError(timeoutMs)
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs)

  try {
    const response = await awaitWithAbort(
      // The upload carries the bearer token. `redirect: 'manual'` stops fetch from
      // replaying the request — and the header — at a Location the server chose; the
      // pricing fetch already refuses redirects the same way. A 3xx then reaches
      // isRetryableResponse as a non-retryable status and surfaces as an error.
      fetcher.call(globalThis, url, { ...init, signal: controller.signal, redirect: 'manual' }),
      controller.signal
    )
    return await awaitWithAbort(consumeResponse(response), controller.signal)
  } finally {
    clearTimeout(timeout)
    detachCallerAbort()
  }
}

function forwardAbort(signal: AbortSignal | null | undefined, controller: AbortController) {
  if (!signal) return () => undefined
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) {
    abort()
    return () => undefined
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
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
  return (
    isUsageSource(value.source) &&
    isUsageDate(value.usageDate) &&
    isModelName(value.model) &&
    isSnapshotHash(value.snapshotHash)
  )
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
  return usageSourceSchema.safeParse(value).success
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
  return (
    response.status === 408 ||
    response.status === 429 ||
    response.status === 500 ||
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504
  )
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

function readRequestTimeoutMs() {
  const value = process.env.TOKENBOARD_FETCH_TIMEOUT_MS || ''
  if (!positiveIntegerPattern.test(value)) return defaultRequestTimeoutMs
  const configured = Number(value)
  if (!Number.isSafeInteger(configured)) return defaultRequestTimeoutMs
  return Math.min(maxRequestTimeoutMs, configured)
}

function wait(delayMs: number) {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}
