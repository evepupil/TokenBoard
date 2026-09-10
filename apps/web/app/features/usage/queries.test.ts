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
                return {
                  todayTokens: 300,
                  todayTokensWithoutCacheRead: 220,
                  todayCostUsd: 0.42,
                  todayCostAvailable: 1,
                  monthTokens: 1200,
                  monthTokensWithoutCacheRead: 900,
                  monthCostUsd: 1.7,
                  monthCostAvailable: 0,
                  lastSyncedAt: '2026-04-28T08:00:00.000Z',
                  deviceCount: 2,
                  sourceSplit: JSON.stringify([
                    { source: 'claude-code', totalTokens: 800, totalTokensWithoutCacheRead: 650 },
                    { source: 'codex', totalTokens: 400, totalTokensWithoutCacheRead: 250 }
                  ])
                }
              },
              async all() {
                throw new Error('getUsageSummary should use one D1 query')
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
      todayTokensWithoutCacheRead: 220,
      todayCacheReadRate: 80 / 300,
      todayCostUsd: 0.42,
      todayCostAvailable: true,
      monthTokens: 1200,
      monthTokensWithoutCacheRead: 900,
      monthCacheReadRate: 300 / 1200,
      monthCostUsd: 1.7,
      monthCostAvailable: false,
      lastSyncedAt: '2026-04-28T08:00:00.000Z',
      deviceCount: 2,
      sourceSplit: [
        { source: 'claude-code', totalTokens: 800, totalTokensWithoutCacheRead: 650, cacheReadRate: 150 / 800 },
        { source: 'codex', totalTokens: 400, totalTokensWithoutCacheRead: 250, cacheReadRate: 150 / 400 }
      ]
    })
    expect(bindings[0]).toEqual(['seed-user', '2026-04-28', '2026-04-01'])
    expect(bindings).toHaveLength(1)
    expect(sqlStatements).toHaveLength(1)
    expect(sqlStatements[0]).toContain('effective_daily_usage_summary')
    expect(sqlStatements[0]).toContain('fallback_daily_usage_summary')
    expect(sqlStatements[0]).toContain('month_usage AS')
    expect(sqlStatements[0]).toContain('daily_usage.usage_date >= (SELECT month_start FROM params)')
    expect(sqlStatements[0]).toContain(
      "effective_daily_usage_summary.usage_date < date(params.month_start, '+1 month')"
    )
    expect(sqlStatements[0]).not.toContain('CASE WHEN daily_usage_summary.usage_date')
    expect(sqlStatements[0]).toContain('total_tokens_without_cache_read')
    expect(sqlStatements[0]).toContain('deduped_daily_usage')
    expect(sqlStatements[0]).toContain('ORDER BY total_tokens_without_cache_read DESC, total_tokens DESC')
    expect(sqlStatements[0]).toContain('LEFT JOIN device_stats')
  })

  test('can read dashboard totals in summary strict mode without raw usage fallback', async () => {
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind() {
            return {
              async first() {
                return null
              },
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const summary = await getUsageSummary(db, {
      userId: 'seed-user',
      today: '2026-04-28',
      monthStart: '2026-04-01',
      summaryStrict: true
    })

    expect(summary).toEqual({
      todayTokens: 0,
      todayTokensWithoutCacheRead: 0,
      todayCacheReadRate: 0,
      todayCostUsd: 0,
      todayCostAvailable: true,
      monthTokens: 0,
      monthTokensWithoutCacheRead: 0,
      monthCacheReadRate: 0,
      monthCostUsd: 0,
      monthCostAvailable: true,
      lastSyncedAt: null,
      deviceCount: 0,
      sourceSplit: []
    })
    expect(sqlStatements.join('\n')).toContain('FROM daily_usage_summary')
    expect(sqlStatements.join('\n')).not.toContain('fallback_daily_usage_summary')
    expect(sqlStatements.join('\n')).not.toMatch(/FROM daily_usage(?!_summary)/)
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
                    {
                      usageDate: '2026-04-27',
                      totalTokens: 120,
                      totalTokensWithoutCacheRead: 100,
                      costUsd: 0.12,
                      costAvailable: 1
                    },
                    {
                      usageDate: '2026-04-29',
                      totalTokens: 340,
                      totalTokensWithoutCacheRead: 240,
                      costUsd: 0.34,
                      costAvailable: 0
                    }
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
      {
        usageDate: '2026-04-27',
        totalTokens: 120,
        totalTokensWithoutCacheRead: 100,
        cacheReadRate: 20 / 120,
        costUsd: 0.12,
        costAvailable: true
      },
      {
        usageDate: '2026-04-28',
        totalTokens: 0,
        totalTokensWithoutCacheRead: 0,
        cacheReadRate: 0,
        costUsd: 0,
        costAvailable: true
      },
      {
        usageDate: '2026-04-29',
        totalTokens: 340,
        totalTokensWithoutCacheRead: 240,
        cacheReadRate: 100 / 340,
        costUsd: 0.34,
        costAvailable: false
      }
    ])
    expect(bindings[0]).toEqual(['user_1', '2026-04-27', '2026-04-29', 'user_1', '2026-04-27', '2026-04-29'])
    expect(sqlStatements[0]).toContain('effective_daily_usage_summary')
    expect(sqlStatements[0]).toContain('fallback_daily_usage_summary')
    expect(sqlStatements[0]).toContain('SUM(total_tokens_without_cache_read)')
    expect(sqlStatements[0]).toContain('deduped_daily_usage')
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
                        cacheReadTokens: 60,
                        totalTokens: 340,
                        totalTokensWithoutCacheRead: 240,
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
                      totalTokensWithoutCacheRead: 100,
                      costUsd: 0.12,
                      sessionCount: 2
                    },
                    {
                      usageDate: '2026-04-29',
                      source: 'claude-code',
                      totalTokens: 340,
                      totalTokensWithoutCacheRead: 240,
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
      deviceId: 'dev_123',
      modelQuery: 'sonnet'
    })

    expect(details.summary).toEqual({
      totalTokens: 460,
      totalTokensWithoutCacheRead: 340,
      cacheReadRate: 120 / 460,
      costUsd: 0.46,
      sessionCount: 5,
      activeDays: 2
    })
    expect(details.dailyRows).toEqual([
      {
        usageDate: '2026-04-27',
        totalTokens: 120,
        totalTokensWithoutCacheRead: 100,
        cacheReadRate: 20 / 120,
        costUsd: 0.12,
        sessionCount: 2,
        sourceSplit: [
          { source: 'claude-code', totalTokens: 120, totalTokensWithoutCacheRead: 100, cacheReadRate: 20 / 120 }
        ],
        modelRows: []
      },
      {
        usageDate: '2026-04-28',
        totalTokens: 0,
        totalTokensWithoutCacheRead: 0,
        cacheReadRate: 0,
        costUsd: 0,
        sessionCount: 0,
        sourceSplit: [],
        modelRows: []
      },
      {
        usageDate: '2026-04-29',
        totalTokens: 340,
        totalTokensWithoutCacheRead: 240,
        cacheReadRate: 100 / 340,
        costUsd: 0.34,
        sessionCount: 3,
        sourceSplit: [
          { source: 'claude-code', totalTokens: 340, totalTokensWithoutCacheRead: 240, cacheReadRate: 100 / 340 }
        ],
        modelRows: [
          {
            usageDate: '2026-04-29',
            source: 'claude-code',
            model: 'claude-sonnet',
            inputTokens: 100,
            outputTokens: 80,
            cacheCreationTokens: 60,
            cacheReadTokens: 60,
            totalTokens: 340,
            totalTokensWithoutCacheRead: 240,
            cacheReadRate: 100 / 340,
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
        cacheReadTokens: 60,
        totalTokens: 340,
        totalTokensWithoutCacheRead: 240,
        cacheReadRate: 100 / 340,
        costUsd: 0.34,
        sessionCount: 3
      }
    ])
    expect(bindings).toEqual([
      ['user_1', '2026-04-27', '2026-04-29', 'claude-code', 'claude-code', 'dev_123', 'dev_123', 'sonnet', 'sonnet'],
      ['user_1', '2026-04-27', '2026-04-29', 'claude-code', 'claude-code', 'dev_123', 'dev_123', 'sonnet', 'sonnet']
    ])
    expect(sqlStatements[0]).toContain('GROUP BY usage_date, source')
    expect(sqlStatements[0]).toContain('SUM(total_tokens - cache_read_tokens)')
    expect(sqlStatements[0]).toContain('device_id')
    expect(sqlStatements[0]).toContain('lower(model)')
    expect(sqlStatements[1]).toContain('GROUP BY usage_date, source, model')
    expect(sqlStatements[1]).toContain('SUM(total_tokens - cache_read_tokens)')
    expect(sqlStatements[1]).toContain('device_id')
    expect(sqlStatements[1]).toContain('lower(model)')
    expect(sqlStatements[0]).not.toContain('deduped_daily_usage')
    expect(sqlStatements[1]).not.toContain('deduped_daily_usage')
  })

  test('dedupes legacy rows when querying all devices', async () => {
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
                const isDedupedQuery = sql.includes('FROM deduped_daily_usage')
                const totalTokens = isDedupedQuery ? 100 : 1100
                const costUsd = isDedupedQuery ? 1 : 11

                if (sql.includes('GROUP BY usage_date, source, model')) {
                  return {
                    results: [
                      {
                        usageDate: '2026-04-29',
                        source: 'codex',
                        model: 'gpt-5',
                        inputTokens: totalTokens,
                        outputTokens: 0,
                        cacheCreationTokens: 0,
                        cacheReadTokens: 0,
                        totalTokens,
                        totalTokensWithoutCacheRead: totalTokens,
                        costUsd,
                        sessionCount: 1
                      }
                    ]
                  }
                }

                return {
                  results: [
                    {
                      usageDate: '2026-04-29',
                      source: 'codex',
                      totalTokens,
                      totalTokensWithoutCacheRead: totalTokens,
                      costUsd,
                      sessionCount: 1
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
      source: 'all',
      startDate: '2026-04-27',
      endDate: '2026-04-29',
      deviceId: 'all'
    })

    expect(details.summary).toEqual({
      totalTokens: 100,
      totalTokensWithoutCacheRead: 100,
      cacheReadRate: 0,
      costUsd: 1,
      sessionCount: 1,
      activeDays: 1
    })
    expect(details.modelRows[0]?.totalTokens).toBe(100)
    expect(sqlStatements[0]).toContain('deduped_daily_usage')
    expect(sqlStatements[1]).toContain('deduped_daily_usage')
    expect(sqlStatements[0]).toContain('FROM deduped_daily_usage')
    expect(sqlStatements[1]).toContain('FROM deduped_daily_usage')
    expect(sqlStatements[0]).toContain("device_id <> 'legacy'")
    expect(sqlStatements[0]).toContain('NOT EXISTS')
    expect(sqlStatements[0]).toContain('daily_usage.user_id = ?')
    expect(sqlStatements[0]).toContain('daily_usage.usage_date >= ?')
    expect(sqlStatements[0]).toContain('daily_usage.usage_date <= ?')
    expect(bindings).toEqual([
      [
        'user_1',
        '2026-04-27',
        '2026-04-29',
        'all',
        'all',
        '',
        '',
        'user_1',
        '2026-04-27',
        '2026-04-29',
        'all',
        'all',
        'all',
        'all',
        '',
        ''
      ],
      [
        'user_1',
        '2026-04-27',
        '2026-04-29',
        'all',
        'all',
        '',
        '',
        'user_1',
        '2026-04-27',
        '2026-04-29',
        'all',
        'all',
        'all',
        'all',
        '',
        ''
      ]
    ])
  })

  test('pushes all-device detail filters into the deduped CTE', async () => {
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
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await getUsageDetails(db, {
      userId: 'user_1',
      source: 'codex',
      startDate: '2026-04-27',
      endDate: '2026-04-29',
      deviceId: 'all',
      modelQuery: 'gpt'
    })

    expect(sqlStatements[0]).toContain('daily_usage.user_id = ?')
    expect(sqlStatements[0]).toContain('daily_usage.usage_date >= ?')
    expect(sqlStatements[0]).toContain('daily_usage.usage_date <= ?')
    expect(sqlStatements[0]).toContain("(? = 'all' OR daily_usage.source = ?)")
    expect(sqlStatements[0]).toContain("(? = '' OR lower(daily_usage.model) LIKE '%' || lower(?) || '%')")
    expect(bindings[0]?.slice(0, 7)).toEqual(['user_1', '2026-04-27', '2026-04-29', 'codex', 'codex', 'gpt', 'gpt'])
    expect(bindings[1]?.slice(0, 7)).toEqual(bindings[0]?.slice(0, 7))
  })

  test('dedupes legacy rows when device filter is omitted', async () => {
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind() {
            return {
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await getUsageDetails(db, {
      userId: 'user_1',
      source: 'all',
      startDate: '2026-04-27',
      endDate: '2026-04-29'
    })

    expect(sqlStatements[0]).toContain('deduped_daily_usage')
    expect(sqlStatements[1]).toContain('deduped_daily_usage')
    expect(sqlStatements[0]).toContain('FROM deduped_daily_usage')
    expect(sqlStatements[1]).toContain('FROM deduped_daily_usage')
  })

  test('dedupes legacy rows for all-device filter variants', async () => {
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
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await getUsageDetails(db, {
      userId: 'user_1',
      source: 'all',
      startDate: '2026-04-27',
      endDate: '2026-04-29',
      deviceId: ' ALL '
    })

    expect(sqlStatements[0]).toContain('FROM deduped_daily_usage')
    expect(sqlStatements[1]).toContain('FROM deduped_daily_usage')
    expect(bindings[0]?.slice(12, 14)).toEqual(['all', 'all'])
    expect(bindings[1]?.slice(12, 14)).toEqual(['all', 'all'])
  })

  test('normalizes invalid direct device filters to all devices', async () => {
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
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await getUsageDetails(db, {
      userId: 'user_1',
      source: 'all',
      startDate: '2026-04-27',
      endDate: '2026-04-29',
      deviceId: 'dev bad!'
    })

    expect(sqlStatements[0]).toContain('FROM deduped_daily_usage')
    expect(sqlStatements[1]).toContain('FROM deduped_daily_usage')
    expect(bindings[0]?.slice(12, 14)).toEqual(['all', 'all'])
    expect(bindings[1]?.slice(12, 14)).toEqual(['all', 'all'])
  })
})
