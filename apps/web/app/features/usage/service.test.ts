import { describe, expect, test } from 'vitest'
import { parseUsageDetailsFilters, usageDetailsToCsv } from './service'

describe('parseUsageDetailsFilters', () => {
  test('defaults to the last 30 days and all sources', () => {
    const filters = parseUsageDetailsFilters({}, new Date('2026-04-29T12:00:00.000Z'))

    expect(filters).toEqual({
      source: 'all',
      startDate: '2026-03-31',
      endDate: '2026-04-29',
      deviceId: 'all',
      modelQuery: ''
    })
  })

  test('keeps valid date range, source, device, and model filters', () => {
    const filters = parseUsageDetailsFilters(
      {
        source: 'claude-code',
        startDate: '2026-04-01',
        endDate: '2026-04-15',
        device: 'dev_123',
        model: ' sonnet '
      },
      new Date('2026-04-29T12:00:00.000Z')
    )

    expect(filters).toEqual({
      source: 'claude-code',
      startDate: '2026-04-01',
      endDate: '2026-04-15',
      deviceId: 'dev_123',
      modelQuery: 'sonnet'
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
      endDate: '2026-04-20',
      deviceId: 'all',
      modelQuery: ''
    })
  })
})

describe('usageDetailsToCsv', () => {
  test('exports model rows with escaped CSV fields', () => {
    const csv = usageDetailsToCsv({
      summary: {
        totalTokens: 10,
        costUsd: 0.25,
        sessionCount: 1,
        activeDays: 1
      },
      dailyRows: [],
      modelRows: [
        {
          usageDate: '2026-04-29',
          source: 'claude-code',
          model: 'claude, "sonnet"',
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          totalTokens: 10,
          costUsd: 0.25,
          sessionCount: 1
        }
      ]
    })

    expect(csv).toBe(
      [
        'date,source,model,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,total_tokens,cost_usd,session_count',
        '2026-04-29,claude-code,"claude, ""sonnet""",1,2,3,4,10,0.25,1'
      ].join('\n')
    )
  })
})
