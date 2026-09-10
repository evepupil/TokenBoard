import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { DashboardPreview, dashboardPreviewTestUtils } from './dashboard-preview'

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
          todayCostAvailable: true,
          monthTokens: 9027123784974,
          monthTokensWithoutCacheRead: 680228706,
          monthCacheReadRate: 300 / 1200,
          monthCostUsd: 1.7,
          monthCostAvailable: true,
          lastSyncedAt: '2026-04-28T08:00:00.000Z',
          deviceCount: 2,
          sourceSplit: [
            { source: 'claude-code', totalTokens: 800, totalTokensWithoutCacheRead: 600, cacheReadRate: 200 / 800 },
            { source: 'codex', totalTokens: 400, totalTokensWithoutCacheRead: 300, cacheReadRate: 100 / 400 }
          ],
          dailyTrend: [
            {
              usageDate: '2026-04-27',
              totalTokens: 120,
              totalTokensWithoutCacheRead: 100,
              cacheReadRate: 20 / 120,
              costUsd: 0.12,
              costAvailable: true
            },
            {
              usageDate: '2026-04-28',
              totalTokens: 340,
              totalTokensWithoutCacheRead: 240,
              cacheReadRate: 100 / 340,
              costUsd: 0.34,
              costAvailable: true
            }
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
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('title="2026-04-27: 120 total tokens, 100 不含缓存读"')
    expect(html).toContain('focus-visible:ring-2')
    expect(html).toContain('max-w-3 overflow-hidden rounded-t')
    expect(html).toContain('absolute inset-x-0 bottom-0 rounded-t bg-lime-300/90')
    expect(html).not.toContain('w-1/2 rounded-t')
    expect(html).toContain('按本月不含缓存读 token 计算')
    expect(html).toContain('5,926,469')
    expect(html).toContain('5.93M')
    expect(html).toContain('(592.65万)')
    expect(html).toContain('9.03T')
    expect(html).toContain('(9.03万亿)')
    expect(html).toContain('title="9,027,123,784,974"')
    expect(html).toContain('<span class="sr-only">本月 tokens: 9,027,123,784,974 (9.03T, 9.03万亿)</span>')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('data-usage-metric-detail="true"')
    expect(html).toContain('今日缓存率')
    expect(html).toContain('本月缓存率')
    expect(html).toContain('data-usage-metric-grid="true"')
    expect(html).toContain('data-usage-metric-card="true"')
    expect(html).toContain('app-surface-raised')
    expect(html).toContain('rounded-2xl border p-4 backdrop-blur')
    expect(html).toContain('bg-[var(--app-panel)] text-[var(--app-text)]')
    expect(html).toContain('app-surface-subtle flex h-36')
    expect(html).toContain('sm:grid-cols-2')
    expect(html).toContain('xl:grid-cols-4')
    expect(html).toContain('[overflow-wrap:anywhere]')
    expect(html).toContain('data-usage-metric-value="true"')
    expect(html).toContain('mx-auto flex max-w-6xl flex-col gap-3')
    expect(html).toContain('p-4 sm:p-5')
    expect(html).toContain('h-36 items-end gap-1')
    expect(html).toContain('lg:h-32 2xl:h-36')
    expect(html).toContain('p-4 lg:p-3')
    expect(html).toContain('flex min-w-0 items-center justify-between gap-4')
    expect(html).toContain('min-w-0 break-words [overflow-wrap:anywhere]')
    expect(html).toContain('shrink-0 font-bold text-[var(--app-text)]')
    expect(html).toContain('mt-1 break-words text-xs [overflow-wrap:anywhere]')
    expect(html).not.toContain('app-surface-contained min-w-0')
    expect(html).not.toContain('bg-[var(--app-bg-soft)] text-[var(--app-text)]')
    expect(html).not.toContain(`xl:${['grid', 'cols', '8'].join('-')}`)
    expect(html).not.toContain('data-dashboard-metrics-grid="true"')
    expect(html).not.toContain('grid-template-columns: repeat(auto-fit')
    expect(html).toContain('600 不含缓存读 / 800 total / 缓存率 25%')
    expect(html).toContain('300 不含缓存读 / 400 total / 缓存率 25%')
  })

  test('clamps contained trend heights for edge cases', () => {
    expect(dashboardPreviewTestUtils.containedBarHeight(0, 100)).toBe(0)
    expect(dashboardPreviewTestUtils.containedBarHeight(30, 0)).toBe(0)
    expect(dashboardPreviewTestUtils.containedBarHeight(1, 100)).toBe(8)
    expect(dashboardPreviewTestUtils.containedBarHeight(50, 100)).toBe(50)
    expect(dashboardPreviewTestUtils.containedBarHeight(160, 100)).toBe(100)
  })

  test('labels Antigravity source cost as unavailable', async () => {
    const html = await renderToString(
      <DashboardPreview
        summary={{
          todayTokens: 100,
          todayTokensWithoutCacheRead: 100,
          todayCacheReadRate: 0,
          todayCostUsd: 0,
          todayCostAvailable: false,
          monthTokens: 100,
          monthTokensWithoutCacheRead: 100,
          monthCacheReadRate: 0,
          monthCostUsd: 0,
          monthCostAvailable: false,
          lastSyncedAt: null,
          deviceCount: 1,
          sourceSplit: [
            { source: 'antigravity-ide', totalTokens: 100, totalTokensWithoutCacheRead: 100, cacheReadRate: 0 }
          ],
          dailyTrend: []
        }}
      />
    )

    expect(html).toContain('Antigravity IDE')
    expect(html).toContain('今日费用')
    expect(html).toContain('(Antigravity 费用不可用)')
    expect(html).not.toContain('Antigravity 费用不可用，不计入费用卡片。')
  })

  test('keeps today and month cost availability separate', async () => {
    const html = await renderToString(
      <DashboardPreview
        summary={{
          todayTokens: 100,
          todayTokensWithoutCacheRead: 100,
          todayCacheReadRate: 0,
          todayCostUsd: 1.23,
          todayCostAvailable: true,
          monthTokens: 200,
          monthTokensWithoutCacheRead: 180,
          monthCacheReadRate: 0.1,
          monthCostUsd: 4.56,
          monthCostAvailable: false,
          lastSyncedAt: null,
          deviceCount: 1,
          sourceSplit: [
            { source: 'antigravity', totalTokens: 100, totalTokensWithoutCacheRead: 100, cacheReadRate: 0.1 },
            { source: 'claude-code', totalTokens: 100, totalTokensWithoutCacheRead: 80, cacheReadRate: 0.2 }
          ],
          dailyTrend: []
        }}
      />
    )

    expect(html).toContain('今日费用')
    expect(html).toContain('$1.23')
    expect(html).toContain('本月费用')
    expect(html).toContain('$4.56')
    expect(html).toContain('(Antigravity 费用不可用)')
    expect(html).toContain('<span class="sr-only">今日费用: $1.23</span>')
    expect(html).toContain('<span class="sr-only">本月费用: $4.56</span>')
    const todayCostCard = metricCardHtml(html, '今日费用')
    const monthCostCard = metricCardHtml(html, '本月费用')
    expect(todayCostCard).not.toContain('Antigravity 费用不可用')
    expect(monthCostCard).toContain('Antigravity 费用不可用')
  })
})

function metricCardHtml(html: string, label: string) {
  const labelIndex = html.indexOf(`>${label}</p>`)
  expect(labelIndex).toBeGreaterThanOrEqual(0)
  const start = html.lastIndexOf('<div class="app-surface-raised', labelIndex)
  const next = html.indexOf('<div class="app-surface-raised', labelIndex)
  expect(start).toBeGreaterThanOrEqual(0)
  return html.slice(start, next > start ? next : undefined)
}
