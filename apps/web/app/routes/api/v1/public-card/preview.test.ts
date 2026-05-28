import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requireSessionUser } from '../../../../features/auth/middleware'
import { POST } from './preview'

vi.mock('../../../../features/auth/middleware', () => ({
  requireSessionUser: vi.fn()
}))

const mockedRequireSessionUser = vi.mocked(requireSessionUser)

describe('public card preview route', () => {
  beforeEach(() => {
    mockedRequireSessionUser.mockReset()
  })

  test('renders an authenticated no-store SVG preview without profile writes', async () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('DB should not be queried')
      })
    }
    const context = {
      env: { DB: db },
      req: {
        json: vi.fn(async () => ({
          displayName: 'Preview <User>',
          publicUrl: 'https://tokenboard.example/api/public/preview.svg',
          config: {
            language: 'en',
            theme: 'light',
            title: 'Usage <script>',
            subtitle: 'Public "preview"',
            metrics: ['todayTokens', 'todayCost']
          }
        }))
      }
    }

    mockedRequireSessionUser.mockResolvedValue({ id: 'user_1' } as never)

    const response = await POST[0](context as never, async () => undefined) as Response
    const svg = await response.text()

    expect(mockedRequireSessionUser).toHaveBeenCalledWith(context)
    expect(db.prepare).not.toHaveBeenCalled()
    expect(response.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(svg).toContain('Today Tokens')
    expect(svg).toContain('Usage &lt;script&gt;')
    expect(svg).toContain('Public &quot;preview&quot;')
    expect(svg).not.toContain('<script>')
  })
})
