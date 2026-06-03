import { describe, expect, test } from 'vitest'
import {
  localDateInTimezone,
  nextScheduledRunAt,
  normalizeScheduleTimes,
  normalizeScheduleWeekdays,
  zonedTimeToUtc
} from './time'

describe('notification time helpers', () => {
  test('reads local date in the configured timezone', () => {
    expect(localDateInTimezone(new Date('2026-04-28T16:30:00.000Z'), 'Asia/Shanghai')).toBe('2026-04-29')
  })

  test('converts local scheduled time to UTC', () => {
    expect(zonedTimeToUtc('2026-04-29', '09:30', 'Asia/Shanghai').toISOString()).toBe('2026-04-29T01:30:00.000Z')
  })

  test('moves next run to tomorrow after the configured local time has passed', () => {
    expect(nextScheduledRunAt({
      now: new Date('2026-04-29T02:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      scheduleTimeLocal: '09:30'
    })).toBe('2026-04-30T01:30:00.000Z')
  })

  test('defaults missing schedule to 18:00 local time', () => {
    expect(nextScheduledRunAt({
      now: new Date('2026-04-29T08:00:00.000Z'),
      timezone: 'Asia/Shanghai'
    })).toBe('2026-04-29T10:00:00.000Z')
  })

  test('selects the next same-day local time from multiple schedule slots', () => {
    expect(nextScheduledRunAt({
      now: new Date('2026-04-29T02:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      scheduleTimesLocal: ['09:30', '18:00']
    })).toBe('2026-04-29T10:00:00.000Z')
  })

  test('skips to the next selected local weekday', () => {
    expect(nextScheduledRunAt({
      now: new Date('2026-04-29T02:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      scheduleTimesLocal: ['09:30'],
      scheduleWeekdays: [5]
    })).toBe('2026-05-01T01:30:00.000Z')
  })

  test('normalizes comma separated schedule settings', () => {
    expect(normalizeScheduleTimes('18:00,09:30\n18:00')).toEqual(['09:30', '18:00'])
    expect(normalizeScheduleWeekdays(['5', '1', '5'])).toEqual([1, 5])
  })

  test('rejects out-of-range schedule weekdays', () => {
    expect(() => normalizeScheduleWeekdays(['1', '7'])).toThrow('Invalid schedule weekday')
  })
})
