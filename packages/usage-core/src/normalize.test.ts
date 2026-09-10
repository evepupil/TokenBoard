import { describe, expect, test } from 'vitest'
import { withTotalTokens } from './normalize'
import type { UsageSnapshot } from './schema'

const baseSnapshot: Omit<UsageSnapshot, 'totalTokens'> = {
  source: 'codex',
  usageDate: '2026-05-09',
  timezone: 'Asia/Shanghai',
  model: 'gpt-5',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 3,
  cacheReadTokens: 5,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: '2026-05-09T10:00:00.000Z'
}

describe('usage normalization', () => {
  test('derives total tokens from every token component', () => {
    expect(withTotalTokens(baseSnapshot)).toEqual({
      ...baseSnapshot,
      totalTokens: 20
    })
  })

  test('keeps zero-valued cache components in the normalized snapshot', () => {
    expect(
      withTotalTokens({
        ...baseSnapshot,
        cacheCreationTokens: 0,
        cacheReadTokens: 0
      })
    ).toMatchObject({
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 12
    })
  })
})
