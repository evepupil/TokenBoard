import type { ZodError, ZodIssue } from 'zod'

// A 400 that only says "Invalid request" leaves the collector with nothing to act on: it
// retries the same batch, fails the same way, and after five non-transient failures uploads
// pause for a day for every source on the machine. This module turns the Zod issues into a
// small, stable, value-free description of *where* the batch is wrong, so the client can
// isolate the offending rows and deliver the rest.
//
// Nothing here may echo input values: Zod's default messages interpolate the received value
// (`Invalid input: expected number, received string`), so `issue.message` is never
// serialized and only our own fixed codes leave this module. The schema's own custom
// messages are matched by exact string, not included.

export const maxIngestErrorDetails = 32

export type IngestErrorDetailCode =
  | 'invalid-type'
  | 'invalid-value'
  | 'array-too-small'
  | 'array-too-big'
  | 'token-out-of-range'
  | 'invalid-date'
  | 'usage-date-too-far-future'
  | 'usage-date-before-window'
  | 'cache-read-exceeds-total'
  | 'cost-unavailable-source'

export type IngestErrorDetail = {
  index?: number
  path: string
  code: IngestErrorDetailCode
}

export type IngestErrorDetails = {
  details: IngestErrorDetail[]
  truncated: boolean
}

const snapshotFields = new Set([
  'source',
  'usageDate',
  'timezone',
  'model',
  'inputTokens',
  'outputTokens',
  'cacheCreationTokens',
  'cacheReadTokens',
  'totalTokens',
  'costUsd',
  'sessionCount',
  'collectedAt',
  'correction'
])

const keyFields = new Set(['source', 'usageDate', 'model'])

// The three messages the ingest schema adds itself (apps/web/app/features/ingest/schema.ts).
// Exact matches only: anything unrecognised falls back to `invalid-value` rather than
// forwarding schema text.
const customMessageCodes = new Map<string, IngestErrorDetailCode>([
  ['Invalid ISO date', 'invalid-date'],
  ['usageDate too far in the future', 'usage-date-too-far-future'],
  ['usageDate before the supported history window', 'usage-date-before-window']
])

function resolvePath(issue: ZodIssue): { path: string; index?: number } | null {
  // Zod types the path as PropertyKey[]; the ingest schemas only ever produce string keys
  // and array indices, and anything else must not be echoed, so the segments are validated
  // rather than trusted.
  const segments = issue.path as unknown[]
  if (segments.length > 3) return null
  const [root, second, third] = segments
  const rootName = root === 'snapshots' ? 'snapshots' : root === 'keys' ? 'keys' : null
  if (!rootName) return null
  const fields = rootName === 'snapshots' ? snapshotFields : keyFields
  if (second === undefined) return { path: rootName }
  if (typeof second !== 'number' || !Number.isInteger(second) || second < 0) return null
  if (third === undefined) return { path: `${rootName}.${second}`, index: second }
  if (typeof third !== 'string' || !fields.has(third)) return null
  return { path: `${rootName}.${second}.${third}`, index: second }
}

function resolveCode(issue: ZodIssue, path: string): IngestErrorDetailCode {
  switch (issue.code) {
    case 'invalid_type':
      return 'invalid-type'
    case 'invalid_value':
    case 'invalid_union':
    case 'invalid_format':
      return 'invalid-value'
    case 'too_small':
    case 'too_big': {
      const origin = (issue as { origin?: string }).origin
      if (origin === 'array') return issue.code === 'too_small' ? 'array-too-small' : 'array-too-big'
      return 'token-out-of-range'
    }
    case 'custom': {
      const known = customMessageCodes.get(issue.message)
      if (known) return known
      // Path anchors for the two value-dependent custom issues in usageSnapshotSchema.
      // They are custom issues at exactly these fields; no other custom issue uses them.
      if (path.endsWith('.cacheReadTokens')) return 'cache-read-exceeds-total'
      if (path.endsWith('.costUsd')) return 'cost-unavailable-source'
      return 'invalid-value'
    }
    default:
      return 'invalid-value'
  }
}

export function toIngestErrorDetails(error: ZodError): IngestErrorDetails {
  const details: IngestErrorDetail[] = []
  const seen = new Set<string>()
  let truncated = false
  for (const issue of error.issues) {
    const resolved = resolvePath(issue)
    if (!resolved) continue
    const detail: IngestErrorDetail = {
      ...(resolved.index === undefined ? {} : { index: resolved.index }),
      path: resolved.path,
      code: resolveCode(issue, resolved.path)
    }
    // One oversized number produces one `too_big` per constraint (int and number bounds);
    // the client addresses rows, not constraints.
    const key = `${detail.index ?? ''}|${detail.path}|${detail.code}`
    if (seen.has(key)) continue
    if (details.length >= maxIngestErrorDetails) {
      truncated = true
      break
    }
    seen.add(key)
    details.push(detail)
  }
  return { details, truncated }
}
