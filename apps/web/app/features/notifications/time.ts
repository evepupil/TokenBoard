export const defaultWebhookScheduleTime = '18:00'
export const defaultWebhookScheduleWeekdays = [0, 1, 2, 3, 4, 5, 6]

const scheduleTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/

export function localDateInTimezone(date: Date, timezone: string) {
  const parts = localDateTimeParts(date, timezone)
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

export function localTimeInTimezone(date: Date, timezone: string) {
  const parts = localDateTimeParts(date, timezone)
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`
}

export function nextScheduledRunAt(input: {
  now: Date
  timezone: string
  scheduleTimeLocal?: string
  scheduleTimesLocal?: string[]
  scheduleWeekdays?: number[]
}) {
  const localDate = localDateInTimezone(input.now, input.timezone)
  const scheduleTimes = normalizeScheduleTimes(input.scheduleTimesLocal ?? input.scheduleTimeLocal)
  const scheduleWeekdays = normalizeScheduleWeekdays(input.scheduleWeekdays)

  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const candidateDate = addIsoDays(localDate, dayOffset)
    if (!scheduleWeekdays.includes(localWeekday(candidateDate))) continue
    for (const scheduleTime of scheduleTimes) {
      const candidate = zonedTimeToUtc(candidateDate, scheduleTime, input.timezone)
      if (candidate > input.now) return candidate.toISOString()
    }
  }

  return zonedTimeToUtc(addIsoDays(localDate, 8), scheduleTimes[0], input.timezone).toISOString()
}

export function normalizeScheduleTimes(input: unknown): string[] {
  const values = flattenScheduleValues(input)
  const candidates = values.length > 0 ? values : [defaultWebhookScheduleTime]
  const normalized = [...new Set(candidates.map((value) => value.trim()).filter(Boolean))]

  if (normalized.length < 1 || normalized.some((value) => !scheduleTimePattern.test(value))) {
    throw new Error('Invalid schedule time')
  }

  return normalized.sort()
}

export function normalizeScheduleWeekdays(input: unknown): number[] {
  const values = flattenScheduleValues(input)
  const candidates = values.length > 0 ? values : defaultWebhookScheduleWeekdays.map(String)
  const normalized = [...new Set(candidates.map(parseWeekday))]

  if (normalized.length < 1 || normalized.some((value) => !Number.isInteger(value) || value < 0 || value > 6)) {
    throw new Error('Invalid schedule weekday')
  }

  return normalized.sort((left, right) => left - right)
}

export function zonedTimeToUtc(localDate: string, time: string, timezone: string) {
  const [year, month, day] = localDate.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const targetLocalAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0)
  let utc = targetLocalAsUtc

  for (let index = 0; index < 3; index += 1) {
    const parts = localDateTimeParts(new Date(utc), timezone)
    const currentLocalAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    )
    utc += targetLocalAsUtc - currentLocalAsUtc
  }

  return new Date(utc)
}

export function addIsoDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function localDateTimeParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)

  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second')
  }
}

function flattenScheduleValues(input: unknown): string[] {
  if (Array.isArray(input)) return input.flatMap(flattenScheduleValues)
  if (input === null || input === undefined) return []
  return String(input)
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function localWeekday(localDate: string) {
  return new Date(`${localDate}T00:00:00.000Z`).getUTCDay()
}

function parseWeekday(value: string) {
  if (!/^[0-6]$/.test(value)) return Number.NaN
  return Number(value)
}

function pad2(value: number) {
  return String(value).padStart(2, '0')
}
