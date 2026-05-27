import { describe, expect, test } from 'vitest'
import {
  defaultTimezone,
  isValidTimezone,
  normalizeTimezone,
  parseTimezone,
  readTimezoneCookie,
  timezoneCookieName
} from './timezone'

describe('timezone helpers', () => {
  test('accepts valid IANA timezone values', () => {
    expect(parseTimezone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(parseTimezone(' UTC ')).toBe('UTC')
    expect(isValidTimezone('America/Los_Angeles')).toBe(true)
  })

  test('rejects invalid timezone values', () => {
    expect(parseTimezone('Mars/Base')).toBeNull()
    expect(parseTimezone('')).toBeNull()
    expect(isValidTimezone('Not/AZone')).toBe(false)
  })

  test('normalizes missing or invalid values to UTC', () => {
    expect(normalizeTimezone(undefined)).toBe(defaultTimezone)
    expect(normalizeTimezone('Mars/Base')).toBe(defaultTimezone)
  })

  test('reads the detected browser timezone cookie', () => {
    const cookie = `theme=dark; ${timezoneCookieName}=Asia%2FShanghai`

    expect(readTimezoneCookie(cookie)).toBe('Asia/Shanghai')
    expect(readTimezoneCookie(`${timezoneCookieName}=Mars%2FBase`)).toBeNull()
  })
})
