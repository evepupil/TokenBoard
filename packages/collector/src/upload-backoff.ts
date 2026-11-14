import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { renameAtomic } from './rename-atomic'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

// Tracks consecutive non-transient upload failures (persistent 4xx, credential rejection,
// response contract breakage). Transient network failures never count — they already have
// the exit-75 scheduled-retry chain. After five consecutive non-transient failures the
// uploader pauses for a day instead of re-scanning and re-failing every sync; pending
// snapshots stay in the cursor the whole time, so pausing loses nothing. One success
// clears the state entirely.
export const uploadFailurePauseThreshold = 5
export const uploadFailurePauseMs = 24 * 60 * 60 * 1000

type UploadBackoffState = {
  consecutiveFailures: number
  lastErrorSummary: string
  pausedUntil?: string
}

const fileName = 'upload-backoff.json'

export async function loadUploadBackoff(stateDir: string): Promise<UploadBackoffState | null> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, fileName), 'utf8')) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as UploadBackoffState).consecutiveFailures === 'number' &&
      typeof (parsed as UploadBackoffState).lastErrorSummary === 'string'
    ) {
      return parsed as UploadBackoffState
    }
    return null
  } catch {
    return null
  }
}

export async function isUploadPaused(stateDir: string, now = new Date()): Promise<{ pausedUntil: string } | null> {
  const state = await loadUploadBackoff(stateDir)
  if (!state?.pausedUntil) return null
  const until = Date.parse(state.pausedUntil)
  if (!Number.isFinite(until) || until <= now.getTime()) return null
  return { pausedUntil: state.pausedUntil }
}

export async function recordUploadFailure(
  stateDir: string,
  error: unknown,
  now = new Date()
): Promise<UploadBackoffState> {
  const previous = await loadUploadBackoff(stateDir)
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1
  const state: UploadBackoffState = {
    consecutiveFailures,
    lastErrorSummary: summarize(error)
  }
  if (consecutiveFailures >= uploadFailurePauseThreshold) {
    state.pausedUntil = new Date(now.getTime() + uploadFailurePauseMs).toISOString()
  }
  await writeState(stateDir, state)
  return state
}

export async function recordUploadSuccess(stateDir: string): Promise<void> {
  await rm(join(stateDir, fileName), { force: true })
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

async function writeState(stateDir: string, state: UploadBackoffState) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const tempPath = join(stateDir, `${fileName}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
  try {
    await writeFile(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 })
    await renameAtomic(tempPath, join(stateDir, fileName))
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}
