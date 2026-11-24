import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { UsageDetailsPanel } from './usage-details-panel'

describe('UsageDetailsPanel', () => {
  test('keeps the filter form out of the 1024px header layout', async () => {
    const html = await renderToString(
      <UsageDetailsPanel
        devices={[
          {
            id: 'device_1',
            name: 'MacBook Pro With A Long Local Collector Name',
            platform: 'darwin',
            lastSyncedAt: '2026-05-25T01:00:00.000Z',
            createdAt: '2026-05-01T01:00:00.000Z',
            activeTokenCount: 1,
            installations: [],
            uploadTokens: []
          }
        ]}
        filters={{
          source: 'all',
          startDate: '2026-04-26',
          endDate: '2026-05-25',
          deviceId: 'all',
          modelQuery: 'gpt'
        }}
        details={{
          summary: {
            totalTokens: 123456,
            totalTokensWithoutCacheRead: 120000,
            cacheReadRate: 3456 / 123456,
            costUsd: 42.31,
            sessionCount: 12,
            activeDays: 3
          },
          dailyRows: [
            {
              usageDate: '2026-05-25',
              totalTokens: 123456,
              totalTokensWithoutCacheRead: 120000,
              cacheReadRate: 3456 / 123456,
              costUsd: 42.31,
              sessionCount: 12,
              sourceSplit: [
                {
                  source: 'codex',
                  totalTokens: 123456,
                  totalTokensWithoutCacheRead: 120000,
                  cacheReadRate: 3456 / 123456
                }
              ],
              modelRows: []
            }
          ],
          modelRows: []
        }}
      />
    )

    expect(html).toContain('app-folio-container')
    expect(html).toContain('app-folio-h2')
    expect(html).not.toContain('&rsaquo;')
    expect(html).not.toContain('>›<')
    expect(html).not.toContain('<select')
    expect(html).toContain('data-custom-select="true"')
    expect(html).toContain('data-custom-select-menu="true"')
    expect(html).toContain('name="source"')
    expect(html).toContain('name="device"')
    expect(html).toContain('name="model"')
    expect(html).toContain('autocomplete="off"')
    expect(html).toContain('缓存率 3%')
    expect(html).toContain('[overflow-wrap:anywhere]')
    expect(html).toContain('data-usage-metric-grid="true"')
    expect(html).toContain('data-usage-metric-card="true"')
    expect(html).toContain('app-metric-card min-w-0')
    expect(html).toContain('xl:grid-cols-3')
    expect(html).not.toContain('xl:grid-cols-6')
    expect(html).not.toContain('app-surface-contained min-w-0')
    expect(html).not.toContain('data-usage-metric-detail="true"')
  })

  test('renders large summary metrics with compact units and exact value metadata', async () => {
    const html = await renderToString(
      <UsageDetailsPanel
        devices={[]}
        filters={{
          source: 'all',
          startDate: '2026-05-12',
          endDate: '2026-06-10',
          deviceId: 'all',
          modelQuery: ''
        }}
        details={{
          summary: {
            totalTokens: 12_007_199_254_740_992,
            totalTokensWithoutCacheRead: 9_707_199_254_740_992,
            cacheReadRate: 0.19,
            costUsd: 133_333_332_222.46,
            sessionCount: 2_222_222_211,
            activeDays: 2
          },
          dailyRows: [],
          modelRows: []
        }}
      />
    )

    expect(html).toContain('12.01P')
    expect(html).toContain('$133.33B')
    expect(html).toContain('2.22B')
    expect(html).toContain('title="12,007,199,254,740,992"')
    expect(html).toContain('<span class="sr-only">范围 tokens: 12,007,199,254,740,992 (12.01P)</span>')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('当前筛选范围内没有用量。')
    expect(html).not.toContain('DailySummaryHeader')
  })

  // The real page always has one seeded row per calendar day, so "no usage" shows up as a range
  // of zero rows, not an empty array. The empty state has to key off the zero totals.
  test('shows the empty state for a range seeded with zero-total days', async () => {
    const html = await renderToString(
      <UsageDetailsPanel
        devices={[]}
        filters={{ source: 'all', startDate: '2026-05-25', endDate: '2026-05-26', deviceId: 'all', modelQuery: '' }}
        details={{
          summary: {
            totalTokens: 0,
            totalTokensWithoutCacheRead: 0,
            cacheReadRate: 0,
            costUsd: 0,
            sessionCount: 0,
            activeDays: 0
          },
          dailyRows: [
            {
              usageDate: '2026-05-26',
              totalTokens: 0,
              totalTokensWithoutCacheRead: 0,
              cacheReadRate: 0,
              costUsd: 0,
              sessionCount: 0,
              sourceSplit: [],
              modelRows: []
            },
            {
              usageDate: '2026-05-25',
              totalTokens: 0,
              totalTokensWithoutCacheRead: 0,
              cacheReadRate: 0,
              costUsd: 0,
              sessionCount: 0,
              sourceSplit: [],
              modelRows: []
            }
          ],
          modelRows: []
        }}
      />
    )

    expect(html).toContain('当前筛选范围内没有用量。')
  })

  test('renders empty source split text with readable muted contrast', async () => {
    const html = await renderToString(
      <UsageDetailsPanel
        devices={[]}
        filters={{
          source: 'all',
          startDate: '2026-04-26',
          endDate: '2026-05-25',
          deviceId: 'all',
          modelQuery: ''
        }}
        details={{
          summary: {
            totalTokens: 1000,
            totalTokensWithoutCacheRead: 900,
            cacheReadRate: 0.1,
            costUsd: 1.5,
            sessionCount: 2,
            activeDays: 2
          },
          dailyRows: [
            {
              usageDate: '2026-05-26',
              totalTokens: 1000,
              totalTokensWithoutCacheRead: 900,
              cacheReadRate: 0.1,
              costUsd: 1.5,
              sessionCount: 2,
              sourceSplit: [
                {
                  source: 'codex',
                  totalTokens: 1000,
                  totalTokensWithoutCacheRead: 900,
                  cacheReadRate: 0.1
                }
              ],
              modelRows: []
            },
            {
              // A day with no usage of its own still renders beside its neighbours, and that
              // is where the muted-but-readable 无用量 placeholder shows up.
              usageDate: '2026-05-25',
              totalTokens: 0,
              totalTokensWithoutCacheRead: 0,
              cacheReadRate: 0,
              costUsd: 0,
              sessionCount: 0,
              sourceSplit: [],
              modelRows: []
            }
          ],
          modelRows: []
        }}
      />
    )

    expect(html).toContain('text-[var(--app-muted)]">无用量')
    expect(html).not.toContain('text-[var(--app-subtle)]">无用量')
  })

  test('marks Antigravity costs unavailable without agy-only wording', async () => {
    const html = await renderToString(
      <UsageDetailsPanel
        devices={[]}
        filters={{
          source: 'all',
          startDate: '2026-05-12',
          endDate: '2026-06-10',
          deviceId: 'all',
          modelQuery: ''
        }}
        details={{
          summary: {
            totalTokens: 1000,
            totalTokensWithoutCacheRead: 900,
            cacheReadRate: 0.1,
            costUsd: 0,
            sessionCount: 2,
            activeDays: 1
          },
          dailyRows: [
            {
              usageDate: '2026-06-10',
              totalTokens: 1000,
              totalTokensWithoutCacheRead: 900,
              cacheReadRate: 0.1,
              costUsd: 0,
              sessionCount: 2,
              sourceSplit: [
                { source: 'antigravity-ide', totalTokens: 1000, totalTokensWithoutCacheRead: 900, cacheReadRate: 0.1 }
              ],
              modelRows: [
                {
                  usageDate: '2026-06-10',
                  source: 'antigravity-ide',
                  model: 'Gemini 3.5 Flash',
                  inputTokens: 500,
                  outputTokens: 400,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 100,
                  totalTokens: 1000,
                  totalTokensWithoutCacheRead: 900,
                  cacheReadRate: 0.1,
                  costUsd: 0,
                  sessionCount: 2
                }
              ]
            }
          ],
          modelRows: [
            {
              usageDate: '2026-06-10',
              source: 'antigravity-ide',
              model: 'Gemini 3.5 Flash',
              inputTokens: 500,
              outputTokens: 400,
              cacheCreationTokens: 0,
              cacheReadTokens: 100,
              totalTokens: 1000,
              totalTokensWithoutCacheRead: 900,
              cacheReadRate: 0.1,
              costUsd: 0,
              sessionCount: 2
            }
          ]
        }}
      />
    )

    expect(html).toContain('范围费用(不含 Antigravity)')
    expect(html).toContain('$0.00 (Antigravity IDE 费用不可用)')
    expect(html).toContain('Antigravity IDE')
    expect(html).not.toContain('不含 agy')
  })
})

// The date column here is the owner's local calendar day, exactly as on the dashboard and the
// card. The subtitle named the window but not the zone it was measured in, so a user comparing
// this page against a report from another tool had no way to see why the days differed.
describe('UsageDetailsPanel timezone caption', () => {
  test('names the zone the date window is measured in', async () => {
    const html = await renderToString(
      <UsageDetailsPanel
        devices={[]}
        filters={{
          source: 'all',
          startDate: '2026-04-26',
          endDate: '2026-05-25',
          deviceId: 'all',
          modelQuery: ''
        }}
        details={emptyDetails()}
        timezone="Asia/Shanghai"
        timezoneLabel="UTC+8"
      />
    )

    expect(html).toContain('data-usage-details-timezone="true"')
    expect(html).toContain('Asia/Shanghai')
    expect(html).toContain('UTC+8')
  })
})

function emptyDetails() {
  return {
    summary: {
      totalTokens: 0,
      totalTokensWithoutCacheRead: 0,
      cacheReadRate: 0,
      costUsd: 0,
      sessionCount: 0,
      activeDays: 0
    },
    dailyRows: [],
    modelRows: []
  }
}
