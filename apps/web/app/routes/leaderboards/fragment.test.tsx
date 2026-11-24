import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getOptionalUser } from '../../features/auth/middleware'
import { getProfileTimezoneSettings } from '../../features/settings/service'
import { getLeaderboard } from '../../features/leaderboards/service'
import { GET } from './fragment'

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

// The fragment replaces the panel the full page rendered, so the two must rank the same day.
// They did not: the page read the signed-in user's stored profile zone while this route always
// read the browser cookie, so a user who had set their zone by hand saw one day's board on load
// and a different day's the moment they clicked a tab. Same user, same instant, two boards.
describe('leaderboard fragment route', () => {
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

  test('resolves the signed-in user profile zone rather than the cookie zone', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedTimezone.mockResolvedValue({ timezone: 'Asia/Shanghai' } as never)

    await GET[0](context('tokenboard-timezone=America%2FLos_Angeles') as never, async () => undefined)

    // The cookie says Los Angeles; the stored profile says Shanghai. The dashboard and public
    // card both report in the stored zone, so the board has to as well.
    expect(mockedGetLeaderboard.mock.calls[0][4]).toBe('Asia/Shanghai')
  })

  test('falls back to the cookie zone for an anonymous viewer', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    await GET[0](context('tokenboard-timezone=America%2FLos_Angeles') as never, async () => undefined)

    expect(mockedGetLeaderboard.mock.calls[0][4]).toBe('America/Los_Angeles')
  })

  // The rendered board depends on the viewer's zone, so a shared browser cache must not
  // replay one viewer's day to the next person.
  test('does not let the fragment be cached', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = (await GET[0](context('') as never, async () => undefined)) as Response

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  // The panel marks the viewer's own row, so the fragment must resolve the highlight from the
  // same session read the full page used. Reading it from the cookie would drop the marker the
  // moment a signed-in user clicked a tab, and the page and the fragment would disagree about
  // the same board.
  test('passes the signed-in viewer so their own row stays marked after a tab click', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedTimezone.mockResolvedValue({ timezone: 'Asia/Shanghai' } as never)

    await GET[0](context('') as never, async () => undefined)

    expect(mockedGetLeaderboard.mock.calls[0][1]).toMatchObject({ viewerUserId: 'user_1' })
  })

  test('passes no viewer for an anonymous visitor', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    await GET[0](context('') as never, async () => undefined)

    expect(mockedGetLeaderboard.mock.calls[0][1]).toMatchObject({ viewerUserId: null })
  })

  // The fragment rebuilds the same board the page does, so it is the same anonymous read
  // amplifier and must carry the same ceiling; without it the tab click is the way around the
  // page's cap. The ceiling has to fire before the board is built.
  test('rate-limits the leaderboard fragment', async () => {
    const response = (await GET[0](context('', 121) as never, async () => undefined)) as Response

    expect(response.status).toBe(429)
    expect(mockedGetLeaderboard).not.toHaveBeenCalled()
  })
})

function context(cookie: string, rateLimitCount = 1) {
  const request = new Request('https://tokenboard.example/leaderboards/fragment?period=daily')
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
    html: (body: unknown, status = 200) => new Response(String(body), { status, headers }),
    json: (body: unknown, status = 200) => Response.json(body, { status })
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
