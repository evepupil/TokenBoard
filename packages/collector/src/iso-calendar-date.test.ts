import { describe, expect, test } from 'vitest'
import { assertValidDateFilterRange } from './iso-calendar-date'

describe('date filter ranges', () => {
  test('recognizes a whitespace-padded all sentinel before comparing bounds', () => {
    expect(
      assertValidDateFilterRange({
        since: ' all ',
        until: '2026-09-05',
        sinceField: 'since',
        untilField: 'until'
      })
    ).toEqual({ since: undefined, until: '2026-09-05' })
  })

  test('still rejects whitespace-only since values', () => {
    expect(() =>
      assertValidDateFilterRange({
        since: '   ',
        sinceField: 'since',
        untilField: 'until'
      })
    ).toThrow('Invalid since')
  })
})
