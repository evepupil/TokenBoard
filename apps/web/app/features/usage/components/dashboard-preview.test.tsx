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
          mismatchedUsageTimezones: [],
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
    expect(html).toContain('app-viz-bar-2')
    expect(html).not.toContain('w-1/2 rounded-t')
    expect(html).toContain('按本月不含缓存读 token 计算')
    expect(html).toContain('5,926,469')
    expect(html).toContain('5.93M')
    expect(html).toContain('9.03T')
    expect(html).toContain('title="9,027,123,784,974"')
    expect(html).toContain('<span class="sr-only">本月 tokens: 9,027,123,784,974 (9.03T)</span>')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('今日缓存率')
    expect(html).toContain('本月缓存率')
    expect(html).toContain('data-usage-metric-grid="true"')
    expect(html).toContain('data-usage-metric-card="true"')
    expect(html).toContain('app-metric-card')
    expect(html).toContain('sm:grid-cols-2')
    expect(html).toContain('xl:grid-cols-4')
    expect(html).toContain('[overflow-wrap:anywhere]')
    expect(html).toContain('data-usage-metric-value="true"')
    expect(html).toContain('app-folio-container')
    expect(html).toContain('app-folio-spread')
    expect(html).toContain('data-folio-cache-waffle="true"')
    expect(html).toContain('data-folio-stacked-ribbon="true"')
    expect(html).not.toContain('app-surface-contained min-w-0')
    expect(html).not.toContain(`xl:${['grid', 'cols', '8'].join('-')}`)
    expect(html).not.toContain('data-dashboard-metrics-grid="true"')
    expect(html).not.toContain('grid-template-columns: repeat(auto-fit')
    expect(html).toContain('600 不含缓存读 / 800 total / 缓存率 25%')
    expect(html).toContain('300 不含缓存读 / 400 total / 缓存率 25%')
  })

  // The bars used to express their size as inline `style` attributes. The CSP that ships
  // with the app sets `style-src 'self'` with no inline allowance, and a style *attribute*
  // cannot be allowlisted by hash the way an inline script can — the browser drops it and
  // every bar collapses to zero. Sizes therefore have to travel as classes, which the
  // stylesheet safelists. This test pins both halves: nothing inline may come back, and
  // the classes the renderer emits must be the percent utilities that are safelisted.
  test('sizes the bars with percent classes instead of inline styles', async () => {
    const html = await renderToString(
      <DashboardPreview
        summary={{
          todayTokens: 100,
          todayTokensWithoutCacheRead: 100,
          todayCacheReadRate: 0,
          todayCostUsd: 0,
          todayCostAvailable: true,
          monthTokens: 100,
          monthTokensWithoutCacheRead: 100,
          monthCacheReadRate: 0,
          monthCostUsd: 0,
          monthCostAvailable: true,
          lastSyncedAt: null,
          deviceCount: 1,
          sourceSplit: [
            { source: 'claude-code', totalTokens: 800, totalTokensWithoutCacheRead: 600, cacheReadRate: 0.25 },
            { source: 'codex', totalTokens: 200, totalTokensWithoutCacheRead: 100, cacheReadRate: 0.5 }
          ],
          mismatchedUsageTimezones: [],
          dailyTrend: [
            {
              usageDate: '2026-04-27',
              totalTokens: 100,
              totalTokensWithoutCacheRead: 50,
              cacheReadRate: 0.5,
              costUsd: 0.1,
              costAvailable: true
            },
            {
              usageDate: '2026-04-28',
              totalTokens: 40,
              totalTokensWithoutCacheRead: 20,
              cacheReadRate: 0.5,
              costUsd: 0.04,
              costAvailable: true
            }
          ]
        }}
      />
    )

    // No inline style may survive: under `style-src 'self'` the browser discards it, so a
    // silent reintroduction would look fine in the HTML and render as a flat chart.
    expect(html).not.toContain('style=')
    // Trend bars scale against the 100-token max: 100 -> 100%, 40 -> 40%. The contained
    // overlay scales against its own bar: 50/100 -> 50%. The source split is measured in
    // 不含缓存读 tokens, so it is 600/700 -> 86%, not 600/800.
    expect(html).toContain('h-[100%]')
    expect(html).toContain('h-[40%]')
    expect(html).toContain('h-[50%]')
    expect(html).toContain('w-[86%]')
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
          mismatchedUsageTimezones: [],
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
          mismatchedUsageTimezones: [],
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
    // The visible "cost unavailable" notice is aria-hidden, so the month card has to announce
    // it in the sr-only label too — otherwise a screen reader never hears it.
    expect(html).toContain('<span class="sr-only">本月费用: $4.56 (Antigravity 费用不可用)</span>')
    const todayCostCard = metricCardHtml(html, '今日费用')
    const monthCostCard = metricCardHtml(html, '本月费用')
    expect(todayCostCard).not.toContain('Antigravity 费用不可用')
    expect(monthCostCard).toContain('Antigravity 费用不可用')
  })
})

function metricCardHtml(html: string, label: string) {
  const labelIndex = html.indexOf(`>${label}</p>`)
  expect(labelIndex).toBeGreaterThanOrEqual(0)
  // Anchor on the data attribute, not the class list: the card's utility classes are styling
  // detail and change (a hover effect was added once already) without the card's meaning
  // changing. The attribute is the component's contract.
  const anchor = html.lastIndexOf('data-usage-metric-card="true"', labelIndex)
  expect(anchor).toBeGreaterThanOrEqual(0)
  const start = html.lastIndexOf('<div', anchor)
  const next = html.indexOf('data-usage-metric-card="true"', anchor + 1)
  return html.slice(start, next > start ? html.lastIndexOf('<div', next) : undefined)
}

// "Today" is the user's local day, and the dashboard is the one place a user checks it. The
// label said only "今日", so a user whose day boundary sits somewhere other than UTC had no way
// to tell which midnight the number reset at — and after moving between zones, no way to see
// that the boundary had moved with their profile.
describe('DashboardPreview timezone caption', () => {
  test('names the zone the today figures are measured in', async () => {
    const html = await renderToString(
      <DashboardPreview
        summary={emptySummary()}
        userName="Example User"
        timezone="Asia/Shanghai"
        timezoneLabel="UTC+8"
      />
    )

    expect(html).toContain('data-dashboard-timezone="true"')
    expect(html).toContain('Asia/Shanghai')
    expect(html).toContain('UTC+8')
  })

  // The offset is what makes the boundary legible: `America/Los_Angeles` does not say whether
  // the day turns over seven or eight hours behind UTC, and that difference is the whole point.
  test('shows the offset alongside the zone name', async () => {
    const html = await renderToString(
      <DashboardPreview summary={emptySummary()} timezone="America/Los_Angeles" timezoneLabel="UTC-7" />
    )

    expect(html).toContain('UTC-7')
  })
})

function emptySummary() {
  return {
    todayTokens: 0,
    todayTokensWithoutCacheRead: 0,
    todayCacheReadRate: 0,
    todayCostUsd: 0,
    todayCostAvailable: true,
    monthTokens: 0,
    monthTokensWithoutCacheRead: 0,
    monthCacheReadRate: 0,
    monthCostUsd: 0,
    monthCostAvailable: true,
    lastSyncedAt: null,
    deviceCount: 0,
    sourceSplit: [],
    mismatchedUsageTimezones: [],
    dailyTrend: []
  }
}

// The dashboard attributes "today" by the profile zone while each collector stamps `usage_date`
// in its own, frozen into the collector's config at install time. Nothing propagates a later
// profile change back to an installed collector, so after a user moves and edits the setting the
// two calendars diverge: the dashboard asks for the profile's today, the collector has written
// the other zone's today, and the figure reads zero while the month total still counts the row.
// The user sees a wrong number with no explanation, so the disagreement has to be stated.
describe('DashboardPreview collector timezone warning', () => {
  test('warns when a collector is still stamping another zone', async () => {
    const html = await renderToString(
      <DashboardPreview
        summary={{ ...emptySummary(), mismatchedUsageTimezones: ['Asia/Shanghai'] }}
        timezone="America/Los_Angeles"
        timezoneLabel="UTC-7"
      />
    )

    expect(html).toContain('data-dashboard-timezone-mismatch="true"')
    expect(html).toContain('Asia/Shanghai')
    // The fix is to reinstall with the right zone, so the warning has to lead there.
    expect(html).toContain('/settings/install')
  })

  test('names every disagreeing collector zone', async () => {
    const html = await renderToString(
      <DashboardPreview
        summary={{ ...emptySummary(), mismatchedUsageTimezones: ['Asia/Shanghai', 'UTC'] }}
        timezone="America/Los_Angeles"
        timezoneLabel="UTC-7"
      />
    )

    expect(html).toContain('Asia/Shanghai')
    expect(html).toContain('UTC')
  })

  test('stays silent when the collector and the profile agree', async () => {
    const html = await renderToString(
      <DashboardPreview summary={emptySummary()} timezone="America/Los_Angeles" timezoneLabel="UTC-7" />
    )

    expect(html).not.toContain('data-dashboard-timezone-mismatch="true"')
  })
})
