import { AppNav } from '../../components/app-nav'
import { FolioCacheWaffle } from '../../components/charts/folio-charts'
import { LinkButton } from '../../components/ui/button'
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
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-8 sm:py-6">
      <title>{props.report.displayName} token 日报 - TokenBoard</title>
      <AppNav email={props.viewerEmail} />
      <section class="app-folio-container flex flex-col gap-10 pb-14">
        <header class="flex flex-col gap-4 border-b border-[var(--app-border-strong)] pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p class="app-folio-kicker">DAILY DISPATCH · 公开日报快照</p>
            <h1 class="app-folio-h2 mt-2">{props.report.displayName} token 日报</h1>
            <p class="mt-2 font-mono text-xs text-[var(--app-muted)]">
              {props.report.reportDate} · {props.report.timezone} · {scheduleSlotLabel(props.report.scheduleSlot)}
            </p>
          </div>
          <div class="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
            <LinkButton class="w-full sm:w-auto" variant="secondary" href="/leaderboards">
              查看排行榜
            </LinkButton>
            <LinkButton class="w-full sm:w-auto" href={props.report.dashboardUrl}>
              打开 TokenBoard →
            </LinkButton>
          </div>
        </header>

        <UsageMetricGrid>
          <UsageMetricCard label="Tokens" value={formatUsageMetricInteger(props.report.totalTokens)} tone="lime" />
          <UsageMetricCard
            label="不含缓存读"
            value={formatUsageMetricInteger(props.report.totalTokensWithoutCacheRead)}
          />
          <UsageMetricCard label="缓存率" value={formatPercentRate(props.report.cacheReadRate ?? 0)} />
          <UsageMetricCard label="费用" value={formatReportCost(props.report)} />
        </UsageMetricGrid>

        <div class="app-folio-spread items-start">
          <div class="app-folio-spread-left space-y-8">
            <ReportList
              kicker="01 — SOURCE SPLIT"
              title="主要来源"
              description="按不含缓存读 token 排序，同时保留 total token 对照。"
              items={props.report.sourceSplit.map((item) => ({
                name: formatSource(item.source),
                value: `${formatInteger(item.totalTokensWithoutCacheRead)} / ${formatInteger(item.totalTokens)} tokens`,
                meta: `缓存率 ${formatPercentRate(item.cacheReadRate ?? 0)}`
              }))}
            />
            <div class="border-t border-[var(--app-border)] pt-6">
              <p class="app-folio-kicker mb-3">02 — PROMPT CACHE WAFFLE</p>
              <FolioCacheWaffle
                cacheHitRate={props.report.cacheReadRate ?? 0}
                patternId="report-cache-hatch"
                caption="FIG. 01 — 当日全来源 Prompt Cache 命中占比华夫格。"
              />
            </div>
          </div>

          <div class="app-folio-spread-right">
            <ReportList
              kicker="03 — TOP MODELS"
              title="主要模型"
              description={reportModelDescription(props.report)}
              items={props.report.topModels.map((item) => ({
                name: item.model,
                value: `${formatInteger(item.totalTokensWithoutCacheRead)} / ${formatInteger(item.totalTokens)} tokens`,
                meta: `${formatReportModelCost(item, props.report)} · 缓存率 ${formatPercentRate(item.cacheReadRate ?? 0)}`
              }))}
            />
          </div>
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
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-8 sm:py-6">
      <title>日报不存在 - TokenBoard</title>
      <AppNav email={props.viewerEmail} />
      <section class="app-folio-container max-w-3xl border border-[var(--app-border-strong)] bg-[var(--app-panel)] p-8">
        <p class="app-folio-kicker">404 · REPORT ARCHIVE</p>
        <h1 class="app-folio-h2 mt-3">日报不存在</h1>
        <p class="mt-3 text-sm text-[var(--app-muted)]">这个分享链接不存在或历史快照已过期。</p>
        <div class="mt-6">
          <LinkButton variant="secondary" href="/leaderboards">
            查看排行榜 →
          </LinkButton>
        </div>
      </section>
    </main>
  )
}

function ReportList(props: {
  kicker: string
  title: string
  description: string
  items: Array<{ name: string; value: string; meta: string }>
}) {
  return (
    <div>
      <p class="app-folio-kicker">{props.kicker}</p>
      <h2 class="mt-1 text-xl font-extrabold tracking-tight">{props.title}</h2>
      <p class="mt-1 text-sm text-[var(--app-muted)]">{props.description}</p>
      {props.items.length > 0 ? (
        <ul class="mt-4 divide-y divide-[var(--app-border)] border-y border-[var(--app-border-strong)]">
          {props.items.map((item) => (
            <li class="py-3.5 text-sm">
              <div class="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:justify-between">
                <span class="break-words font-mono text-sm font-bold text-[var(--app-text)]">{item.name}</span>
                <span class="break-words font-mono font-bold tabular-nums text-[var(--app-text)] sm:text-right">
                  {item.value}
                </span>
              </div>
              <p class="mt-1 font-mono text-xs text-[var(--app-muted)]">{item.meta}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p class="mt-4 border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-4 text-sm text-[var(--app-muted)]">
          暂无数据
        </p>
      )}
    </div>
  )
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function scheduleSlotLabel(scheduleSlot: string) {
  if (scheduleSlot === 'test-preview') return '测试预览'
  return scheduleSlot.includes('T') ? scheduleSlot.slice(scheduleSlot.indexOf('T') + 1) : scheduleSlot
}
