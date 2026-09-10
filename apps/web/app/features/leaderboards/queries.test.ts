import { describe, expect, test } from 'vitest'
import { listLeaderboard } from './queries'

function createDb(
  results = [
    {
      slug: 'eve-tokenboard',
      displayName: 'Eve',
      totalTokens: 1000,
      totalTokensWithoutCacheRead: 750,
      costUsd: 2.5,
      costAvailable: 1
    }
  ]
) {
  const sqlStatements: string[] = []
  const bindings: unknown[][] = []
  const db = {
    prepare(sql: string) {
      sqlStatements.push(sql)
      return {
        bind(...values: unknown[]) {
          bindings.push(values)
          return {
            async all() {
              return {
                results
              }
            }
          }
        }
      }
    }
  } as unknown as D1Database

  return { db, sqlStatements, bindings }
}

describe('listLeaderboard', () => {
  test('lists monthly token leaderboard using a date range', async () => {
    const { db, sqlStatements, bindings } = createDb()

    const entries = await listLeaderboard(db, {
      period: 'monthly',
      metric: 'tokens',
      startDate: '2026-04-01',
      endDateExclusive: '2026-05-01',
      limit: 20
    })

    expect(entries).toEqual([
      {
        rank: 1,
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        totalTokens: 1000,
        totalTokensWithoutCacheRead: 750,
        cacheReadRate: 0.25,
        costUsd: 2.5,
        costAvailable: true
      }
    ])
    expect(sqlStatements[0]).toContain('effective_daily_usage_summary')
    expect(sqlStatements[0]).toContain('fallback_daily_usage_summary')
    expect(sqlStatements[0]).toContain('daily_usage.usage_date >= ? AND daily_usage.usage_date < ?')
    expect(sqlStatements[0]).toContain('daily_usage_summary.usage_date >= ? AND daily_usage_summary.usage_date < ?')
    expect(sqlStatements[0]).toContain('deduped_daily_usage')
    expect(sqlStatements[0]).toContain('ORDER BY totalTokens DESC, costUsd DESC')
    expect(bindings[0]).toEqual(['2026-04-01', '2026-05-01', '2026-04-01', '2026-05-01', 20])
  })

  test('lists monthly cost leaderboard ordered by cost first', async () => {
    const { db, sqlStatements } = createDb()

    await listLeaderboard(db, {
      period: 'monthly',
      metric: 'cost',
      startDate: '2026-04-01',
      endDateExclusive: '2026-05-01',
      limit: 20
    })

    expect(sqlStatements[0]).toContain('ORDER BY costUsd DESC, totalTokens DESC')
    expect(sqlStatements[0]).toContain(
      "source IN ('antigravity-cli', 'antigravity', 'antigravity-ide', 'grok-build', 'deepseek-harness')"
    )
    expect(sqlStatements[0]).toContain('MIN(CASE')
    expect(sqlStatements[0]).toContain(
      "SUM(CASE WHEN effective_daily_usage_summary.source IN ('antigravity-cli', 'antigravity', 'antigravity-ide', 'grok-build', 'deepseek-harness') THEN 0 ELSE effective_daily_usage_summary.cost_usd END)"
    )
  })

  test('marks mixed billable and Antigravity usage cost unavailable', async () => {
    const { db } = createDb([
      {
        slug: 'mixed-user',
        displayName: 'Mixed User',
        totalTokens: 1300,
        totalTokensWithoutCacheRead: 1100,
        costUsd: 2.5,
        costAvailable: 0
      }
    ])

    const entries = await listLeaderboard(db, {
      period: 'monthly',
      metric: 'cost',
      startDate: '2026-04-01',
      endDateExclusive: '2026-05-01',
      limit: 20
    })

    expect(entries[0]?.costUsd).toBe(2.5)
    expect(entries[0]?.costAvailable).toBe(false)
  })

  test('lists leaderboard ordered by tokens without cache reads', async () => {
    const { db, sqlStatements } = createDb()

    await listLeaderboard(db, {
      period: 'monthly',
      metric: 'tokens-without-cache-read',
      startDate: '2026-04-01',
      endDateExclusive: '2026-05-01',
      limit: 20
    })

    expect(sqlStatements[0]).toContain('totalTokensWithoutCacheRead')
    expect(sqlStatements[0]).toContain('effective_daily_usage_summary.total_tokens_without_cache_read')
    expect(sqlStatements[0]).toContain('ORDER BY totalTokensWithoutCacheRead DESC, totalTokens DESC, costUsd DESC')
  })
})
