import { describe, expect, test } from 'vitest'
import { listLeaderboard } from './queries'

function createDb() {
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
                results: [
                  {
                    slug: 'eve-tokenboard',
                    displayName: 'Eve',
                    totalTokens: 1000,
                    costUsd: 2.5
                  }
                ]
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
        costUsd: 2.5
      }
    ])
    expect(sqlStatements[0]).toContain('daily_usage.usage_date >= ?')
    expect(sqlStatements[0]).toContain('daily_usage.usage_date < ?')
    expect(sqlStatements[0]).toContain('ORDER BY totalTokens DESC, costUsd DESC')
    expect(bindings[0]).toEqual(['2026-04-01', '2026-05-01', 20])
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
  })
})
