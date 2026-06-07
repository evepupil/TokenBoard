import { describe, expect, test } from 'vitest'
import { defaultPublicCardConfig } from '../public-card/config'
import {
  getCanonicalPublicOrigin,
  getProfileDisplayName,
  getProfileSettings,
  getProfileTimezoneSettings,
  parseProfilePageForm,
  parseProfileForm,
  updateProfilePageSettings,
  updateProfileSettings
} from './service'

describe('settings service', () => {
  test('prefers configured public origin over request origin', () => {
    expect(
      getCanonicalPublicOrigin({
        configuredOrigin: 'https://tokenboard.example.com/',
        requestOrigin: 'https://preview.example.com'
      })
    ).toBe('https://tokenboard.example.com')
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

  test('rejects invalid profile timezones', () => {
    expect(() =>
      parseProfileForm({
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'Mars/Base'
      })
    ).toThrow()
  })

  test('parses profile page form with public card config', () => {
    expect(parseProfilePageForm({
      slug: 'eve-tokenboard',
      displayName: 'Eve',
      timezone: 'Asia/Hong_Kong',
      isPublic: 'on',
      cardLanguage: 'en',
      cardTheme: 'light',
      cardMetric1: 'todayTokens',
      cardMetric2: 'totalCost'
    })).toMatchObject({
      profile: {
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        timezone: 'Asia/Hong_Kong',
        isPublic: true
      },
      publicCardConfig: {
        language: 'en',
        theme: 'light',
        metrics: ['todayTokens', 'totalCost']
      }
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
    expect(sqlStatements[1]).toContain("timezone_source = 'user'")
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
                  participatesInLeaderboards: 1,
                  createdAt: '2026-04-29T10:00:00.000Z',
                  updatedAt: '2026-04-29T10:00:00.000Z'
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
      'https://tokenboard.example.com'
    )

    expect(settings.publicJsonUrl).toBe(
      'https://tokenboard.example.com/api/public/eve-tokenboard.json'
    )
    expect(settings.publicSvgUrl).toBe(
      'https://tokenboard.example.com/api/public/eve-tokenboard.svg'
    )
    expect(settings.publicMarkdown).toBe(
      '[![TokenBoard](https://tokenboard.example.com/api/public/eve-tokenboard.svg)](https://tokenboard.example.com)'
    )
    expect(settings.publicCardConfig).toEqual(defaultPublicCardConfig)
    expect(settings.shouldUseBrowserTimezoneDefault).toBe(false)
  })

  test('reads stored public card config from profile settings', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  slug: 'eve-tokenboard',
                  displayName: 'Eve',
                  timezone: 'UTC',
                  publicCardConfig: JSON.stringify({
                    language: 'en',
                    theme: 'light',
                    metrics: ['todayTokens', 'totalCost']
                  }),
                  isPublic: 1,
                  participatesInLeaderboards: 1
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileSettings(db, 'user_1', 'https://tokenboard.example.com')

    expect(settings.publicCardConfig).toMatchObject({
      language: 'en',
      theme: 'light',
      metrics: ['todayTokens', 'totalCost']
    })
  })

  test('normalizes legacy profile values for settings pages', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  userId: 'user_1',
                  slug: 'MisonL Profile!',
                  displayName: '  MisonL  ',
                  timezone: 'Mars/Base',
                  isPublic: 1,
                  participatesInLeaderboards: 1
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileSettings(db, 'user_1', 'https://tokenboard.example.com')

    expect(settings.slug).toBe('misonl-profile')
    expect(settings.displayName).toBe('MisonL')
    expect(settings.timezone).toBe('UTC')
    expect(settings.profileNeedsRepair).toBe(true)
    expect(settings.publicCardConfig).toEqual(defaultPublicCardConfig)
  })

  test('reads profile timezone without requiring public card columns', async () => {
    let statement = ''
    const db = {
      prepare(sql: string) {
        statement = sql
        return {
          bind() {
            return {
              async first() {
                return {
                  userId: 'user_1',
                  timezone: 'Mars/Base',
                  timezoneSource: 'default'
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const settings = await getProfileTimezoneSettings(db, 'user_1')

    expect(statement).toContain('timezone')
    expect(statement).not.toContain('public_card_config')
    expect(settings.timezone).toBe('UTC')
    expect(settings.profileNeedsRepair).toBe(true)
  })

  test('marks default UTC profiles as browser-timezone default candidates', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  slug: 'eve-tokenboard',
                  displayName: 'Eve',
                  timezone: 'UTC',
                  isPublic: 0,
                  participatesInLeaderboards: 0,
                  timezoneSource: 'default',
                  createdAt: '2026-04-29T10:00:00.000Z',
                  updatedAt: '2026-04-29T10:00:00.000Z'
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
      'https://tokenboard.example.com'
    )

    expect(settings.shouldUseBrowserTimezoneDefault).toBe(true)
  })

  test('does not mark user-saved UTC profiles for browser timezone autofill', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  slug: 'eve-tokenboard',
                  displayName: 'Eve',
                  timezone: 'UTC',
                  timezoneSource: 'user',
                  isPublic: 0,
                  participatesInLeaderboards: 0,
                  createdAt: '2026-04-29T10:00:00.000Z',
                  updatedAt: '2026-04-29T10:00:00.000Z'
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
      'https://tokenboard.example.com'
    )

    expect(settings.shouldUseBrowserTimezoneDefault).toBe(false)
  })

  test('uses the profile display name for dashboard labels', async () => {
    const db = {
      prepare(sql: string) {
        expect(sql).toContain('SELECT display_name as displayName FROM profiles')
        return {
          bind(userId: string) {
            expect(userId).toBe('user_1')
            return {
              async first() {
                return { displayName: 'New Public Name' }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(getProfileDisplayName(db, 'user_1', 'Old Session Name')).resolves.toBe(
      'New Public Name'
    )
  })

  test('falls back to the session name when profile display name is missing', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return null
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(getProfileDisplayName(db, 'user_1', 'Old Session Name')).resolves.toBe(
      'Old Session Name'
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

  test('updates profile and card settings together', async () => {
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

    await updateProfilePageSettings(
      db,
      'user_1',
      {
        profile: {
          slug: 'eve-tokenboard',
          displayName: 'Eve',
          timezone: 'UTC',
          isPublic: false,
          participatesInLeaderboards: true
        },
        publicCardConfig: {
          ...defaultPublicCardConfig,
          language: 'en',
          metrics: ['todayTokens']
        }
      },
      '2026-04-29T10:00:00.000Z'
    )

    expect(sqlStatements[1]).toContain('public_card_config = ?')
    expect(bindings[1]).toEqual([
      'eve-tokenboard',
      'Eve',
      'UTC',
      JSON.stringify({
        ...defaultPublicCardConfig,
        language: 'en',
        metrics: ['todayTokens']
      }),
      1,
      1,
      '2026-04-29T10:00:00.000Z',
      'user_1'
    ])
  })

  test('clears card config when resetting to defaults', async () => {
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

    await updateProfilePageSettings(
      db,
      'user_1',
      {
        profile: {
          slug: 'eve-tokenboard',
          displayName: 'Eve',
          timezone: 'UTC',
          isPublic: true,
          participatesInLeaderboards: false
        },
        publicCardConfig: null
      },
      '2026-04-29T10:00:00.000Z'
    )

    expect(bindings[1][3]).toBeNull()
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
