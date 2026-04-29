import { describe, expect, test } from 'vitest'
import { getDailyUsageTrend, getUsageDetails, getUsageSummary } from './queries'

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

describe('getDailyUsageTrend', () => {
  test('returns a continuous daily trend and fills missing days with zeroes', async () => {
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
                    { usageDate: '2026-04-27', totalTokens: 120, costUsd: 0.12 },
                    { usageDate: '2026-04-29', totalTokens: 340, costUsd: 0.34 }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const trend = await getDailyUsageTrend(db, {
      userId: 'user_1',
      startDate: '2026-04-27',
      endDate: '2026-04-29'
    })

    expect(trend).toEqual([
      { usageDate: '2026-04-27', totalTokens: 120, costUsd: 0.12 },
      { usageDate: '2026-04-28', totalTokens: 0, costUsd: 0 },
      { usageDate: '2026-04-29', totalTokens: 340, costUsd: 0.34 }
    ])
    expect(bindings[0]).toEqual(['user_1', '2026-04-27', '2026-04-29'])
    expect(sqlStatements[0]).toContain('GROUP BY usage_date')
    expect(sqlStatements[0]).toContain('ORDER BY usage_date ASC')
  })
})

describe('getUsageDetails', () => {
  test('returns filtered daily totals and model rows for a date range', async () => {
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
                if (sql.includes('GROUP BY usage_date, source, model')) {
                  return {
                    results: [
                      {
                        usageDate: '2026-04-29',
                        source: 'claude-code',
                        model: 'claude-sonnet',
                        inputTokens: 100,
                        outputTokens: 80,
                        cacheCreationTokens: 60,
                        cacheReadTokens: 100,
                        totalTokens: 340,
                        costUsd: 0.34,
                        sessionCount: 3
                      }
                    ]
                  }
                }

                return {
                  results: [
                    {
                      usageDate: '2026-04-27',
                      source: 'claude-code',
                      totalTokens: 120,
                      costUsd: 0.12,
                      sessionCount: 2
                    },
                    {
                      usageDate: '2026-04-29',
                      source: 'claude-code',
                      totalTokens: 340,
                      costUsd: 0.34,
                      sessionCount: 3
                    }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const details = await getUsageDetails(db, {
      userId: 'user_1',
      source: 'claude-code',
      startDate: '2026-04-27',
      endDate: '2026-04-29',
      modelQuery: 'sonnet'
    })

    expect(details.summary).toEqual({
      totalTokens: 460,
      costUsd: 0.46,
      sessionCount: 5,
      activeDays: 2
    })
    expect(details.dailyRows).toEqual([
      {
        usageDate: '2026-04-27',
        totalTokens: 120,
        costUsd: 0.12,
        sessionCount: 2,
        sourceSplit: [{ source: 'claude-code', totalTokens: 120 }],
        modelRows: []
      },
      {
        usageDate: '2026-04-28',
        totalTokens: 0,
        costUsd: 0,
        sessionCount: 0,
        sourceSplit: [],
        modelRows: []
      },
      {
        usageDate: '2026-04-29',
        totalTokens: 340,
        costUsd: 0.34,
        sessionCount: 3,
        sourceSplit: [{ source: 'claude-code', totalTokens: 340 }],
        modelRows: [
          {
            usageDate: '2026-04-29',
            source: 'claude-code',
            model: 'claude-sonnet',
            inputTokens: 100,
            outputTokens: 80,
            cacheCreationTokens: 60,
            cacheReadTokens: 100,
            totalTokens: 340,
            costUsd: 0.34,
            sessionCount: 3
          }
        ]
      }
    ])
    expect(details.modelRows).toEqual([
      {
        usageDate: '2026-04-29',
        source: 'claude-code',
        model: 'claude-sonnet',
        inputTokens: 100,
        outputTokens: 80,
        cacheCreationTokens: 60,
        cacheReadTokens: 100,
        totalTokens: 340,
        costUsd: 0.34,
        sessionCount: 3
      }
    ])
    expect(bindings).toEqual([
      ['user_1', '2026-04-27', '2026-04-29', 'claude-code', 'claude-code', 'sonnet', 'sonnet'],
      ['user_1', '2026-04-27', '2026-04-29', 'claude-code', 'claude-code', 'sonnet', 'sonnet']
    ])
    expect(sqlStatements[0]).toContain('GROUP BY usage_date, source')
    expect(sqlStatements[0]).toContain('lower(model)')
    expect(sqlStatements[1]).toContain('GROUP BY usage_date, source, model')
    expect(sqlStatements[1]).toContain('lower(model)')
  })
})
