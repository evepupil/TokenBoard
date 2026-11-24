export const maxUsageTimezoneLength = 80

const timezoneCache = new Map<string, boolean>()

export function isValidTimezone(value: string): boolean {
  const timezone = value.trim()
  if (!timezone || timezone !== value || timezone.length > maxUsageTimezoneLength) {
    return false
  }

  const cacheKey = timezone.toLowerCase()
  const cached = timezoneCache.get(cacheKey)
  if (cached !== undefined) return cached

  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone
    timezoneCache.set(cacheKey, true)
    if (resolved) timezoneCache.set(resolved.toLowerCase(), true)
    return true
  } catch {
    timezoneCache.set(cacheKey, false)
    return false
  }
}
