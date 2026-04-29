import { describe, expect, test } from 'vitest'
import { getLeaderboard } from './service'

describe('getLeaderboard', () => {
  test('uses the current month range for monthly leaderboards', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await getLeaderboard(
      db,
      { period: 'monthly', metric: 'cost' },
      new Date('2026-04-29T10:00:00.000Z')
    )

    expect(bindings[0]).toEqual(['2026-04-01', '2026-05-01', 50])
    expect(sqlStatements[0]).toContain('ORDER BY costUsd DESC, totalTokens DESC')
  })
})
