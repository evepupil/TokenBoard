import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createAuth } from './auth'
import { requireSessionUser } from './middleware'

vi.mock('./auth', () => ({
  createAuth: vi.fn()
}))

const mockedCreateAuth = vi.mocked(createAuth)

describe('requireSessionUser', () => {
  beforeEach(() => {
    mockedCreateAuth.mockReset()
  })

  test('authenticates without writing a profile', async () => {
    mockedCreateAuth.mockReturnValue({
      api: {
        getSession: vi.fn(async () => ({
          user: {
            id: 'user_12345678',
            email: 'user@example.com',
            name: 'Token User',
            image: null
          }
        }))
      }
    } as never)

    const raw = new Request('https://tokenboard.example/api/v1/public-card/preview', {
      headers: {
        cookie: 'better-auth-session_token=abc; tokenboard-timezone=Asia%2FShanghai'
      }
    })

    const user = await requireSessionUser({
      env: {
        DB: {
          prepare() {
            throw new Error('DB should not be queried')
          }
        }
      },
      req: {
        header(name: string) {
          expect(name).toBe('cookie')
          return raw.headers.get('cookie')
        },
        raw
      }
    } as never)

    expect(user.id).toBe('user_12345678')
  })
})
