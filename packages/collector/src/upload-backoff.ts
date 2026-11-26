import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { renameAtomic } from './rename-atomic'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

// Tracks consecutive non-transient upload failures per source (persistent 4xx, credential
// rejection, response contract breakage). Transient network failures never count — they
// already have the exit-75 scheduled-retry chain. After five consecutive non-transient
// failures a source pauses for a day instead of re-scanning and re-failing every sync;
// pending snapshots stay in the cursor the whole time, so pausing loses nothing. One
// success clears that source's state.
//
// Before v2 the file was one flat record with no source attribution: one source's
// persistent 400 paused every source on the machine. The flat fields are still honoured
// read-side (their pause covers every source, as it used to) but are never migrated onto
// a source — the count cannot be attributed — and are dropped once that pause expires.
export const uploadFailurePauseThreshold = 5
export const uploadFailurePauseMs = 24 * 60 * 60 * 1000

export type UploadBackoffEntry = {
  consecutiveFailures: number
  lastErrorSummary: string
  pausedUntil?: string
}

export type UploadBackoffFile = {
  version?: number
  sources?: Record<string, UploadBackoffEntry>
  // Legacy (pre-v2) flat fields.
  consecutiveFailures?: number
  lastErrorSummary?: string
  pausedUntil?: string
}

const fileName = 'upload-backoff.json'

function isEntry(value: unknown): value is UploadBackoffEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UploadBackoffEntry).consecutiveFailures === 'number' &&
    typeof (value as UploadBackoffEntry).lastErrorSummary === 'string'
  )
}

export async function loadUploadBackoff(stateDir: string): Promise<UploadBackoffFile | null> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, fileName), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const file = parsed as UploadBackoffFile
    const sources: Record<string, UploadBackoffEntry> = {}
    if (typeof file.sources === 'object' && file.sources !== null) {
      for (const [source, entry] of Object.entries(file.sources)) {
        if (isEntry(entry)) sources[source] = entry
      }
    }
    const legacy =
      typeof file.consecutiveFailures === 'number' && typeof file.lastErrorSummary === 'string'
        ? { consecutiveFailures: file.consecutiveFailures, lastErrorSummary: file.lastErrorSummary, pausedUntil: file.pausedUntil }
        : null
    if (Object.keys(sources).length === 0 && legacy === null) return null
    return { version: file.version, sources, ...(legacy ?? {}) }
  } catch {
    return null
  }
}

function activePause(pausedUntil: string | undefined, now: Date): string | null {
  if (!pausedUntil) return null
  const until = Date.parse(pausedUntil)
  if (!Number.isFinite(until) || until <= now.getTime()) return null
  return pausedUntil
}

export async function isUploadPaused(
  stateDir: string,
  source: string,
  now = new Date()
): Promise<{ pausedUntil: string } | null> {
  const file = await loadUploadBackoff(stateDir)
  if (!file) return null
  let pausedUntil = activePause(file.sources?.[source]?.pausedUntil, now)
  // A legacy pause still covers every source: that is what it did before the split,
  // and lifting it early would resume uploads into the same repeated failure.
  const legacy = activePause(file.pausedUntil, now)
  if (legacy && (!pausedUntil || Date.parse(legacy) > Date.parse(pausedUntil))) pausedUntil = legacy
  return pausedUntil ? { pausedUntil } : null
}

export async function recordUploadFailure(
  stateDir: string,
  source: string,
  error: unknown,
  now = new Date()
): Promise<UploadBackoffEntry> {
  const previous = await loadUploadBackoff(stateDir)
  // Only this source's v2 entry carries over. The legacy count is deliberately not
  // inherited: it cannot be attributed to this source, and inheriting it could pause a
  // healthy source on its first failure.
  const consecutiveFailures = (previous?.sources?.[source]?.consecutiveFailures ?? 0) + 1
  const entry: UploadBackoffEntry = {
    consecutiveFailures,
    lastErrorSummary: summarize(error)
  }
  if (consecutiveFailures >= uploadFailurePauseThreshold) {
    entry.pausedUntil = new Date(now.getTime() + uploadFailurePauseMs).toISOString()
  }
  const file: UploadBackoffFile = {
    version: 2,
    sources: { ...(previous?.sources ?? {}), [source]: entry }
  }
  if (previous && activePause(previous.pausedUntil, now)) {
    file.consecutiveFailures = previous.consecutiveFailures
    file.lastErrorSummary = previous.lastErrorSummary
    file.pausedUntil = previous.pausedUntil
  }
  await writeState(stateDir, file)
  return entry
}

// Clears the source's entry. The legacy flat fields go only once their pause has
// expired; while it is active they still pause every source.
export async function recordUploadSuccess(stateDir: string, source: string, now = new Date()): Promise<void> {
  const previous = await loadUploadBackoff(stateDir)
  if (!previous) return
  const sources = { ...(previous.sources ?? {}) }
  delete sources[source]
  const file: UploadBackoffFile = { version: 2, sources }
  if (activePause(previous.pausedUntil, now)) {
    file.consecutiveFailures = previous.consecutiveFailures
    file.lastErrorSummary = previous.lastErrorSummary
    file.pausedUntil = previous.pausedUntil
  }
  if (Object.keys(sources).length === 0 && file.pausedUntil === undefined) {
    await rm(join(stateDir, fileName), { force: true })
    return
  }
  await writeState(stateDir, file)
}

async function writeState(stateDir: string, state: UploadBackoffFile) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const target = join(stateDir, fileName)
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  await renameAtomic(tmp, target)
}

// Every http(s) URL is reduced to its origin. The summary is persisted, and a
// transport error embeds the request URL, which can carry a query string or
// userinfo that must not sit in a long-lived file. Same reduction as the Go
// client's upload.RedactURLs, trailing sentence punctuation kept.
export function redactUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    const trimmed = raw.replace(/[.,;:!?)\]}]+$/, '')
    const trailer = raw.slice(trimmed.length)
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return `https://<redacted>${trailer}`
    }
    if (!parsed.host) return `https://<redacted>${trailer}`
    return `${parsed.protocol}//${parsed.host}${trailer}`
  })
}

export function summarize(error: unknown): string {
  const message = redactUrls(error instanceof Error ? error.message : String(error))
  return message.length > 200 ? `${message.slice(0, 197)}…` : message
}
