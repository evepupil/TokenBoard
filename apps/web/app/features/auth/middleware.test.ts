import { describe, expect, test } from 'vitest'
import { ensureProfile, verifyUploadToken } from './middleware'

describe('verifyUploadToken', () => {
  test('returns token owner from upload_tokens when bearer token is stored in D1', async () => {
    const user = await verifyUploadToken(
      {
        DB: {
          prepare(sql: string) {
            expect(sql).toContain('FROM upload_tokens')
            expect(sql).toContain('device_id as deviceId')
            return {
              bind(value: string) {
                expect(value).toBe('hash:tb_upload_secret')
                return {
                  async first() {
                    return { userId: 'paired-user', deviceId: 'dev_123' }
                  }
                }
              }
            }
          }
        } as unknown as D1Database
      },
      'Bearer tb_upload_secret',
      async (value) => `hash:${value}`
    )

    expect(user).toEqual({
      id: 'paired-user',
      uploadTokenHash: 'hash:tb_upload_secret',
      deviceId: 'dev_123'
    })
  })

  test('rejects a bearer token that is not stored', async () => {
    await expect(
      verifyUploadToken(
        {
          DB: {
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
        },
        'Bearer wrong-token',
        async (value) => `hash:${value}`
      )
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401
    })
  })

  test('rejects missing or malformed bearer tokens', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('DB should not be queried')
        }
      } as unknown as D1Database
    }

    await expect(verifyUploadToken(env, null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(verifyUploadToken(env, 'Token abc')).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
  })
})

describe('ensureProfile', () => {
  test('creates new profiles as public leaderboard participants by default', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        expect(sql).toContain('INSERT INTO profiles')
        expect(sql).toContain("VALUES (?, ?, ?, 'UTC', 1, 1, ?, ?)")
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { success: true }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await ensureProfile(db, {
      id: 'USER123456789',
      email: 'eve@example.com',
      name: 'Eve',
      image: null
    })

    expect(bindings[0]).toEqual([
      'USER123456789',
      'eve-user1234',
      'Eve',
      expect.any(String),
      expect.any(String)
    ])
  })
})
