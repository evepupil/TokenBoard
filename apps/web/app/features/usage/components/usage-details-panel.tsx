import { ChevronRight } from 'lucide'
import { Badge } from '../../../components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card'
import { LucideIcon } from '../../../components/ui/icon'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table'
import { formatUsd } from '../../../lib/money'
import { formatPercentRate } from '../../../lib/usage-metrics'
import type { UserDevice } from '../../device/service'
import type { UsageDetails } from '../queries'
import type { UsageDetailsFilters } from '../service'
import { UsageMetricCard, UsageMetricGrid } from './usage-metric-card'
import { UsageDetailsFiltersForm } from './usage-details-filters'
import { formatInteger, formatPercent, formatSource } from './usage-details-format'
import { formatUsageMetricInteger, formatUsageMetricUsd } from './usage-metric-format'

export function UsageDetailsPanel(props: { details: UsageDetails; filters: UsageDetailsFilters; devices: UserDevice[] }) {
  const dailyRows = [...props.details.dailyRows].reverse()
  const selectedDevice = props.devices.find((device) => device.id === props.filters.deviceId)

  return (
    <section class="mx-auto flex max-w-7xl flex-col gap-5">
      <UsageDetailsHeader filters={props.filters} devices={props.devices} selectedDevice={selectedDevice} />

      <UsageMetricGrid columns={3}>
        <UsageMetricCard label="范围 tokens" value={formatUsageMetricInteger(props.details.summary.totalTokens)} tone="lime" />
        <UsageMetricCard label="不含缓存读" value={formatUsageMetricInteger(props.details.summary.totalTokensWithoutCacheRead)} />
        <UsageMetricCard label="缓存率" value={formatPercentRate(props.details.summary.cacheReadRate)} />
        <UsageMetricCard label="范围费用" value={formatUsageMetricUsd(props.details.summary.costUsd)} />
        <UsageMetricCard label="Sessions" value={formatUsageMetricInteger(props.details.summary.sessionCount)} />
        <UsageMetricCard label="活跃天数" value={formatUsageMetricInteger(props.details.summary.activeDays)} />
      </UsageMetricGrid>

      <DailySummaryCard dailyRows={dailyRows} />
    </section>
  )
}

function UsageDetailsHeader(props: { filters: UsageDetailsFilters; devices: UserDevice[]; selectedDevice?: UserDevice }) {
  return (
    <header class="app-surface-raised rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
      <div class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <Badge>详情</Badge>
          <h1 class="mt-3 whitespace-nowrap text-3xl font-black tracking-tight sm:text-4xl">每日用量详情</h1>
          <p class="mt-2 text-sm text-[var(--app-muted)]">
            {usageDetailsSubtitle(props.filters, props.selectedDevice)}
          </p>
        </div>
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
  ].filter(Boolean).join(' / ')
}

function DailySummaryCard(props: { dailyRows: UsageDetails['dailyRows'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>每日汇总</CardTitle>
        <CardDescription>按日期聚合；展开任意日期查看当天模型明细。</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <DailySummaryHeader />
        {props.dailyRows.map((row) => (
          <DailySummaryRow row={row} />
        ))}
      </CardContent>
    </Card>
  )
}

function DailySummaryHeader() {
  return (
    <div class="hidden grid-cols-[1.1fr_1fr_1fr_0.75fr_0.8fr_0.7fr_1.2fr] gap-3 px-4 text-xs font-bold uppercase tracking-wide text-[var(--app-muted)] md:grid">
      <span>日期</span>
      <span>Tokens</span>
      <span>不含缓存读</span>
      <span>缓存率</span>
      <span>费用</span>
      <span>Sessions</span>
      <span>来源</span>
    </div>
  )
}

function DailySummaryRow(props: { row: UsageDetails['dailyRows'][number] }) {
  return (
    <details class="app-surface-subtle group rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)]">
      <DailySummaryRowHeader row={props.row} />
      <DailyModelRows rows={props.row.modelRows} />
    </details>
  )
}

function DailySummaryRowHeader(props: { row: UsageDetails['dailyRows'][number] }) {
  return (
    <summary class="grid cursor-pointer list-none gap-3 p-4 text-sm md:grid-cols-[1.1fr_1fr_1fr_0.75fr_0.8fr_0.7fr_1.2fr] md:items-center">
      <span class="flex items-center gap-2 font-bold">
        <span class="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--app-border)] text-[var(--app-muted)] transition group-open:rotate-90">
          <LucideIcon icon={ChevronRight} size={14} />
        </span>
        {props.row.usageDate}
      </span>
      <MobileValue label="Tokens">{formatInteger(props.row.totalTokens)}</MobileValue>
      <MobileValue label="不含缓存读">{formatInteger(props.row.totalTokensWithoutCacheRead)}</MobileValue>
      <MobileValue label="缓存率">{formatPercentRate(props.row.cacheReadRate)}</MobileValue>
      <MobileValue label="费用">{formatUsd(props.row.costUsd)}</MobileValue>
      <MobileValue label="Sessions">{formatInteger(props.row.sessionCount)}</MobileValue>
      <div class="grid gap-1 md:block">
        <span class="text-xs font-bold uppercase tracking-wide text-[var(--app-muted)] md:hidden">来源</span>
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
      <span class="text-xs font-bold uppercase tracking-wide text-[var(--app-muted)] md:hidden">{props.label}</span>
      <span>{props.children}</span>
    </span>
  )
}

function SourceSplit(props: {
  sourceSplit: UsageDetails['dailyRows'][number]['sourceSplit']
  totalTokens: number
  totalTokensWithoutCacheRead: number
}) {
  if (props.sourceSplit.length === 0) {
    return <span class="text-[var(--app-muted)]">无用量</span>
  }

  return (
    <span class="flex flex-wrap gap-2">
      {props.sourceSplit.map((item) => (
        <span class="rounded-full border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-muted)]">
          {formatSource(item.source)} {formatPercent(item.totalTokensWithoutCacheRead, props.totalTokensWithoutCacheRead)}
          {' · '}
          缓存率 {formatPercentRate(item.cacheReadRate)}
        </span>
      ))}
    </span>
  )
}

function DailyModelRows(props: { rows: UsageDetails['dailyRows'][number]['modelRows'] }) {
  return (
    <div class="border-t border-[var(--app-border)] p-4">
      {props.rows.length > 0 ? (
        <div class="overflow-x-auto">
          <Table class="min-w-[1100px]">
            <DailyModelRowsHeader />
            <DailyModelRowsBody rows={props.rows} />
          </Table>
        </div>
      ) : (
        <p class="app-surface-subtle rounded-lg border border-dashed border-[var(--app-border)] p-4 text-sm text-[var(--app-muted)]">
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
        <TableHead>Input</TableHead>
        <TableHead>Output</TableHead>
        <TableHead>Cache 写入</TableHead>
        <TableHead>Cache 读取</TableHead>
        <TableHead>缓存率</TableHead>
        <TableHead>不含缓存读</TableHead>
        <TableHead>Total</TableHead>
        <TableHead>费用</TableHead>
      </TableRow>
    </TableHeader>
  )
}

function DailyModelRowsBody(props: { rows: UsageDetails['dailyRows'][number]['modelRows'] }) {
  return (
    <TableBody>
      {props.rows.map((modelRow) => (
        <TableRow>
          <TableCell>{formatSource(modelRow.source)}</TableCell>
          <TableCell class="max-w-64 truncate">
            <span title={modelRow.model}>{modelRow.model}</span>
          </TableCell>
          <TableCell>{formatInteger(modelRow.inputTokens)}</TableCell>
          <TableCell>{formatInteger(modelRow.outputTokens)}</TableCell>
          <TableCell>{formatInteger(modelRow.cacheCreationTokens)}</TableCell>
          <TableCell>{formatInteger(modelRow.cacheReadTokens)}</TableCell>
          <TableCell>{formatPercentRate(modelRow.cacheReadRate)}</TableCell>
          <TableCell>{formatInteger(modelRow.totalTokensWithoutCacheRead)}</TableCell>
          <TableCell class="font-bold">{formatInteger(modelRow.totalTokens)}</TableCell>
          <TableCell>{formatUsd(modelRow.costUsd)}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  )
}
