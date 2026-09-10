import { describe, expect, test } from 'vitest'
import { normalizeCodexTotalTokens } from './codex-token-usage'

describe('normalizeCodexTotalTokens', () => {
  test('keeps an explicit total when input already includes cache creation tokens', () => {
    expect(
      normalizeCodexTotalTokens({
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 30,
        cacheReadTokens: 10,
        explicitTotalTokens: 120
      })
    ).toBe(120)
  })

  test('adds separately reported cached input when it exceeds input tokens', () => {
    expect(
      normalizeCodexTotalTokens({
        inputTokens: 10,
        outputTokens: 4,
        cacheCreationTokens: 3,
        cacheReadTokens: 20,
        explicitTotalTokens: 15
      })
    ).toBe(37)
  })

  test('adds all component fields when total is omitted', () => {
    expect(
      normalizeCodexTotalTokens({
        inputTokens: 200,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 150
      })
    ).toBe(370)
  })

  test('raises an inconsistent low explicit total without dropping cache creation tokens', () => {
    expect(
      normalizeCodexTotalTokens({
        inputTokens: 20,
        outputTokens: 4,
        cacheCreationTokens: 3,
        cacheReadTokens: 5,
        explicitTotalTokens: 10
      })
    ).toBe(27)
  })
})
