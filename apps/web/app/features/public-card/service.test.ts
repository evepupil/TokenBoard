import { describe, expect, test } from 'vitest'
import {
  getPublicRouteSlug,
  getPublicUsageCard,
  getPublicUsageJson,
  normalizePublicSlug
} from './service'

describe('public card service', () => {
  test('normalizes slugs captured from extension routes', () => {
    expect(normalizePublicSlug('eve-tokenboard.json', 'json')).toBe('eve-tokenboard')
    expect(normalizePublicSlug('eve-tokenboard.svg', 'svg')).toBe('eve-tokenboard')
    expect(normalizePublicSlug('eve-tokenboard', 'json')).toBe('eve-tokenboard')
  })

  test('reads slugs from Hono extension route params', () => {
    expect(getPublicRouteSlug({ slug: 'eve-tokenboard.json' }, 'json')).toBe('eve-tokenboard')
    expect(getPublicRouteSlug({ 'slug.json': 'eve-tokenboard' }, 'json')).toBe('eve-tokenboard')
    expect(getPublicRouteSlug({ 'slug.svg': 'eve-tokenboard' }, 'svg')).toBe('eve-tokenboard')
  })

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
                  totalCostUsd: 3.75,
                  todayTokens: 100,
                  todayCostUsd: 0.2,
                  monthTokens: 500,
                  monthCostUsd: 1.5
                }
              },
              async all() {
                if (sql.includes('GROUP BY source')) {
                  return { results: [{ source: 'codex', totalTokens: 300 }] }
                }

                return { results: [{ model: 'gpt-5.4', totalTokens: 500, costUsd: 1.5 }] }
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
      total: { tokens: 1200, costUsd: 3.75 },
      today: { tokens: 100, costUsd: 0.2 },
      month: { tokens: 500, costUsd: 1.5 },
      sourceSplit: [{ source: 'codex', totalTokens: 300 }],
      topModels: [{ model: 'gpt-5.4', totalTokens: 500, costUsd: 1.5 }]
    })
    expect(JSON.stringify(result)).not.toContain('internal-user-id')
    expect(bindings[0]).toEqual(['eve'])
    expect(bindings[1]).toEqual(['2026-04-29', '2026-04-29', '2026-04-01', '2026-04-01', 'internal-user-id'])
    for (const sql of sqlStatements.slice(1)) {
      expect(sql).toContain('deduped_daily_usage')
      expect(sql).toContain("device_id <> 'legacy'")
      expect(sql).toContain('NOT EXISTS')
    }
  })

  test('renders a GitHub card with total and monthly token statistics', async () => {
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
                  totalCostUsd: 42.5,
                  todayTokens: 100,
                  todayCostUsd: 0.2,
                  monthTokens: 89012,
                  monthCostUsd: 6.78
                }
              },
              async all() {
                return { results: [] }
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
    expect(svg).toContain('Total Cost')
    expect(svg).toContain('$42.50')
    expect(svg).not.toContain('Monthly Tokens')
    expect(svg).toContain('card-logo-panel')
    expect(svg).toContain('card-logo-lime')
    expect(svg).toContain('M130 118H282V164H229V382H181V164H130V118Z')
    expect(svg).toContain('M120 390H392')
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
})
