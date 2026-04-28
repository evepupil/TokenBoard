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
})

