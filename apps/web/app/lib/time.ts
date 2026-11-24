export function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

/**
 * The calendar date `date` falls on in `timezone`.
 *
 * `toIsoDate` answers the same question for UTC. That is the wrong answer for anything the
 * collector wrote: `daily_usage.usage_date` is stamped in the user's own zone, so comparing it
 * against a UTC date reports the previous day for the whole evening in the Americas and the
 * wrong day for the first hours of every UTC+ offset. Three features — the dashboard, the
 * leaderboard and the public card — need the local answer, so it lives here rather than in any
 * one of them.
 */
export function localIsoDate(date: Date, timezone: string) {
  const parts = localDateTimeParts(date, timezone)
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

export function localClockTime(date: Date, timezone: string) {
  const parts = localDateTimeParts(date, timezone)
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`
}

export function localDateTimeParts(date: Date, timezone: string) {
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

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

/**
 * The offset `timezone` is at `date`, as `UTC+8` / `UTC-7` / `UTC+5:30`.
 *
 * The offset is read at the instant rather than derived from the zone's name, because a zone's
 * offset is not a constant: `America/Los_Angeles` is `UTC-8` in January and `UTC-7` in July. A
 * label computed once and reused would be wrong for half the year.
 */
export function timezoneOffsetLabel(timezone: string, date = new Date()) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset'
  })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value

  // `shortOffset` renders as `GMT+8`, `GMT-7`, `GMT+5:30` or `GMT` for zero. Anything else
  // means the runtime declined to answer, so the zone name is the honest fallback.
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(formatted ?? '')
  if (!match) return formatted === 'GMT' ? 'UTC+0' : timezone
  const [, sign, hours, minutes] = match
  return `UTC${sign}${Number(hours)}${minutes && minutes !== '00' ? `:${minutes}` : ''}`
}

/**
 * A compact `MM-DD HH:mm` label of `isoInstant` in `timezone`, for surfaces that
 * show a freshness stamp without room for a full timestamp.
 *
 * The caller supplies the zone deliberately: a card read from a README has to
 * stamp in the *owner's* clock, not the viewer's or the Worker's. Invalid inputs
 * yield null rather than a fabricated time — an unparseable stored stamp means
 * there is no honest instant to show.
 */
export function localShortDateTime(isoInstant: string | null | undefined, timezone: string): string | null {
  if (!isoInstant) return null
  const date = new Date(isoInstant)
  if (Number.isNaN(date.getTime())) return null
  const parts = localDateTimeParts(date, timezone)
  return `${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`
}
