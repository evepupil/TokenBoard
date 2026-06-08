import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { DashboardPreview } from './dashboard-preview'

describe('DashboardPreview', () => {
  test('renders no-cache-read trend and source split metrics', async () => {
    const html = await renderToString(
      <DashboardPreview
        userName="Example User"
        summary={{
          todayTokens: 5926469,
          todayTokensWithoutCacheRead: 1264069,
          todayCacheReadRate: 80 / 300,
          todayCostUsd: 0.42,
          monthTokens: 9027123784974,
          monthTokensWithoutCacheRead: 680228706,
          monthCacheReadRate: 300 / 1200,
          monthCostUsd: 1.7,
          lastSyncedAt: '2026-04-28T08:00:00.000Z',
          deviceCount: 2,
          sourceSplit: [
            { source: 'claude-code', totalTokens: 800, totalTokensWithoutCacheRead: 600, cacheReadRate: 200 / 800 },
            { source: 'codex', totalTokens: 400, totalTokensWithoutCacheRead: 300, cacheReadRate: 100 / 400 }
          ],
          dailyTrend: [
            { usageDate: '2026-04-27', totalTokens: 120, totalTokensWithoutCacheRead: 100, cacheReadRate: 20 / 120, costUsd: 0.12 },
            { usageDate: '2026-04-28', totalTokens: 340, totalTokensWithoutCacheRead: 240, cacheReadRate: 100 / 340, costUsd: 0.34 }
          ]
        }}
      />
    )

    expect(html).toContain('最近 30 天共 460 tokens，不含缓存读 340')
    expect(html).toContain('2026-04-27: 120 total tokens, 100 不含缓存读')
    expect(html).toContain('data-dashboard-trend-chart="true"')
    expect(html).toContain('data-dashboard-trend-bar="true"')
    expect(html).toContain('data-trend-date="2026-04-27"')
    expect(html).toContain('data-trend-total="120"')
    expect(html).toContain('data-trend-without-cache-read="100"')
    expect(html).toContain('max-w-3 overflow-hidden rounded-t')
    expect(html).toContain('absolute inset-x-0 bottom-0 rounded-t bg-lime-300/90')
    expect(html).not.toContain('w-1/2 rounded-t')
    expect(html).toContain('按本月不含缓存读 token 计算')
    expect(html).toContain('5,926,469')
    expect(html).toContain('9,027,123,784,974')
    expect(html).toContain('今日缓存率')
    expect(html).toContain('本月缓存率')
    expect(html).toContain('data-dashboard-metrics-grid="true"')
    expect(html).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));')
    expect(html).toContain('break-all text-2xl font-black')
    expect(html).toContain('mx-auto flex max-w-6xl flex-col gap-3')
    expect(html).toContain('p-4 sm:p-5')
    expect(html).toContain('h-36 items-end gap-1')
    expect(html).toContain('lg:h-32 2xl:h-36')
    expect(html).toContain('p-4 lg:p-3')
    expect(html).not.toContain(`xl:${['grid', 'cols', '8'].join('-')}`)
    expect(html).toContain('600 不含缓存读 / 800 total / 缓存率 25%')
    expect(html).toContain('300 不含缓存读 / 400 total / 缓存率 25%')
  })
})
