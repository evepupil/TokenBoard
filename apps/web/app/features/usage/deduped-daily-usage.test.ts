import { describe, expect, test } from 'vitest'
import {
  effectiveDailyUsageSummaryWith,
  usageSummaryScopeSql,
  usageSummaryStrictMode,
  usageSummaryValue
} from './deduped-daily-usage'

describe('effectiveDailyUsageSummaryWith', () => {
  test('pushes structured fallback filters into both usage sources', () => {
    const sql = effectiveDailyUsageSummaryWith({
      filter: usageSummaryScopeSql({
        userId: usageSummaryValue.bind(),
        usageDateGte: usageSummaryValue.bind()
      })
    })

    expect(sql).toContain('deduped_daily_usage AS')
    expect(sql).toContain('AND (daily_usage.user_id = ? AND daily_usage.usage_date >= ?)')
    expect(sql).toContain('WHERE daily_usage_summary.user_id = ? AND daily_usage_summary.usage_date >= ?')
  })

  test('strict mode reads only the summary cache', () => {
    const sql = effectiveDailyUsageSummaryWith({
      filter: usageSummaryScopeSql({
        userId: usageSummaryValue.bind()
      }),
      summaryStrict: true
    })

    expect(sql).toContain('FROM daily_usage_summary')
    expect(sql).not.toContain('deduped_daily_usage')
    expect(sql).not.toContain('fallback_daily_usage_summary')
  })

  test('rejects legacy raw SQL filter input', () => {
    expect(() =>
      effectiveDailyUsageSummaryWith({
        dailyUsageFilter: 'daily_usage.user_id = ?'
      } as never)
    ).toThrow('Usage summary filters must be built with usageSummaryScopeSql')
  })
})

describe('usageSummaryStrictMode', () => {
  test.each([
    [undefined, false],
    ['', false],
    ['   ', false],
    ['0', false],
    ['false', false],
    [' False ', false],
    ['1', true],
    ['true', true],
    [' TRUE ', true]
  ])('parses %s as %s', (value, expected) => {
    expect(usageSummaryStrictMode({ TOKENBOARD_USAGE_SUMMARY_STRICT: value })).toBe(expected)
  })

  test.each(['yes', '2', 'abc'])('rejects %s', (value) => {
    expect(() => usageSummaryStrictMode({ TOKENBOARD_USAGE_SUMMARY_STRICT: value })).toThrow(
      'TOKENBOARD_USAGE_SUMMARY_STRICT must be true, false, 1, or 0'
    )
  })
})
