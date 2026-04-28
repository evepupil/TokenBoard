import { describe, expect, test } from 'vitest'
import { verifyUploadToken } from './middleware'

describe('verifyUploadToken', () => {
  test('returns the seed user for a bearer token matching the configured hash', async () => {
    const user = await verifyUploadToken(
      {
        SEED_USER_ID: 'seed-user',
        SEED_UPLOAD_TOKEN_SHA256:
          'ce64707c5082e6eaa8d41bf755f6948a4ddbbc4e8455616fd080d9249e24f4b0'
      },
      'Bearer dev-upload-token'
    )

    expect(user).toEqual({ id: 'seed-user' })
  })

  test('rejects a bearer token that does not match the configured hash', async () => {
    await expect(
      verifyUploadToken(
        {
          SEED_USER_ID: 'seed-user',
          SEED_UPLOAD_TOKEN_SHA256:
            'ce64707c5082e6eaa8d41bf755f6948a4ddbbc4e8455616fd080d9249e24f4b0'
        },
        'Bearer wrong-token'
      )
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401
    })
  })

  test('returns token owner from upload_tokens when bearer token is stored in D1', async () => {
    const user = await verifyUploadToken(
      {
        SEED_USER_ID: 'seed-user',
        SEED_UPLOAD_TOKEN_SHA256: 'seed-hash',
        DB: {
          prepare(sql: string) {
            expect(sql).toContain('FROM upload_tokens')
            return {
              bind(value: string) {
                expect(value).toBe('hash:tb_upload_secret')
                return {
                  async first() {
                    return { userId: 'paired-user' }
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

    expect(user).toEqual({ id: 'paired-user' })
  })
})
