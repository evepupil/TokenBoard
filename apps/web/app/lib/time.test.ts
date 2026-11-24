import { describe, expect, test } from 'vitest'
import { localClockTime, localIsoDate, localShortDateTime, timezoneOffsetLabel } from './time'

describe('local calendar helpers', () => {
  test('reads the local date across the day boundary', () => {
    const instant = new Date('2026-04-30T18:00:00.000Z')
    expect(localIsoDate(instant, 'Asia/Shanghai')).toBe('2026-05-01')
    expect(localIsoDate(instant, 'America/Los_Angeles')).toBe('2026-04-30')
  })

  test('reads the local clock in 24-hour form', () => {
    expect(localClockTime(new Date('2026-04-30T18:05:00.000Z'), 'Asia/Shanghai')).toBe('02:05')
  })
})

describe('localShortDateTime', () => {
  // The README card's freshness stamp. It has to read in the *owner's* zone, so the
  // conversions below are the actual contract: a wrong offset would stamp a plausible but
  // wrong time, which is the failure mode the stamp exists to prevent.
  test('formats in the supplied zone, not UTC', () => {
    expect(localShortDateTime('2026-11-24T01:28:28.000Z', 'Asia/Shanghai')).toBe('11-24 09:28')
    expect(localShortDateTime('2026-11-24T01:28:28.000Z', 'UTC')).toBe('11-24 01:28')
  })

  test('handles fractional offsets and midnight', () => {
    expect(localShortDateTime('2026-11-23T18:30:00.000Z', 'Asia/Kolkata')).toBe('11-24 00:00')
    expect(localShortDateTime('2026-11-23T18:30:00.000Z', 'Pacific/Chatham')).toBe('11-24 08:15')
  })

  // Unparseable or absent stamps must yield null so the renderer draws nothing, rather
  // than a fabricated time. `new Date` accepts a lot of near-misses, so this also pins the
  // exact failure cases the callers rely on.
  test('returns null for missing or unparseable stamps', () => {
    expect(localShortDateTime(null, 'Asia/Shanghai')).toBeNull()
    expect(localShortDateTime(undefined, 'Asia/Shanghai')).toBeNull()
    expect(localShortDateTime('', 'Asia/Shanghai')).toBeNull()
    expect(localShortDateTime('not-a-date', 'Asia/Shanghai')).toBeNull()
  })
})

describe('timezoneOffsetLabel', () => {
  // A user who sets a timezone by hand reads a name they recognise; a viewer comparing two
  // people's boards needs the numeric offset, because the names do not say how far apart the
  // two days are. The label carries both so neither has to guess.
  test('labels a whole-hour offset', () => {
    expect(timezoneOffsetLabel('Asia/Shanghai', new Date('2026-09-25T12:00:00.000Z'))).toBe('UTC+8')
  })

  test('labels a half-hour and a quarter-hour offset', () => {
    expect(timezoneOffsetLabel('Asia/Kolkata', new Date('2026-09-25T12:00:00.000Z'))).toBe('UTC+5:30')
    expect(timezoneOffsetLabel('Pacific/Chatham', new Date('2026-09-25T12:00:00.000Z'))).toBe('UTC+12:45')
  })

  test('labels a negative offset and UTC itself', () => {
    expect(timezoneOffsetLabel('America/Los_Angeles', new Date('2026-09-25T12:00:00.000Z'))).toBe('UTC-7')
    expect(timezoneOffsetLabel('UTC', new Date('2026-09-25T12:00:00.000Z'))).toBe('UTC+0')
  })

  // The offset is a property of the instant, not of the zone: the same zone reads +8 in
  // January and +9 in July. A label computed once and cached would be wrong for half the year.
  test('follows daylight saving at the instant it is asked about', () => {
    expect(timezoneOffsetLabel('America/Los_Angeles', new Date('2026-01-15T12:00:00.000Z'))).toBe('UTC-8')
    expect(timezoneOffsetLabel('America/Los_Angeles', new Date('2026-07-15T12:00:00.000Z'))).toBe('UTC-7')
  })
})
