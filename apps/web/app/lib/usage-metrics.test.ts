import { describe, expect, test } from 'vitest'
import { cacheReadRate, cacheReadRateFromTotals, formatPercentRate } from './usage-metrics'

describe('usage metrics', () => {
  test('calculates cache read rate from cache reads and totals', () => {
    expect(cacheReadRate({ cacheReadTokens: 25, totalTokens: 100 })).toBe(0.25)
    expect(cacheReadRate({ cacheReadTokens: 0, totalTokens: 0 })).toBe(0)
  })

  test('calculates cache read rate from total and no-cache-read totals', () => {
    expect(cacheReadRateFromTotals({
      totalTokens: 1000,
      totalTokensWithoutCacheRead: 750
    })).toBe(0.25)
    expect(cacheReadRateFromTotals({
      totalTokens: 0,
      totalTokensWithoutCacheRead: 0
    })).toBe(0)
  })

  test('clamps invalid derived cache reads to zero', () => {
    expect(cacheReadRateFromTotals({
      totalTokens: 100,
      totalTokensWithoutCacheRead: 120
    })).toBe(0)
  })

  test('formats whole and sub-one-percent rates', () => {
    expect(formatPercentRate(0.25)).toBe('25%')
    expect(formatPercentRate(0.004)).toBe('0.4%')
  })
})
