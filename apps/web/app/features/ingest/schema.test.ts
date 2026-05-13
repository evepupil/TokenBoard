import { describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { ingestRequestSchema, snapshotCheckRequestSchema } from './schema'

const baseSnapshot: UsageSnapshot = {
  source: 'codex',
  usageDate: '2026-05-09',
  timezone: 'Asia/Shanghai',
  model: 'gpt-5',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 5,
  totalTokens: 17,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: '2026-05-09T10:00:00.000Z'
}

describe('ingest schemas', () => {
  test('accepts empty snapshot batches for sync acknowledgements', () => {
    expect(ingestRequestSchema.parse({ snapshots: [] })).toEqual({ snapshots: [] })
  })

  test('accepts large legacy snapshot batches from old collectors', () => {
    const snapshots = Array.from({ length: 501 }, (_, index) => ({
      ...baseSnapshot,
      model: `gpt-5-${index}`
    }))

    expect(ingestRequestSchema.parse({ snapshots })).toEqual({ snapshots })
  })

  test('rejects unbounded legacy snapshot batches', () => {
    const snapshots = Array.from({ length: 5001 }, (_, index) => ({
      ...baseSnapshot,
      model: `gpt-5-${index}`
    }))

    expect(() => ingestRequestSchema.parse({ snapshots })).toThrow()
  })

  test('validates snapshot hash check keys', () => {
    expect(
      snapshotCheckRequestSchema.parse({
        keys: [
          {
            source: 'codex',
            usageDate: '2026-05-09',
            model: 'gpt-5'
          }
        ]
      })
    ).toEqual({
      keys: [
        {
          source: 'codex',
          usageDate: '2026-05-09',
          model: 'gpt-5'
        }
      ]
    })
  })
})
