import { describe, expect, test } from 'vitest'
import { getPublicUsageCard, getPublicUsageJson, getPublicUsageProfile } from './service'
import { getPublicTotals } from './service/totals'

describe('public card service', () => {
  test('returns public usage without leaking internal ids', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'internal-user-id',
                    slug: 'eve',
                    displayName: 'Eve',
                    timezone: 'Asia/Hong_Kong',
                    publicCardConfig: null,
                    isPublic: 1
                  }
                }

                return {
                  totalTokens: 1200,
                  totalTokensWithoutCacheRead: 900,
                  totalCostUsd: 3.75,
                  totalCostAvailable: 0,
                  todayTokens: 100,
                  todayTokensWithoutCacheRead: 70,
                  todayCostUsd: 0.2,
                  todayCostAvailable: 1,
                  monthTokens: 500,
                  monthTokensWithoutCacheRead: 380,
                  monthCostUsd: 1.5,
                  monthCostAvailable: 0,
                  sourceSplit: JSON.stringify([
                    { source: 'codex', totalTokens: 300, totalTokensWithoutCacheRead: 240 }
                  ]),
                  topModels: JSON.stringify([
                    {
                      model: 'gpt-5.4',
                      totalTokens: 500,
                      totalTokensWithoutCacheRead: 410,
                      costUsd: 1.5,
                      costAvailable: 0
                    }
                  ])
                }
              },
              async all() {
                throw new Error('Public JSON should use one metrics query')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await getPublicUsageJson(db, 'eve', new Date('2026-04-29T10:00:00.000Z'))

    expect(result).toEqual({
      slug: 'eve',
      displayName: 'Eve',
      timezone: 'Asia/Hong_Kong',
      today: { tokens: 100, tokensWithoutCacheRead: 70, cacheReadRate: 0.3, costUsd: 0.2, costAvailable: true },
      total: { tokens: 1200, tokensWithoutCacheRead: 900, cacheReadRate: 0.25, costUsd: 3.75, costAvailable: false },
      month: { tokens: 500, tokensWithoutCacheRead: 380, cacheReadRate: 0.24, costUsd: 1.5, costAvailable: false },
      sourceSplit: [{ source: 'codex', totalTokens: 300, totalTokensWithoutCacheRead: 240, cacheReadRate: 0.2 }],
      topModels: [
        {
          model: 'gpt-5.4',
          totalTokens: 500,
          totalTokensWithoutCacheRead: 410,
          cacheReadRate: 0.18,
          costUsd: 1.5,
          costAvailable: false
        }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('internal-user-id')
    expect(bindings[0]).toEqual(['eve'])
    expect(bindings[1]).toEqual(['internal-user-id', '2026-04-29', '2026-04-01'])
    expect(bindings).toHaveLength(2)
    expect(sqlStatements).toHaveLength(2)
    expect(sqlStatements[1]).toContain('effective_daily_usage_summary')
    expect(sqlStatements[1]).toContain('fallback_daily_usage_summary')
    expect(sqlStatements[1]).toContain('user_usage_totals')
    expect(sqlStatements[1]).toContain('month_usage AS')
    expect(sqlStatements[1]).toContain('source_usage AS')
    expect(sqlStatements[1]).toContain('model_usage AS')
    expect(sqlStatements[1]).toContain(
      "source IN ('antigravity-cli', 'antigravity', 'antigravity-ide', 'grok-build', 'deepseek-harness')"
    )
    expect(sqlStatements[1]).toContain("'costAvailable'")
    expect(sqlStatements[1]).toContain('user_usage_totals.cost_usd')
    expect(sqlStatements[1]).toContain(
      "COALESCE(SUM(CASE WHEN source IN ('antigravity-cli', 'antigravity', 'antigravity-ide', 'grok-build', 'deepseek-harness') THEN 0 ELSE cost_usd END), 0)"
    )
    expect(sqlStatements[1]).toContain(
      "COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN CASE WHEN month_usage.source IN ('antigravity-cli', 'antigravity', 'antigravity-ide', 'grok-build', 'deepseek-harness') THEN 0 ELSE month_usage.cost_usd END ELSE 0 END), 0) as todayCostUsd"
    )
    expect(sqlStatements[1]).toContain(
      "COALESCE(SUM(CASE WHEN month_usage.source IN ('antigravity-cli', 'antigravity', 'antigravity-ide', 'grok-build', 'deepseek-harness') THEN 0 ELSE month_usage.cost_usd END), 0) as monthCostUsd"
    )
    expect(sqlStatements[1]).not.toContain('COALESCE(SUM(effective_daily_usage_summary.cost_usd), 0)')
    expect(sqlStatements[1]).toContain('user_usage_totals.updated_at')
    expect(sqlStatements[1]).toContain('effective_daily_usage_summary.updated_at > user_usage_totals.updated_at')
    expect(sqlStatements[1]).not.toContain(
      "source IN ('antigravity-cli', 'antigravity', 'antigravity-ide')) THEN COALESCE"
    )
    expect(sqlStatements[1]).toContain('effective_daily_usage_summary.usage_date >= params.month_start')
    expect(sqlStatements[1]).toContain(
      "effective_daily_usage_summary.usage_date < date(params.month_start, '+1 month')"
    )
    expect(sqlStatements[1]).not.toContain('CASE WHEN daily_usage_summary.usage_date')
  })

  test('renders a GitHub card with total and monthly token statistics', async () => {
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'user_1',
                    slug: 'eve',
                    displayName: 'Eve & Co',
                    timezone: 'UTC',
                    publicCardConfig: JSON.stringify({
                      language: 'en',
                      theme: 'light',
                      title: 'Custom Usage',
                      subtitle: 'Open stats',
                      showPublicUrl: false,
                      glow: {
                        enabled: false,
                        intensity: 0.2,
                        position: 'center'
                      },
                      metrics: ['todayTokens', 'totalCost']
                    }),
                    isPublic: 1
                  }
                }

                return {
                  totalTokens: 1234567,
                  totalTokensWithoutCacheRead: 345678,
                  totalCostUsd: 42.5,
                  totalCostAvailable: 0,
                  todayTokens: 100,
                  todayTokensWithoutCacheRead: 70,
                  todayCostUsd: 0.2,
                  todayCostAvailable: 1,
                  monthTokens: 89012,
                  monthTokensWithoutCacheRead: 45678,
                  monthCostUsd: 6.78,
                  monthCostAvailable: 0,
                  sourceSplit: JSON.stringify([
                    { source: 'antigravity', totalTokens: 300, totalTokensWithoutCacheRead: 240 }
                  ]),
                  topModels: '[]'
                }
              },
              async all() {
                throw new Error('SVG public card should not query extra rows')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const svg = await getPublicUsageCard(
      db,
      'eve',
      new Date('2026-04-29T10:00:00.000Z'),
      'https://tokenboard.example.com'
    )

    expect(svg).toContain('Custom Usage')
    expect(svg).toContain('Open stats')
    expect(svg).not.toContain('https://tokenboard.example.com')
    expect(svg).toContain('Today Tokens')
    expect(svg).toContain('100')
    expect(svg).toContain('Total Cost*')
    expect(svg).toContain('$42.50')
    expect(svg).toContain('* Some sources report no cost')
    expect(svg).not.toContain('Today Cost*')
    expect(svg).not.toContain('Monthly Cost*')
    expect(svg).not.toContain('Monthly Tokens')
    expect(svg).toContain('data-card-cache-waffle="true"')
    expect(svg).toContain('folio-hatch')
    expect(svg).toContain('transform="translate(18 12)"')
    expect(svg).toContain('fill="#6c50f6"')
    expect(sqlStatements).toHaveLength(2)
    expect(sqlStatements.join('\n')).toContain('GROUP BY source')
    expect(sqlStatements.join('\n')).toContain('GROUP BY model')
    expect(sqlStatements.join('\n')).not.toContain('FROM source_usage')
  })

  test('builds model-only public totals without requiring source split CTEs', async () => {
    let totalsSql = ''
    const db = {
      prepare(sql: string) {
        totalsSql = sql
        return {
          bind(...values: unknown[]) {
            expect(values).toEqual(['user_1', '2026-04-29', '2026-04-01'])
            return {
              async first() {
                return {
                  totalTokens: 1200,
                  totalTokensWithoutCacheRead: 900,
                  totalCostUsd: 3.75,
                  totalCostAvailable: 1,
                  todayTokens: 100,
                  todayTokensWithoutCacheRead: 70,
                  todayCostUsd: 0.2,
                  todayCostAvailable: 0,
                  monthTokens: 500,
                  monthTokensWithoutCacheRead: 380,
                  monthCostUsd: 1.5,
                  monthCostAvailable: 1,
                  sourceSplit: '[]',
                  topModels: JSON.stringify([
                    { model: 'gpt-5.4', totalTokens: 500, totalTokensWithoutCacheRead: 410, costUsd: 1.5 }
                  ])
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await getPublicTotals({
      db,
      userId: 'user_1',
      today: '2026-04-29',
      monthStart: '2026-04-01',
      summaryStrict: false,
      includeBreakdown: true,
      includeSourceSplit: false
    })

    expect(totalsSql).toContain('model_usage AS')
    expect(totalsSql).toContain("'[]' as sourceSplit")
    expect(totalsSql).not.toContain('FROM source_usage')
    expect(totalsSql).toContain('FROM model_usage')
  })

  test('keeps cost availability scoped to each public metric window', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'user_1',
                    slug: 'eve',
                    displayName: 'Eve',
                    timezone: 'UTC',
                    publicCardConfig: JSON.stringify({
                      language: 'en',
                      metrics: ['totalCost', 'monthCost', 'todayCost']
                    }),
                    isPublic: 1
                  }
                }

                return {
                  totalTokens: 10,
                  totalTokensWithoutCacheRead: 10,
                  totalCostUsd: 1,
                  totalCostAvailable: 1,
                  todayTokens: 5,
                  todayTokensWithoutCacheRead: 5,
                  todayCostUsd: 0.5,
                  todayCostAvailable: 0,
                  monthTokens: 6,
                  monthTokensWithoutCacheRead: 6,
                  monthCostUsd: 0.6,
                  monthCostAvailable: 1,
                  sourceSplit: JSON.stringify([
                    { source: 'antigravity-cli', totalTokens: 1, totalTokensWithoutCacheRead: 1 }
                  ]),
                  topModels: '[]'
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const svg = await getPublicUsageCard(db, 'eve', new Date('2026-04-29T10:00:00.000Z'))

    expect(svg).toContain('Total Cost')
    expect(svg).toContain('Monthly Cost')
    expect(svg).toContain('Today Cost*')
    expect(svg).not.toContain('Total Cost*')
  })

  test('rejects a private profile', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  userId: 'user_1',
                  slug: 'eve',
                  displayName: 'Eve',
                  timezone: 'UTC',
                  publicCardConfig: null,
                  isPublic: 0
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(getPublicUsageJson(db, 'eve')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404
    })
  })

  test('uses the public profile timezone for today and monthly public totals', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'user_1',
                    slug: 'eve',
                    displayName: 'Eve',
                    timezone: 'Asia/Shanghai',
                    publicCardConfig: null,
                    isPublic: 1
                  }
                }

                return {
                  totalTokens: 0,
                  totalTokensWithoutCacheRead: 0,
                  totalCostUsd: 0,
                  todayTokens: 0,
                  todayTokensWithoutCacheRead: 0,
                  todayCostUsd: 0,
                  monthTokens: 0,
                  monthTokensWithoutCacheRead: 0,
                  monthCostUsd: 0
                }
              },
              async all() {
                throw new Error('Public card should not query breakdown rows')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await getPublicUsageJson(db, 'eve', new Date('2026-04-30T16:30:00.000Z'))

    expect(bindings[1]).toEqual(['user_1', '2026-05-01', '2026-05-01'])
    expect(bindings).toHaveLength(2)
  })

  test('falls back to UTC for legacy invalid stored timezones instead of crashing', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'user_1',
                    slug: 'misonl-sbphidok',
                    displayName: 'MisonL',
                    timezone: 'Mars/Base',
                    publicCardConfig: null,
                    isPublic: 1
                  }
                }

                return {
                  totalTokens: 0,
                  totalTokensWithoutCacheRead: 0,
                  totalCostUsd: 0,
                  todayTokens: 0,
                  todayTokensWithoutCacheRead: 0,
                  todayCostUsd: 0,
                  monthTokens: 0,
                  monthTokensWithoutCacheRead: 0,
                  monthCostUsd: 0
                }
              },
              async all() {
                throw new Error('Public card should not query breakdown rows')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const json = await getPublicUsageJson(db, 'misonl-sbphidok', new Date('2026-04-30T16:30:00.000Z'))
    const svg = await getPublicUsageCard(db, 'misonl-sbphidok', new Date('2026-04-30T16:30:00.000Z'))

    expect(json.timezone).toBe('UTC')
    expect(bindings[1]).toEqual(['user_1', '2026-04-30', '2026-04-01'])
    expect(svg).toContain('<svg')
  })

  // The SVG renderer never reads `sourceSplit`, so the card path must not compute it: the
  // aggregate is real SQL work on every public card render. The JSON path still needs it, so
  // the two paths are pinned separately.
  test('the SVG card path does not compute the JSON-only source split', async () => {
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'user_1',
                    slug: 'eve',
                    displayName: 'Eve',
                    timezone: 'UTC',
                    publicCardConfig: null,
                    isPublic: 1
                  }
                }

                return {
                  totalTokens: 0,
                  totalTokensWithoutCacheRead: 0,
                  totalCostUsd: 0,
                  todayTokens: 0,
                  todayTokensWithoutCacheRead: 0,
                  todayCostUsd: 0,
                  monthTokens: 0,
                  monthTokensWithoutCacheRead: 0,
                  monthCostUsd: 0
                }
              },
              async all() {
                throw new Error('Public card should not query breakdown rows')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const svg = await getPublicUsageCard(db, 'eve', new Date('2026-04-29T10:00:00.000Z'))

    expect(svg).toContain('<svg')
    expect(sqlStatements).toHaveLength(2)
    // The bare `FROM source_usage` read (and its JSON builder) stays excluded on the SVG path;
    // `model_usage` is computed to feed the card's heatmap-style Model Unit Matrix.
    expect(sqlStatements[1]).not.toContain('FROM source_usage')
    expect(sqlStatements[1]).toContain('FROM model_usage')
    expect(sqlStatements[1]).not.toContain("'source', ordered_sources.source")
    expect(sqlStatements[1]).toContain("'model', ordered_models.model")
    expect(sqlStatements[1]).toContain("'[]' as sourceSplit")
    expect(sqlStatements[1]).toContain('modelCount')
  })

  test('the JSON path still computes the source split', async () => {
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'user_1',
                    slug: 'eve',
                    displayName: 'Eve',
                    timezone: 'UTC',
                    publicCardConfig: null,
                    isPublic: 1
                  }
                }

                return {
                  totalTokens: 0,
                  totalTokensWithoutCacheRead: 0,
                  totalCostUsd: 0,
                  todayTokens: 0,
                  todayTokensWithoutCacheRead: 0,
                  todayCostUsd: 0,
                  monthTokens: 0,
                  monthTokensWithoutCacheRead: 0,
                  monthCostUsd: 0,
                  sourceSplit: '[]',
                  topModels: '[]'
                }
              },
              async all() {
                throw new Error('Public JSON should use one metrics query')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const json = await getPublicUsageJson(db, 'eve', new Date('2026-04-29T10:00:00.000Z'))

    expect(json.sourceSplit).toEqual([])
    expect(sqlStatements).toHaveLength(2)
    expect(sqlStatements[1]).toContain('source_usage AS')
    expect(sqlStatements[1]).toContain('model_usage AS')
  })

  // The profile object is the last step before the id-bearing core becomes public-facing, and
  // nothing reads its `userId` — the JSON and SVG paths both build their responses field by
  // field. TypeScript does not police spreads for excess properties, so a direct serialisation
  // of the object would otherwise reach the public JSON/PII diff unnoticed. This pins the field
  // at the boundary where "core" ends and "public" begins, so it cannot leak by accident.
  test('the public profile object carries no internal user id', async () => {
    const internalUserId = 'internal-user-id'
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: internalUserId,
                    slug: 'eve',
                    displayName: 'Eve',
                    timezone: 'Asia/Shanghai',
                    publicCardConfig: null,
                    isPublic: 1
                  }
                }

                return {
                  totalTokens: 0,
                  totalTokensWithoutCacheRead: 0,
                  totalCostUsd: 0,
                  totalCostAvailable: 1,
                  todayTokens: 0,
                  todayTokensWithoutCacheRead: 0,
                  todayCostUsd: 0,
                  todayCostAvailable: 1,
                  monthTokens: 0,
                  monthTokensWithoutCacheRead: 0,
                  monthCostUsd: 0,
                  monthCostAvailable: 1,
                  costAvailable: 1,
                  sourceSplit: '[]',
                  topModels: '[]'
                }
              },
              async all() {
                throw new Error('The public profile object should not query breakdown rows')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const profile = await getPublicUsageProfile(db, 'eve', new Date('2026-04-29T10:00:00.000Z'))

    expect(profile).not.toHaveProperty('userId')
    expect(JSON.stringify(profile)).not.toContain(internalUserId)
  })

  // The freshness stamp's label must come from what the SQL actually read, not from
  // the render clock: a README fetched in a Viewer cache can render minutes after the
  // aggregates it shows were written. The totals SQL returns a data stamp (the cached
  // rollup's own updated_at, or the newest summary row that overrode it); the service
  // formats it in the owner's zone.
  test('stamps the card with the aggregates’ own freshness in the owner’s zone', async () => {
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'user_1',
                    slug: 'eve',
                    displayName: 'Eve',
                    timezone: 'Asia/Shanghai',
                    // The stored config opts in; the render clock below is deliberately
                    // a different instant to prove which one the card shows.
                    publicCardConfig: JSON.stringify({ showUpdatedAt: true, metrics: ['totalTokens'] }),
                    isPublic: 1
                  }
                }
                return {
                  totalTokens: 1200,
                  totalTokensWithoutCacheRead: 900,
                  totalCostUsd: 3.75,
                  totalCostAvailable: 1,
                  todayTokens: 100,
                  todayTokensWithoutCacheRead: 70,
                  todayCostUsd: 0.2,
                  todayCostAvailable: 1,
                  monthTokens: 500,
                  monthTokensWithoutCacheRead: 380,
                  monthCostUsd: 1.5,
                  monthCostAvailable: 1,
                  // SQLite's strftime form; 21:05Z is 11-24 05:05 in the owner's zone.
                  dataUpdatedAt: '2026-11-23T21:05:00.000Z',
                  sourceSplit: '[]',
                  topModels: '[]'
                }
              },
              async all() {
                throw new Error('Public card should not query breakdown rows')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const svg = await getPublicUsageCard(db, 'eve', new Date('2026-11-23T10:00:00.000Z'))

    expect(svg).toContain('data-card-updated="true"')
    expect(svg).toContain('数据更新：11-24 05:05')
    // Not the render instant (10:00Z = 18:00 +08), not the raw UTC string.
    expect(svg).not.toContain('11-23 18:00')
    expect(svg).not.toContain('21:05')
    expect(sqlStatements[1]).toContain('dataUpdatedAt')

    // The JSON deliberately stays without the field (see UsageCardInput docs): its
    // consumers read numbers, not labels.
    const json = await getPublicUsageJson(db, 'eve', new Date('2026-11-23T10:00:00.000Z'))
    expect(json).not.toHaveProperty('updatedAt')
    expect(json).not.toHaveProperty('dataUpdatedAt')
  })

  // An account with no usage rows has no freshness to stamp: absent totals row means
  // absent dataUpdatedAt, and the card must render without the note, not with a
  // fabricated time.
  test('no stamp when the account has no data behind the totals', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'user_1',
                    slug: 'eve',
                    displayName: 'Eve',
                    timezone: 'UTC',
                    publicCardConfig: JSON.stringify({ showUpdatedAt: true, metrics: ['totalTokens'] }),
                    isPublic: 1
                  }
                }
                return {
                  totalTokens: 0,
                  totalTokensWithoutCacheRead: 0,
                  totalCostUsd: 0,
                  totalCostAvailable: 1,
                  todayTokens: 0,
                  todayTokensWithoutCacheRead: 0,
                  todayCostUsd: 0,
                  todayCostAvailable: 1,
                  monthTokens: 0,
                  monthTokensWithoutCacheRead: 0,
                  monthCostUsd: 0,
                  monthCostAvailable: 1,
                  sourceSplit: '[]',
                  topModels: '[]'
                }
              },
              async all() {
                throw new Error('Public card should not query breakdown rows')
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const svg = await getPublicUsageCard(db, 'eve', new Date('2026-11-23T10:00:00.000Z'))
    expect(svg).not.toContain('data-card-updated')
  })
})
