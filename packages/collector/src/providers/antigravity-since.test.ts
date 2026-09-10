import { describe, expect, test } from 'vitest'
import { isReusableAntigravityHistoryScope, resolveAntigravityCollectionRange } from './antigravity-since'

describe('resolveAntigravityCollectionRange', () => {
  test.each(['20260624', '2026-06-24'])('accepts supported since date format %s', (since) => {
    expect(resolveAntigravityCollectionRange({ since, timezone: 'UTC' })).toMatchObject({
      sinceDate: '2026-06-24',
      historyScope: '2026-06-24@UTC'
    })
  })

  test.each(['20260230', '2026-02-30', '2026--06-24', '2026/06/24'])(
    'rejects invalid since date %s instead of normalizing it',
    (since) => {
      expect(() => resolveAntigravityCollectionRange({ since, timezone: 'UTC' })).toThrow(
        `Invalid Antigravity since date: ${since}`
      )
    }
  )

  test('uses the default since window when the primary environment value is empty', () => {
    expect(
      resolveAntigravityCollectionRange({
        timezone: 'UTC',
        env: {
          TOKENBOARD_SINCE: '',
          TOKENBOARD_DEFAULT_SINCE: '20260501'
        }
      })
    ).toMatchObject({
      sinceDate: '2026-05-01',
      historyScope: '2026-05-01@UTC'
    })
  })

  test('distinguishes bounded empty configuration from explicit full history', () => {
    const bounded = resolveAntigravityCollectionRange({
      since: '',
      timezone: 'UTC',
      env: { TOKENBOARD_DEFAULT_SINCE: '20260501' }
    })
    const full = resolveAntigravityCollectionRange({ since: 'all', timezone: 'UTC' })

    expect(bounded.fullHistory).toBe(false)
    expect(full.fullHistory).toBe(true)
    expect(bounded.sinceDate).toBeUndefined()
    expect(full.sinceDate).toBeUndefined()
  })

  test('scopes bounded cursor state by timezone', () => {
    const utc = resolveAntigravityCollectionRange({ since: '20260624', timezone: 'UTC' })
    const shanghai = resolveAntigravityCollectionRange({ since: '20260624', timezone: 'Asia/Shanghai' })

    expect(utc.historyScope).not.toBe(shanghai.historyScope)
    expect(isReusableAntigravityHistoryScope(utc.historyScope, shanghai.historyScope)).toBe(false)
  })
})
