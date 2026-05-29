import { describe, expect, test } from 'vitest'
import { leaderboardDocumentTitle } from './title'

describe('leaderboardDocumentTitle', () => {
  test('renders the no-cache-read leaderboard title', () => {
    expect(leaderboardDocumentTitle({
      period: 'monthly',
      metric: 'tokens-without-cache-read'
    })).toBe('每月不含缓存读 token排行榜 - TokenBoard')
  })

  test('falls back to the daily token title for unknown query values', () => {
    expect(leaderboardDocumentTitle({
      period: 'weekly',
      metric: 'unknown'
    })).toBe('每日token排行榜 - TokenBoard')
  })
})
