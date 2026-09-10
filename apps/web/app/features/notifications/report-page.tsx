import { AppNav } from '../../components/app-nav'
import { Badge } from '../../components/ui/badge'
import { LinkButton } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { formatPercentRate } from '../../lib/usage-metrics'
import {
  formatCostUnavailableNotice,
  formatModelCostWithAvailability,
  formatSource,
  hasUnavailableCostSource
} from '../usage/source-format'
import { UsageMetricCard, UsageMetricGrid } from '../usage/components/usage-metric-card'
import { formatUsageMetricInteger, formatUsageMetricUsdWithAvailability } from '../usage/components/usage-metric-format'
import type { DailyReportHistoryItem } from './report-history-item'

export function SharedDailyReportPage(props: { report: DailyReportHistoryItem; viewerEmail?: string }) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>{props.report.displayName} token 日报 - TokenBoard</title>
      <AppNav email={props.viewerEmail} />
      <section class="mx-auto flex max-w-6xl flex-col gap-3">
        <Card class="overflow-hidden">
          <CardHeader class="flex-col gap-4 border-b border-[var(--app-border)] md:flex-row md:items-end md:justify-between">
            <div>
              <Badge>日报</Badge>
              <h1 class="mt-3 text-3xl font-black tracking-tight sm:text-4xl">{props.report.displayName} token 日报</h1>
              <CardDescription class="mt-2">
                {props.report.reportDate} / {props.report.timezone} / {scheduleSlotLabel(props.report.scheduleSlot)}
              </CardDescription>
            </div>
            <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <LinkButton class="w-full sm:w-auto" variant="secondary" href="/leaderboards">
                查看排行榜
              </LinkButton>
              <LinkButton class="w-full sm:w-auto" href={props.report.dashboardUrl}>
                打开 TokenBoard
              </LinkButton>
            </div>
          </CardHeader>
        </Card>

        <UsageMetricGrid>
          <UsageMetricCard label="Tokens" value={formatUsageMetricInteger(props.report.totalTokens)} tone="lime" />
          <UsageMetricCard
            label="不含缓存读"
            value={formatUsageMetricInteger(props.report.totalTokensWithoutCacheRead)}
          />
          <UsageMetricCard label="缓存率" value={formatPercentRate(props.report.cacheReadRate ?? 0)} />
          <UsageMetricCard label="费用" value={formatReportCost(props.report)} />
        </UsageMetricGrid>

        <div class="grid gap-3 lg:grid-cols-2">
          <ReportList
            title="主要来源"
            description="按不含缓存读 token 排序，同时保留 total token 对照。"
            items={props.report.sourceSplit.map((item) => ({
              name: formatSource(item.source),
              value: `${formatInteger(item.totalTokensWithoutCacheRead)} / ${formatInteger(item.totalTokens)} tokens`,
              meta: `缓存率 ${formatPercentRate(item.cacheReadRate ?? 0)}`
            }))}
          />
          <ReportList
            title="主要模型"
            description={reportModelDescription(props.report)}
            items={props.report.topModels.map((item) => ({
              name: item.model,
              value: `${formatInteger(item.totalTokensWithoutCacheRead)} / ${formatInteger(item.totalTokens)} tokens`,
              meta: `${formatReportModelCost(item, props.report)} / 缓存率 ${formatPercentRate(item.cacheReadRate ?? 0)}`
            }))}
          />
        </div>
      </section>
    </main>
  )
}

function formatReportCost(report: DailyReportHistoryItem) {
  return report.detailsParseError
    ? { value: '费用不可用', exactValue: '费用不可用', detail: '历史明细异常，请重新生成日报' }
    : formatUsageMetricUsdWithAvailability(report.costUsd, report.sourceSplit)
}

function formatReportModelCost(model: DailyReportHistoryItem['topModels'][number], report: DailyReportHistoryItem) {
  if (report.detailsParseError) return '费用不可用（历史明细异常）'
  return formatModelCostWithAvailability(model.costUsd, model.sourceSplit, report.sourceSplit)
}

function reportModelDescription(report: DailyReportHistoryItem) {
  if (report.detailsParseError) return '历史明细格式异常，费用不可用，请重新生成日报。'
  return `按不含缓存读 token 排序，费用为当前日报快照的估算值。${hasUnavailableCostSource(report.sourceSplit) ? `${formatCostUnavailableNotice(report.sourceSplit)}。` : ''}`
}

export function MissingDailyReportPage(props: { viewerEmail?: string } = {}) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>日报不存在 - TokenBoard</title>
      <AppNav email={props.viewerEmail} />
      <Card class="mx-auto max-w-3xl">
        <CardHeader>
          <Badge>日报</Badge>
          <CardTitle class="mt-3 text-3xl sm:text-4xl">日报不存在</CardTitle>
          <CardDescription>这个分享链接不存在或历史快照已过期。</CardDescription>
        </CardHeader>
        <CardContent>
          <LinkButton variant="secondary" href="/leaderboards">
            查看排行榜
          </LinkButton>
        </CardContent>
      </Card>
    </main>
  )
}

function ReportList(props: {
  title: string
  description: string
  items: Array<{ name: string; value: string; meta: string }>
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {props.items.length > 0 ? (
          <ul class="space-y-3">
            {props.items.map((item) => (
              <li class="app-surface-subtle rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4 text-sm">
                <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <span class="break-words text-base font-black text-[var(--app-text)]">{item.name}</span>
                  <span class="break-words font-black tabular-nums text-[var(--app-text)] sm:text-right">
                    {item.value}
                  </span>
                </div>
                <p class="mt-2 text-[var(--app-muted)]">{item.meta}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p class="app-surface-subtle rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4 text-sm text-[var(--app-muted)]">
            暂无数据
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function scheduleSlotLabel(scheduleSlot: string) {
  if (scheduleSlot === 'test-preview') return '测试预览'
  return scheduleSlot.includes('T') ? scheduleSlot.slice(scheduleSlot.indexOf('T') + 1) : scheduleSlot
}
