import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { DashboardPreview } from './dashboard-preview'

describe('DashboardPreview', () => {
  test('renders no-cache-read trend and source split metrics', async () => {
    const html = await renderToString(
      <DashboardPreview
        userName="Example User"
        summary={{
          todayTokens: 300,
          todayTokensWithoutCacheRead: 220,
          todayCacheReadRate: 80 / 300,
          todayCostUsd: 0.42,
          monthTokens: 1200,
          monthTokensWithoutCacheRead: 900,
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
    expect(html).toContain('2026-04-27: 120 total / 100 不含缓存读')
    expect(html).toContain('按本月不含缓存读 token 计算')
    expect(html).toContain('今日缓存率')
    expect(html).toContain('本月缓存率')
    expect(html).toContain('sm:grid-cols-2 lg:grid-cols-4')
    expect(html).toContain('break-words text-2xl font-black')
    expect(html).not.toContain('xl:grid-cols-8')
    expect(html).toContain('600 不含缓存读 / 800 total / 缓存率 25%')
    expect(html).toContain('300 不含缓存读 / 400 total / 缓存率 25%')
  })
})
