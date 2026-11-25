import { renderToString } from 'hono/jsx/dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getOptionalUser } from '../../features/auth/middleware'
import { forwardGithubSignIn } from '../../features/auth/service'
import { GET, POST } from './sign-in'

vi.mock('../../features/auth/middleware', () => ({
  getOptionalUser: vi.fn()
}))

vi.mock('../../features/auth/service', () => ({
  forwardGithubSignIn: vi.fn()
}))

const mockedGetOptionalUser = vi.mocked(getOptionalUser)
const mockedForwardGithubSignIn = vi.mocked(forwardGithubSignIn)

describe('sign-in route', () => {
  beforeEach(() => {
    mockedGetOptionalUser.mockReset()
    mockedForwardGithubSignIn.mockReset()
  })

  test('redirects authenticated users to the dashboard', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)

    const response = (await GET[0](signInContext() as never, async () => undefined)) as Response

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/dashboard')
  })

  // The form is anonymous-only — a signed-in visitor is redirected — so a shared browser cache
  // must not replay either branch to the next person.
  test('does not let the page be cached', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = (await GET[0](signInContext() as never, async () => undefined)) as Response

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  test('marks the login card as the nav login focus target', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = (await GET[0](signInContext() as never, async () => undefined)) as Response
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('data-login-focus="true"')
    expect(html).toContain('data-login-card="true"')
    expect(html).toContain('data-login-primary="true"')
    expect(html).toContain('app-login-card')
  })

  test('keeps the sign-in action ahead of explanatory content on narrow screens', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = (await GET[0](signInContext() as never, async () => undefined)) as Response
    const html = await response.text()

    expect(html).toContain('order-2 min-w-0 lg:order-1')
    expect(html).toContain('app-login-card order-1')
    expect(html).toContain('data-auth-benefits="true"')
    expect(html).toContain('不上传对话正文')
    expect(html).toContain('每台设备使用独立上传令牌')
  })

  test('keeps compound names intact in the narrowest login layout', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = (await GET[0](signInContext() as never, async () => undefined)) as Response
    const html = await response.text()

    expect(html).toContain('whitespace-nowrap">AI token</span>')
    expect(html).toContain('max-[359px]:flex-col')
  })

  test('keeps the GitHub auth failure message visible', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = (await GET[0](signInContext({ error: 'github' }) as never, async () => undefined)) as Response
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('role="alert"')
    expect(html).toContain('GitHub 登录失败。请检查 OAuth 配置后重试。')
  })

  // The button is a form submit, not a link. Better Auth exposes social sign-in only as
  // `POST /api/auth/sign-in/social`; there is no `/api/auth/github` route, so an anchor
  // there lands on the app's 404 JSON page and the OAuth flow never starts. This shipped
  // broken once (2026-11-25) when a UI refactor replaced the form with a link.
  test('starts GitHub sign-in through a form POST to this route', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = (await GET[0](signInContext() as never, async () => undefined)) as Response
    const html = await response.text()

    expect(html).toContain('<form method="post"')
    expect(html).toContain('data-submit-feedback="true"')
    expect(html).toContain('data-login-primary="true"')
    expect(html).not.toContain('href="/api/auth/github"')
  })

  test('forwards the sign-in form submission to Better Auth', async () => {
    const redirected = new Response(null, { status: 303, headers: { location: 'https://github.com/' } })
    mockedForwardGithubSignIn.mockResolvedValue(redirected as never)
    const context = signInContext()

    const response = await POST[0](context as never, async () => undefined)

    expect(mockedForwardGithubSignIn).toHaveBeenCalledWith(context)
    expect(response).toBe(redirected)
  })
})

function signInContext(query: Record<string, string | undefined> = {}) {
  const headers = new Headers()
  return {
    req: {
      query(name: string) {
        return query[name]
      }
    },
    header: (name: string, value: string) => {
      headers.set(name, value)
    },
    render: vi.fn(async (body: unknown) => new Response(await renderToString(body as never), { headers })),
    redirect: vi.fn((location: string, status = 302) => new Response(null, { status, headers: { location } }))
  }
}
