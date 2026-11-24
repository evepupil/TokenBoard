// The timezone check without the schema layer. `schema.ts` builds its Zod schemas on top of
// this, but it also imports zod, and zod instantiates its JIT object validators at module
// scope — which probes `Function("")` and violates a CSP without `unsafe-eval`. The web
// client needs only this check (browser timezone autofill), so it must be importable
// without dragging zod — and that eval probe — into the client bundle. Exposed as
// `@tokenboard/usage-core/timezone`; keep it free of any zod import.
export const maxUsageTimezoneLength = 80

const validTimezoneCache = new Set<string>()

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false

  const timezone = value.trim()
  if (!timezone || timezone !== value || timezone.length > maxUsageTimezoneLength) return false
  const cacheKey = timezone.toLowerCase()
  if (validTimezoneCache.has(cacheKey)) return true

  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    formatter.format(new Date(0))
    validTimezoneCache.add(cacheKey)
    validTimezoneCache.add(formatter.resolvedOptions().timeZone.toLowerCase())
    return true
  } catch (_) {
    return false
  }
}

export function timezoneValidationCacheSize() {
  return validTimezoneCache.size
}
