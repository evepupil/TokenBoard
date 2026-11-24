import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getOptionalUser } from '../../features/auth/middleware'
import { getProfileTimezoneSettings } from '../../features/settings/service'
import { getLeaderboard } from '../../features/leaderboards/service'
import { ApiError } from '../../lib/errors'
import route from './index'

vi.mock('../../features/auth/middleware', () => ({
  getOptionalUser: vi.fn()
}))

vi.mock('../../features/settings/service', () => ({
  getProfileTimezoneSettings: vi.fn()
}))

vi.mock('../../features/leaderboards/service', () => ({
  getLeaderboard: vi.fn()
}))

const mockedGetOptionalUser = vi.mocked(getOptionalUser)
const mockedTimezone = vi.mocked(getProfileTimezoneSettings)
const mockedGetLeaderboard = vi.mocked(getLeaderboard)

describe('leaderboard page route', () => {
  beforeEach(() => {
    mockedGetOptionalUser.mockReset()
    mockedTimezone.mockReset()
    mockedGetLeaderboard.mockReset()
    mockedGetLeaderboard.mockResolvedValue({
      entries: [],
      period: 'daily',
      metric: 'tokens',
      rangeLabel: '2026-05-01',
      timezone: 'Asia/Shanghai',
      timezoneLabel: 'UTC+8'
    } as never)
  })

  // The page and the fragment that replaces its panel are two routes answering the same
  // question, and they must answer it the same way. This asserts the page half of that
  // contract; the fragment's own test asserts the other half against the same helper.
  test('resolves the signed-in user profile zone rather than the cookie zone', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedTimezone.mockResolvedValue({ timezone: 'Asia/Shanghai' } as never)

    await route[0](context('tokenboard-timezone=America%2FLos_Angeles') as never, async () => undefined)

    expect(mockedGetLeaderboard.mock.calls[0][4]).toBe('Asia/Shanghai')
  })

  // A signed-in visitor can legitimately have no profile row: only `requireUser` creates one,
  // and this page is public. The lookup throws NOT_FOUND for that row, which used to surface as
  // a 404 on a page an anonymous visitor can read.
  test('renders for a signed-in visitor who has no profile row yet', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedTimezone.mockRejectedValue(
      new (await import('../../lib/errors')).ApiError('NOT_FOUND', 'Profile not found', 404)
    )

    const response = (await route[0](
      context('tokenboard-timezone=Asia%2FTokyo') as never,
      async () => undefined
    )) as Response

    expect(response.status).toBe(200)
    expect(mockedGetLeaderboard.mock.calls[0][4]).toBe('Asia/Tokyo')
  })

  // The nav renders the viewer's email, and this route reads the session with `getOptionalUser`
  // rather than `requireUser`, so it is outside the boundary that sets `no-store` for gated
  // pages. Without its own directive a browser could serve a cached copy to the next person.
  test('does not let the page be cached', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedTimezone.mockResolvedValue({ timezone: 'Asia/Shanghai' } as never)

    const response = (await route[0](context('') as never, async () => undefined)) as Response

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  // The panel marks the viewer's own row, and the id that decides it comes from the session
  // this route already read. The fragment that replaces the panel reads the same session the
  // same way; its test asserts the other half of that contract.
  test('passes the signed-in viewer to the board so their own row is marked', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedTimezone.mockResolvedValue({ timezone: 'Asia/Shanghai' } as never)

    await route[0](context('') as never, async () => undefined)

    expect(mockedGetLeaderboard.mock.calls[0][1]).toMatchObject({ viewerUserId: 'user_1' })
  })

  test('passes no viewer for an anonymous visitor', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    await route[0](context('') as never, async () => undefined)

    expect(mockedGetLeaderboard.mock.calls[0][1]).toMatchObject({ viewerUserId: null })
  })

  // The board aggregates the whole summary table and the page is `no-store`, so every anonymous
  // request reaches D1. Without a ceiling that makes the heaviest read on the site an unbounded
  // anonymous amplifier; the same 120/60s the other anonymous read paths use applies here, and
  // the ceiling has to fire before the board is built.
  test('rate-limits the public leaderboard page', async () => {
    const thrown = await route[0](context('', 121) as never, async () => undefined).then(
      () => null,
      (error: unknown) => error
    )

    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).status).toBe(429)
    expect(mockedGetLeaderboard).not.toHaveBeenCalled()
  })
})

function context(cookie: string, rateLimitCount = 1) {
  const request = new Request('https://tokenboard.example/leaderboards?period=daily')
  const headers = new Headers()
  return {
    env: { DB: createRateLimitDb(rateLimitCount) },
    req: {
      raw: request,
      url: request.url,
      query: (name: string) => new URL(request.url).searchParams.get(name),
      header: (name: string) => (name === 'cookie' ? cookie : undefined)
    },
    header: (name: string, value: string) => {
      headers.set(name, value)
    },
    render: async (body: unknown) => new Response(String(body), { status: 200, headers })
  }
}

// The route's read ceiling issues a `SELECT count` probe against `api_rate_limits`; reporting a
// count at or above the ceiling drives a request past it without a real D1.
function createRateLimitDb(rateLimitCount: number) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () =>
          sql.includes('api_rate_limits') ? { count: rateLimitCount, resetAt: '2099-01-01T00:00:00.000Z' } : null,
        run: async () => ({ meta: { changes: 1 } })
      })
    })
  }
}
