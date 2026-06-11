import { describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import {
  ingestRequestSchema,
  snapshotCheckRequestSchema
} from './schema'

const legacyCollectorBatchSize = 500

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

  test('rejects cache reads that exceed provider total tokens', () => {
    expect(() =>
      ingestRequestSchema.parse({
        snapshots: [{
          ...baseSnapshot,
          cacheReadTokens: baseSnapshot.totalTokens + 1
        }]
      })
    ).toThrow('cacheReadTokens must not exceed totalTokens')
  })

  test('accepts legacy collector snapshot batches', () => {
    const snapshots = Array.from({ length: legacyCollectorBatchSize }, (_, index) => ({
      ...baseSnapshot,
      model: `gpt-5-${index}`
    }))

    expect(ingestRequestSchema.parse({ snapshots })).toEqual({ snapshots })
  })

  test('rejects snapshot batches that exceed legacy collector compatibility', () => {
    const snapshots = Array.from({ length: legacyCollectorBatchSize + 1 }, (_, index) => ({
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

  test('caps snapshot hash checks to the upload batch size', () => {
    const keys = Array.from({ length: legacyCollectorBatchSize + 1 }, (_, index) => ({
      source: 'codex',
      usageDate: '2026-05-09',
      model: `gpt-5-${index}`
    }))

    expect(() => snapshotCheckRequestSchema.parse({ keys })).toThrow()
  })

  test('accepts legacy collector snapshot hash checks', () => {
    const keys = Array.from({ length: legacyCollectorBatchSize }, (_, index) => ({
      source: 'codex',
      usageDate: '2026-05-09',
      model: `gpt-5-${index}`
    }))

    expect(snapshotCheckRequestSchema.parse({ keys })).toEqual({ keys })
  })

  test('rejects oversized model names in snapshot hash checks', () => {
    expect(() =>
      snapshotCheckRequestSchema.parse({
        keys: [
          {
            source: 'codex',
            usageDate: '2026-05-09',
            model: 'g'.repeat(161)
          }
        ]
      })
    ).toThrow()
  })
})
