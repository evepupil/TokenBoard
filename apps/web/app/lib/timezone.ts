export const defaultTimezone = 'UTC'
export const timezoneCookieName = 'tokenboard-timezone'

export function parseTimezone(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const timezone = value.trim()
  if (!isValidTimezone(timezone)) return null

  return timezone
}

export function normalizeTimezone(value: unknown, fallback = defaultTimezone): string {
  return parseTimezone(value) ?? parseTimezone(fallback) ?? defaultTimezone
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false

  const timezone = value.trim()
  if (!timezone || timezone.length > 80) return false

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0))
    return true
  } catch (_) {
    return false
  }
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
