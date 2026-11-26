import { describe, expect, test } from 'vitest'
import { ZodError, type ZodIssue } from 'zod'
import { ingestRequestSchema, snapshotCheckRequestSchema, maxIngestSnapshotBatchSize } from './schema'
import { maxIngestErrorDetails, toIngestErrorDetails } from './error-details'

function detailsOf(schema: { safeParse: (v: unknown) => { success: boolean; error?: ZodError } }, body: unknown) {
  const parsed = schema.safeParse(body)
  if (parsed.success) throw new Error('expected a parse failure')
  return toIngestErrorDetails(parsed.error as ZodError)
}

const baseSnapshot = {
  source: 'codex',
  usageDate: '2026-11-20',
  timezone: 'UTC',
  model: 'gpt-5',
  inputTokens: 1,
  outputTokens: 1,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 2,
  costUsd: 0,
  sessionCount: 1,
  collectedAt: '2026-11-20T00:00:00.000Z'
}

describe('toIngestErrorDetails', () => {
  // Zod only reports ["snapshots", 0] when the element itself is not an object; without an
  // element-level path the client cannot tell which row to isolate and the whole batch keeps
  // failing until uploads pause for a day.
  test('keeps the row index for an element that is not an object', () => {
    const { details } = detailsOf(ingestRequestSchema, { snapshots: [null] })
    expect(details).toEqual([{ index: 0, path: 'snapshots.0', code: 'invalid-type' }])
  })

  test('maps field-level issues to stable codes with the row index', () => {
    const { details } = detailsOf(ingestRequestSchema, {
      snapshots: [baseSnapshot, { ...baseSnapshot, source: 'not-a-source' }, { ...baseSnapshot, inputTokens: -1 }]
    })
    expect(details).toEqual([
      { index: 1, path: 'snapshots.1.source', code: 'invalid-value' },
      { index: 2, path: 'snapshots.2.inputTokens', code: 'token-out-of-range' }
    ])
  })

  test('maps the three usageDate messages to distinct codes', () => {
    const { details } = detailsOf(ingestRequestSchema, {
      snapshots: [
        { ...baseSnapshot, usageDate: 'not-a-date' },
        { ...baseSnapshot, usageDate: '2099-01-01' },
        { ...baseSnapshot, usageDate: '2001-01-01' }
      ]
    })
    expect(details.map((detail) => detail.code)).toEqual([
      'invalid-date',
      'usage-date-too-far-future',
      'usage-date-before-window'
    ])
  })

  test('maps the path-anchored custom issues', () => {
    const { details } = detailsOf(ingestRequestSchema, {
      snapshots: [
        { ...baseSnapshot, cacheReadTokens: 5 },
        { ...baseSnapshot, source: 'antigravity', costUsd: 0.5 }
      ]
    })
    expect(details).toEqual([
      { index: 0, path: 'snapshots.0.cacheReadTokens', code: 'cache-read-exceeds-total' },
      { index: 1, path: 'snapshots.1.costUsd', code: 'cost-unavailable-source' }
    ])
  })

  test('maps request-level array issues without an index', () => {
    const { details } = detailsOf(ingestRequestSchema, {
      snapshots: Array.from({ length: maxIngestSnapshotBatchSize + 1 }, () => baseSnapshot)
    })
    expect(details).toEqual([{ path: 'snapshots', code: 'array-too-big' }])
  })

  test('handles the check request keys too', () => {
    const { details } = detailsOf(snapshotCheckRequestSchema, {
      keys: [{ source: 'codex', usageDate: 'SENTINEL-DATE', model: 'gpt-5' }, null]
    })
    expect(details).toEqual([
      { index: 0, path: 'keys.0.usageDate', code: 'invalid-date' },
      { index: 1, path: 'keys.1', code: 'invalid-type' }
    ])
  })

  // Zod emits one issue per constraint, so a single oversized number arrives twice
  // (int and number bounds). The client sees one row, so it must get one entry.
  test('deduplicates identical index/path/code entries', () => {
    const huge = { ...baseSnapshot, inputTokens: 1e18 }
    const { details } = detailsOf(ingestRequestSchema, { snapshots: [huge] })
    expect(details).toEqual([{ index: 0, path: 'snapshots.0.inputTokens', code: 'token-out-of-range' }])
  })

  test('drops paths outside the whitelist', () => {
    const error = new ZodError([
      { code: 'custom', path: ['snapshots', 0, 'notAField'], message: 'boom' },
      { code: 'custom', path: ['elsewhere'], message: 'boom' },
      { code: 'custom', path: ['snapshots', 'x', 'model'], message: 'boom' },
      { code: 'custom', path: ['snapshots', -1, 'model'], message: 'boom' }
    ] as ZodIssue[])
    expect(toIngestErrorDetails(error).details).toEqual([])
  })

  test('caps the list and reports truncation', () => {
    const issues = Array.from({ length: maxIngestErrorDetails + 5 }, (_, index) => ({
      code: 'custom',
      path: ['snapshots', index, 'model'],
      message: 'Invalid ISO date'
    })) as ZodIssue[]
    const result = toIngestErrorDetails(new ZodError(issues))
    expect(result.details).toHaveLength(maxIngestErrorDetails)
    expect(result.truncated).toBe(true)
  })

  // The whole point of the whitelist: Zod's default messages interpolate the received value
  // ("Invalid input: expected number, received string"), so nothing but our own stable codes
  // and the schema's fixed messages may reach the response.
  test('never echoes input values', () => {
    const sentinel = 'SENTINEL-VALUE-9f3a'
    const errors = [
      { snapshots: [{ ...baseSnapshot, usageDate: sentinel }] },
      { snapshots: [{ ...baseSnapshot, model: 12345 }] },
      { snapshots: [sentinel] },
      { snapshots: [{ ...baseSnapshot, source: sentinel }] }
    ].flatMap((body) => {
      const parsed = ingestRequestSchema.safeParse(body)
      return parsed.success ? [] : parsed.error.issues
    })
    const serialized = JSON.stringify(toIngestErrorDetails(new ZodError(errors)))
    expect(serialized).not.toContain(sentinel)
    expect(serialized).not.toContain('12345')
    expect(serialized).not.toContain('received')
  })
})
