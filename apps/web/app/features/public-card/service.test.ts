import { describe, expect, test } from 'vitest'
import { getPublicRouteSlug, getPublicUsageJson, normalizePublicSlug } from './service'

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
    const db = {
      prepare(sql: string) {
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
                    isPublic: 1
                  }
                }

                return {
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
      today: { tokens: 100, costUsd: 0.2 },
      month: { tokens: 500, costUsd: 1.5 },
      sourceSplit: [{ source: 'codex', totalTokens: 300 }],
      topModels: [{ model: 'gpt-5.4', totalTokens: 500, costUsd: 1.5 }]
    })
    expect(JSON.stringify(result)).not.toContain('internal-user-id')
    expect(bindings[0]).toEqual(['eve'])
    expect(bindings[1]).toEqual(['2026-04-29', '2026-04-29', '2026-04-01', '2026-04-01', 'internal-user-id'])
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
