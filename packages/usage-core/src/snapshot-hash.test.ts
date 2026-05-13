import { describe, expect, test } from 'vitest'
import { snapshotHashPayload, snapshotKey, type UsageSnapshot } from './schema'

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

describe('snapshot identity', () => {
  test('builds a stable server lookup key without collectedAt', () => {
    expect(snapshotKey(baseSnapshot)).toBe('codex\u00002026-05-09\u0000gpt-5')
  })

  test('hash payload changes when aggregate content changes but ignores collection time', () => {
    expect(snapshotHashPayload(baseSnapshot)).toBe(
      snapshotHashPayload({
        ...baseSnapshot,
        collectedAt: '2026-05-09T11:00:00.000Z'
      })
    )
    expect(snapshotHashPayload(baseSnapshot)).not.toBe(
      snapshotHashPayload({
        ...baseSnapshot,
        totalTokens: 18
      })
    )
  })
})
