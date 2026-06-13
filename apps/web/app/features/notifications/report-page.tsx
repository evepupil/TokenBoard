import { AppNav } from '../../components/app-nav'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { formatUsd } from '../../lib/money'
import { formatPercentRate } from '../../lib/usage-metrics'
import type { DailyReportHistoryItem } from './report-history-item'

export function SharedDailyReportPage(props: {
  report: DailyReportHistoryItem
  viewerEmail?: string
}) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>{props.report.displayName} token 日报 - TokenBoard</title>
      <AppNav email={props.viewerEmail} />
      <section class="mx-auto max-w-5xl">
        <header class="app-surface-raised rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
          <p class="app-accent-text text-sm font-black uppercase tracking-[0.24em]">Daily Report</p>
          <h1 class="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
            {props.report.displayName} token 日报
          </h1>
          <p class="mt-2 text-sm text-[var(--app-muted)]">
            {props.report.reportDate} / {props.report.timezone} / {scheduleSlotLabel(props.report.scheduleSlot)}
          </p>
        </header>

        <div class="mt-5 grid gap-4 md:grid-cols-4">
          <Metric label="Tokens" value={formatInteger(props.report.totalTokens)} />
          <Metric label="不含缓存读" value={formatInteger(props.report.totalTokensWithoutCacheRead)} />
          <Metric label="缓存率" value={formatPercentRate(props.report.cacheReadRate ?? 0)} />
          <Metric label="费用" value={formatUsd(props.report.costUsd)} />
        </div>

        <div class="mt-5 grid gap-5 lg:grid-cols-2">
          <ReportList
            title="主要来源"
            items={props.report.sourceSplit.map((item) => ({
              name: formatSource(item.source),
              value: `${formatInteger(item.totalTokensWithoutCacheRead)} / ${formatInteger(item.totalTokens)} tokens`,
              meta: `缓存率 ${formatPercentRate(item.cacheReadRate ?? 0)}`
            }))}
          />
          <ReportList
            title="主要模型"
            items={props.report.topModels.map((item) => ({
              name: item.model,
              value: `${formatInteger(item.totalTokensWithoutCacheRead)} / ${formatInteger(item.totalTokens)} tokens`,
              meta: `${formatUsd(item.costUsd)} / 缓存率 ${formatPercentRate(item.cacheReadRate ?? 0)}`
            }))}
          />
        </div>
      </section>
    </main>
  )
}

export function MissingDailyReportPage(props: { viewerEmail?: string } = {}) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>日报不存在 - TokenBoard</title>
      <AppNav email={props.viewerEmail} />
      <section class="app-surface-raised mx-auto max-w-3xl rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
        <p class="app-accent-text text-sm font-black uppercase tracking-[0.24em]">Daily Report</p>
        <h1 class="mt-3 text-3xl font-black tracking-tight">日报不存在</h1>
        <p class="mt-2 text-sm text-[var(--app-muted)]">这个分享链接不存在或历史快照已过期。</p>
      </section>
    </main>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="app-surface-raised rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
      <p class="text-xs font-bold uppercase tracking-wide text-[var(--app-muted)]">{props.label}</p>
      <p class="mt-3 break-words text-2xl font-black tabular-nums">{props.value}</p>
    </div>
  )
}

function ReportList(props: {
  title: string
  items: Array<{ name: string; value: string; meta: string }>
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {props.items.length > 0 ? (
          <ul class="space-y-3">
            {props.items.map((item) => (
              <li class="app-surface-subtle rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
                <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <span class="break-words text-lg font-black">{item.name}</span>
                  <span class="font-black tabular-nums">{item.value}</span>
                </div>
                <p class="mt-2 text-sm text-[var(--app-muted)]">{item.meta}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p class="app-surface-subtle rounded-lg border border-dashed border-[var(--app-border)] p-4 text-sm text-[var(--app-muted)]">
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

function formatSource(source: string) {
  if (source === 'claude-code') return 'Claude Code'
  if (source === 'codex') return 'Codex'
  return source
}

function scheduleSlotLabel(scheduleSlot: string) {
  if (scheduleSlot === 'test-preview') return '测试预览'
  return scheduleSlot.includes('T') ? scheduleSlot.slice(scheduleSlot.indexOf('T') + 1) : scheduleSlot
}
