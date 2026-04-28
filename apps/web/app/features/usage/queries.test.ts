import { describe, expect, test } from 'vitest'
import { getUsageSummary } from './queries'

describe('getUsageSummary', () => {
  test('returns dashboard totals, source split, and last sync for one user', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('COUNT(*) as deviceCount')) {
                  return {
                    todayTokens: 300,
                    todayCostUsd: 0.42,
                    monthTokens: 1200,
                    monthCostUsd: 1.7,
                    lastSyncedAt: '2026-04-28T08:00:00.000Z',
                    deviceCount: 2
                  }
                }

                return null
              },
              async all() {
                return {
                  results: [
                    { source: 'claude-code', totalTokens: 800 },
                    { source: 'codex', totalTokens: 400 }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const summary = await getUsageSummary(db, {
      userId: 'seed-user',
      today: '2026-04-28',
      monthStart: '2026-04-01'
    })

    expect(summary).toEqual({
      todayTokens: 300,
      todayCostUsd: 0.42,
      monthTokens: 1200,
      monthCostUsd: 1.7,
      lastSyncedAt: '2026-04-28T08:00:00.000Z',
      deviceCount: 2,
      sourceSplit: [
        { source: 'claude-code', totalTokens: 800 },
        { source: 'codex', totalTokens: 400 }
      ]
    })
    expect(bindings[0]).toEqual(['seed-user', '2026-04-28', '2026-04-01'])
    expect(bindings[1]).toEqual(['seed-user', '2026-04-01'])
    expect(sqlStatements[0]).toContain('daily_usage')
    expect(sqlStatements[0]).toContain('LEFT JOIN device_stats')
  })
})
