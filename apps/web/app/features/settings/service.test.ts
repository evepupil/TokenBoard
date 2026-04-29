import { describe, expect, test } from 'vitest'
import {
  getCanonicalPublicOrigin,
  getProfileSettings,
  parseProfileForm,
  updateProfileSettings
} from './service'

describe('settings service', () => {
  test('prefers configured public origin over request origin', () => {
    expect(
      getCanonicalPublicOrigin({
        configuredOrigin: 'https://tokenboard.chaosyn.com/',
        requestOrigin: 'https://tokenboard.yeton92479.workers.dev'
      })
    ).toBe('https://tokenboard.chaosyn.com')
  })

  test('parses public profile form checkboxes', () => {
    expect(
      parseProfileForm({
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'Asia/Hong_Kong',
        isPublic: 'on',
        participatesInLeaderboards: 'on'
      })
    ).toEqual({
      slug: 'eve-tokenboard',
      displayName: 'Eve',
      timezone: 'Asia/Hong_Kong',
      isPublic: true,
      participatesInLeaderboards: true
    })
  })

  test('updates profile after checking slug ownership', async () => {
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
                return null
              },
              async run() {
                return { success: true }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await updateProfileSettings(
      db,
      'user_1',
      {
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'Asia/Hong_Kong',
        isPublic: true,
        participatesInLeaderboards: false
      },
      '2026-04-29T10:00:00.000Z'
    )

    expect(sqlStatements[0]).toContain('SELECT user_id as userId FROM profiles')
    expect(sqlStatements[1]).toContain('UPDATE profiles')
    expect(bindings[0]).toEqual(['eve-tokenboard', 'user_1'])
    expect(bindings[1]).toEqual([
      'eve-tokenboard',
      'Eve',
      'Asia/Hong_Kong',
      1,
      0,
      '2026-04-29T10:00:00.000Z',
      'user_1'
    ])
  })

  test('uses the canonical origin for public URLs', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  slug: 'eve-tokenboard',
                  displayName: 'Eve',
                  timezone: 'Asia/Hong_Kong',
                  isPublic: 1,
                  participatesInLeaderboards: 1
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileSettings(
      db,
      'user_1',
      'https://tokenboard.chaosyn.com'
    )

    expect(settings.publicJsonUrl).toBe(
      'https://tokenboard.chaosyn.com/api/public/eve-tokenboard.json'
    )
    expect(settings.publicSvgUrl).toBe(
      'https://tokenboard.chaosyn.com/api/public/eve-tokenboard.svg'
    )
  })

  test('makes a profile public when enabling leaderboard participation', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return null
              },
              async run() {
                return { success: true }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await updateProfileSettings(
      db,
      'user_1',
      {
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: true
      },
      '2026-04-29T10:00:00.000Z'
    )

    expect(bindings[1]).toEqual([
      'eve-tokenboard',
      'Eve',
      'UTC',
      1,
      1,
      '2026-04-29T10:00:00.000Z',
      'user_1'
    ])
  })

  test('rejects a slug owned by another user', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { userId: 'other-user' }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(
      updateProfileSettings(db, 'user_1', {
        slug: 'taken',
        displayName: 'Eve',
        timezone: 'UTC',
        isPublic: false,
        participatesInLeaderboards: false
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
