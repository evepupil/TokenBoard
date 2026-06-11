export type UnknownRecord = Record<string, unknown>

export function readTimestamp(record: UnknownRecord) {
  const value = readString(record, ['timestamp', 'createdAt', 'created_at'])
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function readOptionalNumber(record: UnknownRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

export function readNumber(record: UnknownRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

export function readString(record: UnknownRecord | null | undefined, keys: string[]) {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

export function readRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

export function formatDate(date: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Invalid timezone for session JSONL formatDate: ${timezone}`)
    }
    throw error
  }
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  )
  return `${values.year}-${values.month}-${values.day}`
}
