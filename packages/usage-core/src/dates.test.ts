import { describe, expect, test } from 'vitest'
import { assertIsoDate, isValidIsoDate } from './dates'

describe('ISO calendar dates', () => {
  test.each(['2024-02-29', '0000-01-01', '9999-12-31'])('accepts valid date %s', (value) => {
    expect(isValidIsoDate(value)).toBe(true)
    expect(() => assertIsoDate(value)).not.toThrow()
  })

  test.each(['2023-02-29', '2026-02-30', '2026-04-31', '2026-1-01', 'not-a-date'])(
    'rejects invalid date %s',
    (value) => {
      expect(isValidIsoDate(value)).toBe(false)
      expect(() => assertIsoDate(value)).toThrow(`Invalid ISO date: ${value}`)
    }
  )
})
