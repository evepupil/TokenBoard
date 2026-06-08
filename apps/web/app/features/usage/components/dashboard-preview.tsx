import { Badge } from '../../../components/ui/badge'
import { LinkButton } from '../../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card'
import { formatUsd } from '../../../lib/money'
import { formatPercentRate } from '../../../lib/usage-metrics'
import type { DashboardSummary } from '../service'

const metricCardMinWidth = '16rem'
const metricGridStyle = `grid-template-columns: repeat(auto-fit, minmax(min(100%, ${metricCardMinWidth}), 1fr));`

export function DashboardPreview(props: { summary: DashboardSummary; userName?: string }) {
  const totalSourceTokens = props.summary.sourceSplit.reduce(
    (total, item) => total + item.totalTokens,
    0
  )
  const totalSourceTokensWithoutCacheRead = props.summary.sourceSplit.reduce(
    (total, item) => total + item.totalTokensWithoutCacheRead,
    0
  )
  const trendMaxTokens = Math.max(...props.summary.dailyTrend.map((item) => item.totalTokens), 0)
  const trendTotalTokens = props.summary.dailyTrend.reduce(
    (total, item) => total + item.totalTokens,
    0
  )
  const trendTotalTokensWithoutCacheRead = props.summary.dailyTrend.reduce(
    (total, item) => total + item.totalTokensWithoutCacheRead,
    0
  )

  return (
    <section class="mx-auto flex max-w-6xl flex-col gap-3">
      <header class="relative overflow-hidden rounded-2xl border border-lime-200/20 bg-[radial-gradient(circle_at_85%_10%,rgba(190,242,100,.24),transparent_28%),linear-gradient(135deg,var(--app-panel-strong),var(--app-bg-soft))] p-4 sm:p-5">
        <div class="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <Badge class="min-h-8 px-3 py-1">控制台</Badge>
            <h1 class="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
              {props.userName ? `${props.userName} 的 token 面板` : 'AI token 使用面板'}
            </h1>
            <p class="mt-2 text-sm text-[var(--app-muted)]">
              最近同步：{props.summary.lastSyncedAt ?? '尚未同步'} / <a class="app-accent-link font-bold text-[var(--app-text)] underline decoration-lime-300/50 underline-offset-4" href="/settings/devices">设备数：{props.summary.deviceCount}</a>
            </p>
          </div>
          <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <LinkButton class="w-full sm:w-auto" variant="secondary" href="/dashboard/details">查看详情</LinkButton>
            <LinkButton class="w-full sm:w-auto" href="/settings/install">连接设备</LinkButton>
          </div>
        </div>
      </header>

      <div class="grid gap-3" style={metricGridStyle} data-dashboard-metrics-grid="true">
        <Metric label="今日 tokens" value={formatInteger(props.summary.todayTokens)} tone="lime" />
        <Metric label="今日不含缓存读" value={formatInteger(props.summary.todayTokensWithoutCacheRead)} />
        <Metric label="今日缓存率" value={formatPercentRate(props.summary.todayCacheReadRate)} />
        <Metric label="今日费用" value={formatUsd(props.summary.todayCostUsd)} />
        <Metric label="本月 tokens" value={formatInteger(props.summary.monthTokens)} />
        <Metric label="本月不含缓存读" value={formatInteger(props.summary.monthTokensWithoutCacheRead)} />
        <Metric label="本月缓存率" value={formatPercentRate(props.summary.monthCacheReadRate)} />
        <Metric label="本月费用" value={formatUsd(props.summary.monthCostUsd)} />
      </div>

      <section class="grid gap-3 lg:grid-cols-[1.45fr_0.85fr]">
        <Card>
          <CardHeader class="flex-row items-center justify-between gap-3 p-4 lg:p-3 xl:p-4">
            <div>
              <CardTitle>30 天趋势</CardTitle>
              <CardDescription>
                最近 30 天共 {formatInteger(trendTotalTokens)} tokens，不含缓存读 {formatInteger(trendTotalTokensWithoutCacheRead)}。
              </CardDescription>
            </div>
            <div class="flex flex-wrap justify-end gap-2">
              <Badge class="min-h-9 px-3 py-1" variant="outline">total</Badge>
              <Badge class="min-h-9 px-3 py-1">不含缓存读</Badge>
            </div>
          </CardHeader>
          <CardContent class="p-4 pt-0 lg:p-3 lg:pt-0 xl:p-4 xl:pt-0">
            <div
              class="flex h-36 items-end gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3 sm:h-40 lg:h-32 2xl:h-36"
              data-dashboard-trend-chart="true"
            >
              {props.summary.dailyTrend.map((item) => (
                <div
                  class="group relative flex h-full flex-1 items-end justify-center"
                  aria-label={`${item.usageDate}: ${formatInteger(item.totalTokens)} total tokens, ${formatInteger(item.totalTokensWithoutCacheRead)} 不含缓存读`}
                  data-dashboard-trend-bar="true"
                  data-trend-date={item.usageDate}
                  data-trend-total={formatInteger(item.totalTokens)}
                  data-trend-without-cache-read={formatInteger(item.totalTokensWithoutCacheRead)}
                >
                  <div
                    class={`relative w-full max-w-3 overflow-hidden rounded-t transition ${item.totalTokens > 0 ? 'bg-[var(--app-border)] group-hover:bg-[var(--app-muted)]' : 'bg-[var(--app-border)]'}`}
                    style={`height:${trendBarHeight(item.totalTokens, trendMaxTokens)}%`}
                  >
                    <div
                      class="absolute inset-x-0 bottom-0 rounded-t bg-lime-300/90 transition group-hover:bg-lime-200"
                      style={`height:${containedBarHeight(item.totalTokensWithoutCacheRead, item.totalTokens)}%`}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div class="mt-3 flex justify-between text-xs text-[var(--app-muted)]">
              <span>{props.summary.dailyTrend[0]?.usageDate ?? '-'}</span>
              <span>{props.summary.dailyTrend.at(-1)?.usageDate ?? '-'}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader class="p-4 lg:p-3 xl:p-4">
            <CardTitle>来源占比</CardTitle>
            <CardDescription>按本月不含缓存读 token 计算，同时保留 total token 对照。</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3 p-4 pt-0 text-sm text-[var(--app-muted)] lg:p-3 lg:pt-0 xl:p-4 xl:pt-0">
            {props.summary.sourceSplit.length > 0 ? (
              props.summary.sourceSplit.map((item) => (
                <div>
                  <div class="flex items-center justify-between gap-4">
                    <span>{formatSource(item.source)}</span>
                    <span class="font-bold text-[var(--app-text)]">
                      {formatPercent(item.totalTokensWithoutCacheRead, totalSourceTokensWithoutCacheRead)}
                    </span>
                  </div>
                  <p class="mt-1 text-xs">
                    {formatInteger(item.totalTokensWithoutCacheRead)} 不含缓存读 / {formatInteger(item.totalTokens)} total / 缓存率 {formatPercentRate(item.cacheReadRate)}
                  </p>
                  <div class="mt-2 h-2 overflow-hidden rounded-full bg-[var(--app-border)]">
                    <div
                      class="h-full rounded-full bg-lime-300"
                      style={`width:${formatPercent(item.totalTokensWithoutCacheRead, totalSourceTokensWithoutCacheRead)}`}
                      title={`Total 占比：${formatPercent(item.totalTokens, totalSourceTokens)}`}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p class="rounded-md border border-dashed border-[var(--app-border)] p-4">还没有上传使用数据。</p>
            )}
          </CardContent>
        </Card>
      </section>
    </section>
  )
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatSource(source: string) {
  return source === 'claude-code' ? 'Claude Code' : 'Codex'
}

function formatPercent(value: number, total: number) {
  if (total <= 0) return '0%'
  return `${Math.round((value / total) * 100)}%`
}

function trendBarHeight(value: number, max: number) {
  if (max <= 0 || value <= 0) return 2
  return Math.max(8, Math.round((value / max) * 100))
}

function containedBarHeight(value: number, total: number) {
  if (total <= 0 || value <= 0) return 0
  return Math.min(100, Math.max(8, Math.round((value / total) * 100)))
}

function Metric(props: { label: string; value: string; tone?: 'lime' }) {
  return (
    <div class={`min-w-0 rounded-lg border p-4 lg:p-3 ${props.tone === 'lime' ? 'border-lime-300/40 bg-lime-300 text-stone-950' : 'border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)]'}`}>
      <p class={`text-sm ${props.tone === 'lime' ? 'text-stone-700' : 'text-[var(--app-muted)]'}`}>{props.label}</p>
      <p class="mt-2 break-all text-2xl font-black leading-tight tabular-nums sm:text-3xl lg:text-2xl xl:text-3xl" data-dashboard-metric-value="true">{props.value}</p>
    </div>
  )
}
