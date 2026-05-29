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
            costUsd: 42.31,
            sessionCount: 12,
            activeDays: 3
          },
          dailyRows: [
            {
              usageDate: '2026-05-25',
              totalTokens: 123456,
              totalTokensWithoutCacheRead: 120000,
              costUsd: 42.31,
              sessionCount: 12,
              sourceSplit: [{ source: 'codex', totalTokens: 123456 }],
              modelRows: []
            }
          ],
          modelRows: []
        }}
      />
    )

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
    expect(html).toContain('w-full sm:mt-7')
    expect(html).toContain('text-xs font-bold uppercase tracking-wide text-[var(--app-muted)] md:hidden')
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
            costUsd: 0,
            sessionCount: 0,
            activeDays: 0
          },
          dailyRows: [
            {
              usageDate: '2026-05-25',
              totalTokens: 0,
              totalTokensWithoutCacheRead: 0,
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
