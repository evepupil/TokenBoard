import { describe, expect, test, vi } from 'vitest'
import { securityHeaders } from '../../lib/security-headers'
import { forwardGithubSignIn } from './service'

// `postAuth` re-issues the request to Better Auth; the handoff itself is covered in
// service.test.ts. Here the only thing that matters is where the sign-in redirect points.
vi.mock('./auth', () => ({
  authBasePath: '/api/auth',
  createAuth: () => ({
    handler: async () =>
      new Response(JSON.stringify({ url: 'https://github.com/login/oauth/authorize?client_id=x&state=y' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  })
}))

// Chrome and Safari apply `form-action` to the redirect target of a form submission. The
// sign-in form and the OAuth handoff live in different files, and the failure is silent:
// the browser blocks the redirect and the user is left on the button's submitting label.
// This compares the two ends directly, so a provider change or a policy edit that breaks
// sign-in fails here rather than in production. It shipped broken once (2026-11-24) with
// both sides individually tested but never against each other.
describe('sign-in redirect vs CSP form-action', () => {
  test('the OAuth redirect origin is allowed by form-action', async () => {
    const url = 'https://example.test/auth/sign-in'
    const context = {
      env: {},
      req: {
        url,
        raw: new Request(url, { method: 'POST', headers: {} }),
        header: () => undefined
      },
      redirect: (location: string, status: number) => new Response(null, { status, headers: { location } })
    }

    const response = await forwardGithubSignIn(context as never)
    expect(response.status).toBe(303)
    const location = response.headers.get('location')
    expect(location).toBeTruthy()
    const redirectOrigin = new URL(location!).origin

    const csp = (await securityHeaders())['Content-Security-Policy']
    const formAction = csp
      .split('; ')
      .find((directive) => directive.startsWith('form-action '))
      ?.split(' ')
      .slice(1)
    expect(formAction).toBeDefined()

    const allowed = formAction!.some((source) =>
      source === "'self'"
        ? redirectOrigin === new URL(url).origin
        : source.startsWith('http') && new URL(source).origin === redirectOrigin
    )
    expect(allowed, `form-action (${formAction!.join(' ')}) does not allow ${redirectOrigin}`).toBe(true)
  })
})
