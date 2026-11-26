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

/**
 * The subset of the input an upload actually delivered (posted, or already
 * present server-side). The cursor acknowledgement reads this instead of the
 * collection: a row dropped for an out-of-window usageDate never reached the
 * server, and clearing its pending entry would lose it for good instead of
 * retrying it once the clock is right.
 *
 * An injected test double that returns a plain object carries no delivery set;
 * the caller then falls back to acknowledging the whole collection, which is
 * what those stubs have always exercised.
 */
export const uploadDeliveredSymbol = Symbol('tokenboard.uploadDelivered')

export function readUploadDelivered(value: unknown): UsageSnapshot[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const delivered = (value as { [uploadDeliveredSymbol]?: UsageSnapshot[] })[uploadDeliveredSymbol]
  return Array.isArray(delivered) ? delivered : undefined
}

// The rows the upload dropped, with the reason. The cursor acknowledgement reads
// this to tell a row that can never be uploaded (an invalid or before-window
// usageDate) from one that is merely too far in the future and will become
// uploadable once the clock catches up: the first may be acknowledged away so it
// is not rescanned forever, the second must stay pending so it is retried.
export const uploadRejectedSymbol = Symbol('tokenboard.uploadRejected')

export type RejectedUploadSnapshot = { snapshot: UsageSnapshot; issue: string }

export function readUploadRejected(value: unknown): RejectedUploadSnapshot[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const rejected = (value as { [uploadRejectedSymbol]?: RejectedUploadSnapshot[] })[uploadRejectedSymbol]
  return Array.isArray(rejected) ? rejected : undefined
}

// The rows the server rejected with a validation detail (`error.details`). They are
// neither delivered nor permanently rejected: they stay pending in the cursor so a
// later run retries them, exactly like a row that never left the machine.
export const uploadBlockedSymbol = Symbol('tokenboard.uploadBlocked')

export type BlockedUploadSnapshot = { snapshot: UsageSnapshot; code: string }

export function readUploadBlocked(value: unknown): BlockedUploadSnapshot[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const blocked = (value as { [uploadBlockedSymbol]?: BlockedUploadSnapshot[] })[uploadBlockedSymbol]
  return Array.isArray(blocked) ? blocked : undefined
}

function withDelivered<T extends object>(
  payload: T,
  delivered: UsageSnapshot[],
  rejected: RejectedUploadSnapshot[],
  blocked: BlockedUploadSnapshot[]
): T {
  Object.defineProperty(payload, uploadDeliveredSymbol, {
    configurable: false,
    enumerable: false,
    value: delivered,
    writable: false
  })
  Object.defineProperty(payload, uploadRejectedSymbol, {
    configurable: false,
    enumerable: false,
    value: rejected,
    writable: false
  })
  Object.defineProperty(payload, uploadBlockedSymbol, {
    configurable: false,
    enumerable: false,
    value: blocked,
    writable: false
  })
  return payload
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
    // Nothing left to send. An empty batch only goes out when the caller had no snapshots
    // at all, so the server's `upserted:0` keeps answering the same way for a genuinely
    // empty run. A run whose only snapshots were rejected sends no batch: posting an
    // empty one would claim a delivery that did not happen.
    const upserted = snapshots.length === 0 ? await uploadSnapshotBatch(config, [], fetcher) : 0
    return withDelivered(withRejectionCount({ upserted, skipped: 0 }, rejected.length), [], rejected, [])
  }

  let upserted = 0
  let skipped = 0
  let uploaded = false
  const blocked: BlockedUploadSnapshot[] = []

  for (const batch of chunkSnapshots(uploadable, snapshotBatchSize)) {
    const checked = await filterChangedWithIsolation(config, batch, fetcher)
    skipped += checked.skipped

    if (checked.snapshots.length === 0) {
      continue
    }

    upserted += await uploadBatchWithIsolation(config, checked.snapshots, fetcher, blocked)
    uploaded = true
  }

  // The empty batch is the keep-alive the server answers with `upserted: 0`; it is posted
  // when nothing needed uploading, which covers both "every snapshot was already there"
  // and the genuinely-empty run handled above.
  if (!uploaded) {
    upserted += await uploadSnapshotBatch(config, [], fetcher)
  }

  // A blocked row never reached the server: it must not be acknowledged. Everything
  // else in `uploadable` did (posted, or already present server-side).
  const blockedRows = new Set(blocked.map((entry) => entry.snapshot))
  const delivered = uploadable.filter((snapshot) => !blockedRows.has(snapshot))
  return withDelivered(withRejectionCount({ upserted, skipped }, rejected.length), delivered, rejected, blocked)
}

// The server can only reject a key it can name. A rejected key is dropped and the
// remaining keys are checked again; its snapshot stays in the upload list (absent from
// `existing` counts as changed) and the ingest isolation decides whether it is blocked.
async function filterChangedWithIsolation(
  config: CollectorConfig,
  snapshots: UsageSnapshot[],
  fetcher: Fetcher
): Promise<{ snapshots: UsageSnapshot[]; skipped: number }> {
  const excluded = new Set<number>()
  let existing: ExistingSnapshotHash[] = []
  for (let round = 0; ; round += 1) {
    const included = snapshots.map((_, index) => index).filter((index) => !excluded.has(index))
    if (included.length === 0) break
    try {
      existing = (
        await fetchExistingSnapshotHashes(
          config,
          included.map((index) => ({
            source: snapshots[index].source,
            usageDate: snapshots[index].usageDate,
            model: snapshots[index].model
          })),
          fetcher
        )
      ).existing
      break
    } catch (error) {
      if (!(error instanceof ValidationRejection) || error.keys.length === 0 || round >= maxIsolationRounds) {
        throw error
      }
      let added = false
      for (const issue of error.keys) {
        const position = included[issue.index]
        if (position !== undefined && !excluded.has(position)) {
          excluded.add(position)
          added = true
        }
      }
      if (!added) throw error
    }
  }
  const hashes = new Map(existing.map((row) => [snapshotKey(row), row.snapshotHash]))
  const changed: UsageSnapshot[] = []
  let skipped = 0
  for (const [index, snapshot] of snapshots.entries()) {
    if (!excluded.has(index) && hashes.get(snapshotKey(snapshot)) === (await snapshotHash(snapshot))) {
      skipped += 1
      continue
    }
    changed.push(snapshot)
  }
  return { snapshots: changed, skipped }
}

// Posts one batch; when the server names rejected rows, removes exactly those and
// re-sends the rest, at most `maxIsolationRounds` times. Rows the server named land in
// `blockedAcc`; any other error (no usable details, a non-validation failure, rounds
// exhausted) fails the upload as it would have before.
async function uploadBatchWithIsolation(
  config: CollectorConfig,
  snapshots: UsageSnapshot[],
  fetcher: Fetcher,
  blockedAcc: BlockedUploadSnapshot[]
): Promise<number> {
  let send = snapshots
  for (let round = 0; ; round += 1) {
    try {
      return await uploadSnapshotBatch(config, send, fetcher)
    } catch (error) {
      if (!(error instanceof ValidationRejection) || error.snapshots.length === 0 || round >= maxIsolationRounds) {
        throw error
      }
      const removed = new Set<number>()
      for (const issue of error.snapshots) {
        if (issue.index >= 0 && issue.index < send.length && !removed.has(issue.index)) {
          removed.add(issue.index)
          blockedAcc.push({ snapshot: send[issue.index], code: issue.code })
        }
      }
      if (removed.size === 0) throw error
      send = send.filter((_, index) => !removed.has(index))
      if (send.length === 0) return 0
    }
  }
}

const maxIsolationRounds = 2
const maxValidationBodyBytes = 64 * 1024

type ValidationIssue = { index: number; code: string }

// A 400 whose body named the rejected rows. `kind` keeps the pre-existing failure
// wording ("Upload failed with status 400"), which callers classify by string.
class ValidationRejection extends Error {
  constructor(
    readonly kind: 'Upload' | 'Snapshot check',
    readonly status: number,
    readonly snapshots: ValidationIssue[],
    readonly keys: ValidationIssue[]
  ) {
    super(`${kind} failed with status ${status}`)
  }
}

function parseValidationDetailPath(path: unknown): { root: 'snapshots' | 'keys'; index: number } | null {
  if (typeof path !== 'string') return null
  const match = /^(snapshots|keys)\.(\d+)(?:\.[A-Za-z]+)?$/.exec(path)
  if (!match) return null
  return { root: match[1] as 'snapshots' | 'keys', index: Number(match[2]) }
}

// Reads a bounded 400 body and returns the rejection it describes, or null when the
// body carries no usable details (an old server, a proxy, a non-JSON body).
async function parseValidationRejection(
  kind: 'Upload' | 'Snapshot check',
  response: Response
): Promise<ValidationRejection | null> {
  const text = await readBoundedText(response, maxValidationBodyBytes)
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.error) || !Array.isArray(parsed.error.details)) return null
  const snapshots: ValidationIssue[] = []
  const keys: ValidationIssue[] = []
  const seen = new Set<string>()
  for (const detail of parsed.error.details) {
    if (!isRecord(detail)) continue
    const resolved = parseValidationDetailPath(detail.path)
    if (!resolved) continue
    const code = typeof detail.code === 'string' && detail.code !== '' ? detail.code : 'invalid-value'
    const dedupeKey = `${resolved.root}|${resolved.index}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    ;(resolved.root === 'snapshots' ? snapshots : keys).push({ index: resolved.index, code })
  }
  if (snapshots.length === 0 && keys.length === 0) return null
  return new ValidationRejection(kind, response.status, snapshots, keys)
}

async function readBoundedText(response: Response, limit: number): Promise<string | null> {
  const body = response.body
  if (!body) {
    try {
      const text = await response.text()
      return text.length <= limit ? text : null
    } catch {
      return null
    }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
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
      if (candidate.status === 400) {
        const rejection = await parseValidationRejection('Snapshot check', candidate)
        if (rejection) throw rejection
      }
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
      if (candidate.status === 400) {
        const rejection = await parseValidationRejection('Upload', candidate)
        if (rejection) throw rejection
      }
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
