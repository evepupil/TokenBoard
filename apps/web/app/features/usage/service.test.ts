import { describe, expect, test } from 'vitest'
import { parseUsageDetailsFilters } from './service'

describe('parseUsageDetailsFilters', () => {
  test('defaults to the last 30 days and all sources', () => {
    const filters = parseUsageDetailsFilters({}, new Date('2026-04-29T12:00:00.000Z'))

    expect(filters).toEqual({
      source: 'all',
      startDate: '2026-03-31',
      endDate: '2026-04-29'
    })
  })

  test('keeps valid date range and source filters', () => {
    const filters = parseUsageDetailsFilters(
      {
        source: 'claude-code',
        startDate: '2026-04-01',
        endDate: '2026-04-15'
      },
      new Date('2026-04-29T12:00:00.000Z')
    )

    expect(filters).toEqual({
      source: 'claude-code',
      startDate: '2026-04-01',
      endDate: '2026-04-15'
    })
  })

  test('normalizes reversed date ranges', () => {
    const filters = parseUsageDetailsFilters(
      {
        source: 'codex',
        startDate: '2026-04-20',
        endDate: '2026-04-01'
      },
      new Date('2026-04-29T12:00:00.000Z')
    )

    expect(filters).toEqual({
      source: 'codex',
      startDate: '2026-04-01',
      endDate: '2026-04-20'
    })
  })
})
