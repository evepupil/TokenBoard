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
            activeTokenCount: 1
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
              sourceSplit: [{ source: 'codex', totalTokens: 123456, totalTokensWithoutCacheRead: 120000, cacheReadRate: 3456 / 123456 }],
              modelRows: []
            }
          ],
          modelRows: []
        }}
      />
    )

    expect(html).toContain('max-w-7xl')
    expect(html).toContain('whitespace-nowrap text-3xl')
    expect(html).toContain('xl:flex-row')
    expect(html).toContain('xl:min-w-[900px]')
    expect(html).not.toContain('lg:min-w-[900px]')
    expect(html).not.toContain('&rsaquo;')
    expect(html).not.toContain('>›<')
    expect(html).not.toContain('<select')
    expect(html).toContain('data-custom-select="true"')
    expect(html).toContain('data-custom-select-menu="true"')
    expect(html).toContain('name="source"')
    expect(html).toContain('name="device"')
    expect(html).toContain('name="model"')
    expect(html).toContain('autocomplete="off"')
    expect(html).toContain('w-full sm:mt-7')
    expect(html).toContain('text-xs font-bold uppercase tracking-wide text-[var(--app-muted)] md:hidden')
    expect(html).toContain('缓存率 3%')
    expect(html).toContain('data-usage-metric-grid="true"')
    expect(html).toContain('data-usage-metric-card="true"')
    expect(html).toContain('app-surface-subtle group rounded-xl')
    expect(html).toContain('xl:grid-cols-3')
    expect(html).not.toContain('xl:grid-cols-6')
    expect(html).toContain('[overflow-wrap:anywhere]')
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
    expect(html).toContain('(1.2京)')
    expect(html).toContain('$133.33B')
    expect(html).toContain('(1333.33亿 USD)')
    expect(html).toContain('2.22B')
    expect(html).toContain('(22.22亿)')
    expect(html).toContain('title="12,007,199,254,740,992"')
    expect(html).toContain('<span class="sr-only">范围 tokens: 12,007,199,254,740,992 (12.01P, 1.2京)</span>')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('data-usage-metric-detail="true"')
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
            totalTokens: 0,
            totalTokensWithoutCacheRead: 0,
            cacheReadRate: 0,
            costUsd: 0,
            sessionCount: 0,
            activeDays: 0
          },
          dailyRows: [
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

    expect(html).toContain('text-[var(--app-muted)]">无用量')
    expect(html).not.toContain('text-[var(--app-subtle)]">无用量')
  })
})
