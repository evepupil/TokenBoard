import { Badge } from '../../../components/ui/badge'
import { Button, LinkButton } from '../../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table'
import { formatUsd } from '../../../lib/money'
import type { UsageDetails } from '../queries'
import type { UsageDetailsFilters } from '../service'

export function UsageDetailsPanel(props: {
  details: UsageDetails
  filters: UsageDetailsFilters
}) {
  const dailyRows = [...props.details.dailyRows].reverse()

  return (
    <section class="mx-auto flex max-w-6xl flex-col gap-5">
      <header class="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-xl shadow-black/10">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Badge>详情</Badge>
            <h1 class="mt-3 text-4xl font-black tracking-tight">每日用量详情</h1>
            <p class="mt-2 text-sm text-[var(--app-muted)]">
              {props.filters.startDate} 至 {props.filters.endDate} / {formatSource(props.filters.source)}
              {props.filters.modelQuery ? ` / 模型包含 ${props.filters.modelQuery}` : ''}
            </p>
          </div>
          <UsageDetailsFiltersForm filters={props.filters} />
        </div>
      </header>

      <div class="grid gap-3 md:grid-cols-4">
        <Metric label="范围 tokens" value={formatInteger(props.details.summary.totalTokens)} tone="lime" />
        <Metric label="范围费用" value={formatUsd(props.details.summary.costUsd)} />
        <Metric label="Sessions" value={formatInteger(props.details.summary.sessionCount)} />
        <Metric label="活跃天数" value={formatInteger(props.details.summary.activeDays)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>每日汇总</CardTitle>
          <CardDescription>按日期聚合；展开任意日期查看当天模型明细。</CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="hidden grid-cols-[1.1fr_1fr_0.8fr_0.7fr_1.2fr] gap-3 px-4 text-xs font-bold uppercase tracking-wide text-[var(--app-muted)] md:grid">
            <span>日期</span>
            <span>Tokens</span>
            <span>费用</span>
            <span>Sessions</span>
            <span>来源</span>
          </div>
          {dailyRows.map((row) => (
            <details class="group rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)]">
              <summary class="grid cursor-pointer list-none gap-3 p-4 text-sm md:grid-cols-[1.1fr_1fr_0.8fr_0.7fr_1.2fr] md:items-center">
                <span class="flex items-center gap-2 font-bold">
                  <span class="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--app-border)] text-xs text-[var(--app-muted)] transition group-open:rotate-90">›</span>
                  {row.usageDate}
                </span>
                <span>{formatInteger(row.totalTokens)}</span>
                <span>{formatUsd(row.costUsd)}</span>
                <span>{formatInteger(row.sessionCount)}</span>
                <span>
                  {row.sourceSplit.length > 0 ? (
                    <span class="flex flex-wrap gap-2">
                      {row.sourceSplit.map((item) => (
                        <span class="rounded-full border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-muted)]">
                          {formatSource(item.source)} {formatPercent(item.totalTokens, row.totalTokens)}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span class="text-[var(--app-subtle)]">无用量</span>
                  )}
                </span>
              </summary>
              <div class="border-t border-[var(--app-border)] p-4">
                {row.modelRows.length > 0 ? (
                  <div class="overflow-x-auto">
                    <Table class="min-w-[920px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>来源</TableHead>
                          <TableHead>模型</TableHead>
                          <TableHead>Input</TableHead>
                          <TableHead>Output</TableHead>
                          <TableHead>Cache 写入</TableHead>
                          <TableHead>Cache 读取</TableHead>
                          <TableHead>Total</TableHead>
                          <TableHead>费用</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {row.modelRows.map((modelRow) => (
                          <TableRow>
                            <TableCell>{formatSource(modelRow.source)}</TableCell>
                            <TableCell class="max-w-64 truncate">
                              <span title={modelRow.model}>{modelRow.model}</span>
                            </TableCell>
                            <TableCell>{formatInteger(modelRow.inputTokens)}</TableCell>
                            <TableCell>{formatInteger(modelRow.outputTokens)}</TableCell>
                            <TableCell>{formatInteger(modelRow.cacheCreationTokens)}</TableCell>
                            <TableCell>{formatInteger(modelRow.cacheReadTokens)}</TableCell>
                            <TableCell class="font-bold">{formatInteger(modelRow.totalTokens)}</TableCell>
                            <TableCell>{formatUsd(modelRow.costUsd)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p class="rounded-lg border border-dashed border-[var(--app-border)] p-4 text-sm text-[var(--app-muted)]">
                    当前日期没有匹配的模型明细。
                  </p>
                )}
              </div>
            </details>
          ))}
        </CardContent>
      </Card>
    </section>
  )
}

function UsageDetailsFiltersForm(props: { filters: UsageDetailsFilters }) {
  return (
    <form method="get" class="grid gap-3 sm:grid-cols-2 lg:min-w-[760px] lg:grid-cols-[150px_1fr_1fr_1fr_auto_auto]">
      <label class="text-sm font-bold text-[var(--app-muted)]">
        来源
        <select
          class="mt-2 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-[var(--app-text)] outline-none transition focus:border-lime-300 focus:ring-2 focus:ring-lime-300/20"
          name="source"
        >
          <option value="all" selected={props.filters.source === 'all'}>全部</option>
          <option value="claude-code" selected={props.filters.source === 'claude-code'}>Claude Code</option>
          <option value="codex" selected={props.filters.source === 'codex'}>Codex</option>
        </select>
      </label>
      <label class="text-sm font-bold text-[var(--app-muted)]">
        开始日期
        <input
          class="mt-2 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-[var(--app-text)] outline-none transition focus:border-lime-300 focus:ring-2 focus:ring-lime-300/20"
          name="startDate"
          type="date"
          value={props.filters.startDate}
        />
      </label>
      <label class="text-sm font-bold text-[var(--app-muted)]">
        结束日期
        <input
          class="mt-2 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-[var(--app-text)] outline-none transition focus:border-lime-300 focus:ring-2 focus:ring-lime-300/20"
          name="endDate"
          type="date"
          value={props.filters.endDate}
        />
      </label>
      <label class="text-sm font-bold text-[var(--app-muted)]">
        模型
        <input
          class="mt-2 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-[var(--app-text)] outline-none transition placeholder:text-[var(--app-subtle)] focus:border-lime-300 focus:ring-2 focus:ring-lime-300/20"
          name="model"
          placeholder="sonnet"
          value={props.filters.modelQuery}
        />
      </label>
      <Button class="mt-7 h-11" type="submit">应用</Button>
      <LinkButton class="mt-7 h-11" variant="secondary" href={csvHref(props.filters)}>CSV</LinkButton>
    </form>
  )
}

function Metric(props: { label: string; value: string; tone?: 'lime' }) {
  return (
    <div class={`rounded-lg border p-4 ${props.tone === 'lime' ? 'border-lime-300/40 bg-lime-300 text-stone-950' : 'border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)]'}`}>
      <p class={`text-sm ${props.tone === 'lime' ? 'text-stone-700' : 'text-[var(--app-muted)]'}`}>{props.label}</p>
      <p class="mt-3 text-3xl font-black tracking-tight">{props.value}</p>
    </div>
  )
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatSource(source: string) {
  if (source === 'claude-code') return 'Claude Code'
  if (source === 'codex') return 'Codex'
  return '全部来源'
}

function formatPercent(value: number, total: number) {
  if (total <= 0) return '0%'
  return `${Math.round((value / total) * 100)}%`
}

function csvHref(filters: UsageDetailsFilters) {
  const params = new URLSearchParams({
    source: filters.source,
    startDate: filters.startDate,
    endDate: filters.endDate
  })
  if (filters.modelQuery) {
    params.set('model', filters.modelQuery)
  }
  return `/dashboard/details.csv?${params.toString()}`
}
