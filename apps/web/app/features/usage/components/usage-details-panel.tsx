import { ChevronRight } from 'lucide'
import { LucideIcon } from '../../../components/ui/icon'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table'
import { formatPercentRate } from '../../../lib/usage-metrics'
import type { UserDevice } from '../../device/service'
import type { UsageDetails } from '../queries'
import type { UsageDetailsFilters } from '../service'
import { formatCostUnavailableSourceName, formatCostWithAvailability, hasUnavailableCostSource } from '../source-format'
import { UsageMetricCard, UsageMetricGrid } from './usage-metric-card'
import { UsageDetailsFiltersForm } from './usage-details-filters'
import { formatInteger, formatPercent, formatSource } from './usage-details-format'
import { formatUsageMetricInteger, formatUsageMetricUsdWithAvailability } from './usage-metric-format'

export function UsageDetailsPanel(props: {
  details: UsageDetails
  filters: UsageDetailsFilters
  devices: UserDevice[]
  timezone?: string
  timezoneLabel?: string
}) {
  const dailyRows = [...props.details.dailyRows].reverse()
  const selectedDevice = props.devices.find((device) => device.id === props.filters.deviceId)
  const hasUnavailableCost = hasUnavailableCostSource(props.details.modelRows)
  const maxDayTokens = Math.max(...dailyRows.map((row) => row.totalTokens), 0)

  return (
    <section class="app-folio-container flex flex-col gap-10 pb-12">
      <UsageDetailsHeader
        filters={props.filters}
        devices={props.devices}
        selectedDevice={selectedDevice}
        timezone={props.timezone}
        timezoneLabel={props.timezoneLabel}
      />

      <UsageMetricGrid columns={3}>
        <UsageMetricCard
          label="范围 tokens"
          value={formatUsageMetricInteger(props.details.summary.totalTokens)}
          tone="lime"
        />
        <UsageMetricCard
          label="不含缓存读"
          value={formatUsageMetricInteger(props.details.summary.totalTokensWithoutCacheRead)}
        />
        <UsageMetricCard label="缓存率" value={formatPercentRate(props.details.summary.cacheReadRate)} />
        <UsageMetricCard
          label={
            hasUnavailableCost
              ? `范围费用(不含 ${formatCostUnavailableSourceName(props.details.modelRows)})`
              : '范围费用'
          }
          value={formatUsageMetricUsdWithAvailability(props.details.summary.costUsd, props.details.modelRows)}
        />
        <UsageMetricCard label="Sessions" value={formatUsageMetricInteger(props.details.summary.sessionCount)} />
        <UsageMetricCard label="活跃天数" value={formatUsageMetricInteger(props.details.summary.activeDays)} />
      </UsageMetricGrid>

      <DailySummaryLedger dailyRows={dailyRows} maxDayTokens={maxDayTokens} />
    </section>
  )
}

function UsageDetailsHeader(props: {
  filters: UsageDetailsFilters
  devices: UserDevice[]
  selectedDevice?: UserDevice
  timezone?: string
  timezoneLabel?: string
}) {
  return (
    <header class="space-y-6">
      <div class="flex flex-col gap-2">
        <p class="app-folio-kicker">02 — 全量索引与结构化导出 · USAGE LEDGER</p>
        <h1 class="app-folio-h2 whitespace-nowrap">每日用量详情</h1>
        <p class="font-mono text-xs text-[var(--app-muted)]">
          {usageDetailsSubtitle(props.filters, props.selectedDevice)}
        </p>
        {props.timezone ? (
          <p class="font-mono text-xs text-[var(--app-subtle)]" data-usage-details-timezone="true">
            日期按 {props.timezone}
            {props.timezoneLabel ? `（${props.timezoneLabel}）` : ''} 的本地日历日归属。
          </p>
        ) : null}
      </div>
      <div class="border-y border-[var(--app-border)] bg-[var(--app-panel)] p-4">
        <UsageDetailsFiltersForm filters={props.filters} devices={props.devices} />
      </div>
    </header>
  )
}

function usageDetailsSubtitle(filters: UsageDetailsFilters, selectedDevice?: UserDevice) {
  return [
    `${filters.startDate} 至 ${filters.endDate}`,
    formatSource(filters.source),
    selectedDevice?.name,
    filters.modelQuery ? `模型包含 ${filters.modelQuery}` : null
  ]
    .filter(Boolean)
    .join(' · ')
}

function DailySummaryLedger(props: { dailyRows: UsageDetails['dailyRows']; maxDayTokens: number }) {
  const hasUsage = props.dailyRows.some((row) => row.totalTokens > 0)
  return (
    <section class="space-y-3">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 class="text-xl font-extrabold tracking-tight">每日汇总索引</h2>
          <p class="text-sm text-[var(--app-muted)]">按日期聚合；展开任意日期查看当天模型级明细。</p>
        </div>
        <span class="font-mono text-xs text-[var(--app-subtle)]">
          共 {props.dailyRows.length} 个日历日 · 点击行展开模型表
        </span>
      </div>

      {!hasUsage ? (
        <p class="border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-6 text-sm text-[var(--app-muted)]">
          当前筛选范围内没有用量。
        </p>
      ) : (
        <div class="border-t border-[var(--app-border-strong)]">
          <DailySummaryHeader />
          <div class="divide-y divide-[var(--app-border)] border-b border-[var(--app-border)]">
            {props.dailyRows.map((row) => (
              <DailySummaryRow row={row} maxDayTokens={props.maxDayTokens} />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function DailySummaryHeader() {
  return (
    <div class="hidden grid-cols-[1.15fr_1.15fr_1fr_0.7fr_0.85fr_0.65fr_1.3fr] gap-3 border-b border-[var(--app-border-strong)] px-3 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--app-muted)] md:grid">
      <span>日期</span>
      <span>Tokens / 相对峰占比</span>
      <span>不含缓存读</span>
      <span>缓存率</span>
      <span>费用</span>
      <span>Sessions</span>
      <span>来源</span>
    </div>
  )
}

function DailySummaryRow(props: { row: UsageDetails['dailyRows'][number]; maxDayTokens: number }) {
  return (
    <details class="group bg-transparent transition hover:bg-[var(--app-hover)] open:bg-[var(--app-panel)]">
      <DailySummaryRowHeader row={props.row} maxDayTokens={props.maxDayTokens} />
      <DailyModelRows rows={props.row.modelRows} />
    </details>
  )
}

function DailySummaryRowHeader(props: { row: UsageDetails['dailyRows'][number]; maxDayTokens: number }) {
  const barPct =
    props.maxDayTokens > 0 && props.row.totalTokens > 0
      ? Math.max(4, Math.round((props.row.totalTokens / props.maxDayTokens) * 100))
      : 0

  return (
    <summary class="grid cursor-pointer list-none gap-3 px-3 py-3.5 text-sm md:grid-cols-[1.15fr_1.15fr_1fr_0.7fr_0.85fr_0.65fr_1.3fr] md:items-center">
      <span class="flex items-center gap-2 font-mono font-bold">
        <span class="inline-flex h-5 w-5 items-center justify-center border border-[var(--app-border)] text-[var(--app-muted)] transition group-open:rotate-90 group-open:border-[var(--app-border-strong)] group-open:bg-[var(--app-text)] group-open:text-[var(--app-bg)]">
          <LucideIcon icon={ChevronRight} size={13} />
        </span>
        {props.row.usageDate}
      </span>
      <span class="grid gap-1 md:block">
        <span class="font-mono text-xs font-bold uppercase tracking-wide text-[var(--app-muted)] md:hidden">
          Tokens
        </span>
        <span class="font-mono font-bold tabular-nums">{formatInteger(props.row.totalTokens)}</span>
        <span class="mt-1 hidden h-1 w-full overflow-hidden bg-[var(--app-viz-neutral)] md:block">
          <span class={`app-viz-bar-2 block h-full w-[${barPct}%]`} />
        </span>
      </span>
      <MobileValue label="不含缓存读">{formatInteger(props.row.totalTokensWithoutCacheRead)}</MobileValue>
      <MobileValue label="缓存率">{formatPercentRate(props.row.cacheReadRate)}</MobileValue>
      <MobileValue label="费用">{formatCostWithAvailability(props.row.costUsd, props.row.sourceSplit)}</MobileValue>
      <MobileValue label="Sessions">{formatInteger(props.row.sessionCount)}</MobileValue>
      <div class="grid gap-1 md:block">
        <span class="font-mono text-xs font-bold uppercase tracking-wide text-[var(--app-muted)] md:hidden">来源</span>
        <SourceSplit
          sourceSplit={props.row.sourceSplit}
          totalTokens={props.row.totalTokens}
          totalTokensWithoutCacheRead={props.row.totalTokensWithoutCacheRead}
        />
      </div>
    </summary>
  )
}

function MobileValue(props: { label: string; children: string }) {
  return (
    <span class="grid gap-1 md:block">
      <span class="font-mono text-xs font-bold uppercase tracking-wide text-[var(--app-muted)] md:hidden">
        {props.label}
      </span>
      <span class="font-mono tabular-nums">{props.children}</span>
    </span>
  )
}

function SourceSplit(props: {
  sourceSplit: UsageDetails['dailyRows'][number]['sourceSplit']
  totalTokens: number
  totalTokensWithoutCacheRead: number
}) {
  if (props.sourceSplit.length === 0) {
    return <span class="font-mono text-xs text-[var(--app-muted)]">无用量</span>
  }

  return (
    <span class="flex min-w-0 flex-wrap gap-1.5">
      {props.sourceSplit.map((item) => (
        <span class="max-w-full break-words border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-2 py-0.5 font-mono text-[11px] text-[var(--app-muted)] [overflow-wrap:anywhere]">
          {formatSource(item.source)}{' '}
          <strong class="text-[var(--app-text)]">
            {formatPercent(item.totalTokensWithoutCacheRead, props.totalTokensWithoutCacheRead)}
          </strong>
          {' · 缓存率 '}
          {formatPercentRate(item.cacheReadRate)}
        </span>
      ))}
    </span>
  )
}

function DailyModelRows(props: { rows: UsageDetails['dailyRows'][number]['modelRows'] }) {
  return (
    <div class="border-t border-[var(--app-border)] bg-[var(--app-panel-strong)] p-4">
      {props.rows.length > 0 ? (
        <div class="overflow-x-auto">
          <Table class="min-w-[1060px]">
            <DailyModelRowsHeader />
            <DailyModelRowsBody rows={props.rows} />
          </Table>
        </div>
      ) : (
        <p class="border border-dashed border-[var(--app-border)] p-4 text-sm text-[var(--app-muted)]">
          当前日期没有匹配的模型明细。
        </p>
      )}
    </div>
  )
}

function DailyModelRowsHeader() {
  return (
    <TableHeader>
      <TableRow>
        <TableHead>来源</TableHead>
        <TableHead>模型</TableHead>
        <TableHead class="text-right">Input</TableHead>
        <TableHead class="text-right">Output</TableHead>
        <TableHead class="text-right">Cache 写入</TableHead>
        <TableHead class="text-right">Cache 读取</TableHead>
        <TableHead class="text-right">缓存率</TableHead>
        <TableHead class="text-right">不含缓存读</TableHead>
        <TableHead class="text-right">Total</TableHead>
        <TableHead class="text-right">费用</TableHead>
      </TableRow>
    </TableHeader>
  )
}

function DailyModelRowsBody(props: { rows: UsageDetails['dailyRows'][number]['modelRows'] }) {
  return (
    <TableBody>
      {props.rows.map((modelRow) => (
        <TableRow>
          <TableCell class="font-medium">{formatSource(modelRow.source)}</TableCell>
          <TableCell class="max-w-64 truncate font-mono text-xs">
            <span title={modelRow.model}>{modelRow.model}</span>
          </TableCell>
          <TableCell class="text-right font-mono tabular-nums">{formatInteger(modelRow.inputTokens)}</TableCell>
          <TableCell class="text-right font-mono tabular-nums">{formatInteger(modelRow.outputTokens)}</TableCell>
          <TableCell class="text-right font-mono tabular-nums">{formatInteger(modelRow.cacheCreationTokens)}</TableCell>
          <TableCell class="text-right font-mono tabular-nums">{formatInteger(modelRow.cacheReadTokens)}</TableCell>
          <TableCell class="text-right font-mono tabular-nums">{formatPercentRate(modelRow.cacheReadRate)}</TableCell>
          <TableCell class="text-right font-mono tabular-nums">
            {formatInteger(modelRow.totalTokensWithoutCacheRead)}
          </TableCell>
          <TableCell class="text-right font-mono font-bold tabular-nums">
            {formatInteger(modelRow.totalTokens)}
          </TableCell>
          <TableCell class="text-right font-mono tabular-nums">
            {formatCostWithAvailability(modelRow.costUsd, [modelRow])}
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  )
}
