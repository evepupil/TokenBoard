import { renderToString } from 'hono/jsx/dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getOptionalUser } from '../../../features/auth/middleware'
import { getDailyReportHistoryById } from '../../../features/notifications/report-share'
import { GET } from './[id]'

vi.mock('../../../features/auth/middleware', () => ({
  getOptionalUser: vi.fn()
}))

vi.mock('../../../features/notifications/report-share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../features/notifications/report-share')>()
  return {
    ...actual,
    getDailyReportHistoryById: vi.fn()
  }
})

const mockedGetDailyReportHistoryById = vi.mocked(getDailyReportHistoryById)
const mockedGetOptionalUser = vi.mocked(getOptionalUser)

describe('daily report share route', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-30T00:00:00.000Z'))
    mockedGetDailyReportHistoryById.mockReset()
    mockedGetOptionalUser.mockReset()
    mockedGetOptionalUser.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('renders a shared daily report without requiring login', async () => {
    mockedGetDailyReportHistoryById.mockResolvedValue(reportItem() as never)
    const context = pageContext('drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

    const response = await GET[0](context as never, async () => undefined) as Response
    const html = await response.text()

    expect(mockedGetDailyReportHistoryById).toHaveBeenCalledWith({
      db: context.env.DB,
      id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      viewerUserId: null,
      retentionDays: 30,
      now: new Date('2026-04-30T00:00:00.000Z')
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(html).toContain('Example token 日报')
    expect(html).toContain('2026-04-29')
    expect(html).toContain('1,200')
    expect(html).toContain('900')
    expect(html).toContain('$1.23')
    expect(html).toContain('Codex')
    expect(html).toContain('gpt-5')
    expect(html).not.toContain('退出登录')
  })

  test('returns 404 when a shared daily report id is missing', async () => {
    mockedGetDailyReportHistoryById.mockResolvedValue(null)
    const response = await GET[0](pageContext('drr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') as never, async () => undefined) as Response

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(await response.text()).toContain('日报不存在')
  })

  test('renders test preview report links with a user-facing schedule label', async () => {
    mockedGetDailyReportHistoryById.mockResolvedValue(reportItem({ scheduleSlot: 'test-preview' }) as never)
    const response = await GET[0](pageContext('drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') as never, async () => undefined) as Response
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('测试预览')
    expect(html).not.toContain('test-preview')
  })

  test('returns 404 for invalid report ids without touching auth or the database', async () => {
    const response = await GET[0](pageContext('bad id') as never, async () => undefined) as Response

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(await response.text()).toContain('日报不存在')
    expect(mockedGetOptionalUser).not.toHaveBeenCalled()
    expect(mockedGetDailyReportHistoryById).not.toHaveBeenCalled()
  })

  test('passes the logged-in viewer id so owners can view private report links', async () => {
    mockedGetOptionalUser.mockResolvedValue({
      id: 'user_1',
      email: 'user@example.com',
      name: 'Example',
      image: null
    })
    mockedGetDailyReportHistoryById.mockResolvedValue(reportItem() as never)
    const context = pageContext('drr_cccccccccccccccccccccccccccccccc', 'better-auth-session_token=abc')

    const response = await GET[0](context as never, async () => undefined) as Response
    const html = await response.text()

    expect(mockedGetDailyReportHistoryById).toHaveBeenCalledWith({
      db: context.env.DB,
      id: 'drr_cccccccccccccccccccccccccccccccc',
      viewerUserId: 'user_1',
      retentionDays: 30,
      now: new Date('2026-04-30T00:00:00.000Z')
    })
    expect(html).toContain('user@example.com')
    expect(html).toContain('退出登录')
  })

  test('passes the configured report history retention window', async () => {
    mockedGetDailyReportHistoryById.mockResolvedValue(reportItem() as never)
    const context = pageContext('drr_dddddddddddddddddddddddddddddddd', undefined, {
      TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7'
    })

    await GET[0](context as never, async () => undefined)

    expect(mockedGetDailyReportHistoryById).toHaveBeenCalledWith({
      db: context.env.DB,
      id: 'drr_dddddddddddddddddddddddddddddddd',
      viewerUserId: null,
      retentionDays: 7,
      now: new Date('2026-04-30T00:00:00.000Z')
    })
  })

  test('keeps the logged-in nav when a private report id is not readable', async () => {
    mockedGetOptionalUser.mockResolvedValue({
      id: 'user_1',
      email: 'user@example.com',
      name: 'Example',
      image: null
    })
    mockedGetDailyReportHistoryById.mockResolvedValue(null)
    const context = pageContext('drr_cccccccccccccccccccccccccccccccc', 'better-auth-session_token=abc')

    const response = await GET[0](context as never, async () => undefined) as Response
    const html = await response.text()

    expect(response.status).toBe(404)
    expect(html).toContain('user@example.com')
    expect(html).toContain('退出登录')
  })
})

function pageContext(id: string, cookie?: string, env?: Record<string, unknown>) {
  let statusCode = 200
  const headers = new Headers()
  return {
    env: { DB: {}, ...env },
    req: {
      param: vi.fn(() => ({ id })),
      header: vi.fn((name: string) => (name === 'cookie' ? cookie ?? null : null)),
      raw: new Request('https://tokenboard.example/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        headers: cookie ? { cookie } : {}
      })
    },
    header: vi.fn((name: string, value: string) => {
      headers.set(name, value)
    }),
    status: vi.fn((status: number) => {
      statusCode = status
    }),
    render: async (body: unknown) => (
      new Response(await renderToString(body as never), { status: statusCode, headers })
    )
  }
}

function reportItem(overrides: Partial<ReturnType<typeof reportItemBase>> = {}) {
  return { ...reportItemBase(), ...overrides }
}

function reportItemBase() {
  return {
    id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    displayName: 'Example',
    reportDate: '2026-04-29',
    scheduleSlot: '2026-04-29T18:00',
    timezone: 'Asia/Shanghai',
    dashboardUrl: 'https://tokenboard.example.com/dashboard',
    totalTokens: 1200,
    totalTokensWithoutCacheRead: 900,
    cacheReadRate: 0.25,
    costUsd: 1.23,
    sessionCount: 4,
    reportUrl: '/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shareRevokedAt: null,
    sourceSplit: [
      {
        source: 'codex',
        totalTokens: 1200,
        totalTokensWithoutCacheRead: 900,
        cacheReadRate: 0.25
      }
    ],
    topModels: [
      {
        model: 'gpt-5',
        totalTokens: 1200,
        totalTokensWithoutCacheRead: 900,
        cacheReadRate: 0.25,
        costUsd: 1.23
      }
    ],
    generatedAt: '2026-04-29T10:00:00.000Z',
    updatedAt: '2026-04-29T10:00:00.000Z'
  }
}
