import { isValidTimezone as isUsageTimezone } from '@tokenboard/usage-core'

export { isUsageTimezone as isValidTimezone }

export const defaultTimezone = 'UTC'
export const timezoneCookieName = 'tokenboard-timezone'

export function parseTimezone(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const timezone = value.trim()
  if (!isUsageTimezone(timezone)) return null

  return timezone
}

export function normalizeTimezone(value: unknown, fallback = defaultTimezone): string {
  return parseTimezone(value) ?? parseTimezone(fallback) ?? defaultTimezone
}

export function readTimezoneCookie(cookieHeader: string | null | undefined): string | null {
  const rawValue = readCookie(cookieHeader, timezoneCookieName)
  return parseTimezone(rawValue)
}

function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null

  for (const item of cookieHeader.split(';')) {
    const [rawName, ...rawValueParts] = item.split('=')
    if (rawName.trim() !== name) continue

    try {
      return decodeURIComponent(rawValueParts.join('=').trim())
    } catch (_) {
      return null
    }
  }

  return null
}
