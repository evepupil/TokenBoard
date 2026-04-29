import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
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
          <CardDescription>按日期聚合，保留范围内没有用量的日期。</CardDescription>
        </CardHeader>
        <CardContent>
          <div class="overflow-x-auto">
            <Table class="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>费用</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead>来源</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dailyRows.map((row) => (
                  <TableRow>
                    <TableCell class="font-bold">{row.usageDate}</TableCell>
                    <TableCell>{formatInteger(row.totalTokens)}</TableCell>
                    <TableCell>{formatUsd(row.costUsd)}</TableCell>
                    <TableCell>{formatInteger(row.sessionCount)}</TableCell>
                    <TableCell>
                      {row.sourceSplit.length > 0 ? (
                        <div class="flex flex-wrap gap-2">
                          {row.sourceSplit.map((item) => (
                            <span class="rounded-full border border-[var(--app-border)] px-2 py-1 text-xs text-[var(--app-muted)]">
                              {formatSource(item.source)} {formatPercent(item.totalTokens, row.totalTokens)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span class="text-[var(--app-subtle)]">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>模型明细</CardTitle>
          <CardDescription>按日期、来源和模型聚合。</CardDescription>
        </CardHeader>
        <CardContent>
          <div class="overflow-x-auto">
            <Table class="min-w-[1040px]">
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
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
                {props.details.modelRows.length > 0 ? (
                  props.details.modelRows.map((row) => (
                    <TableRow>
                      <TableCell class="font-bold">{row.usageDate}</TableCell>
                      <TableCell>{formatSource(row.source)}</TableCell>
                      <TableCell class="max-w-64 truncate">
                        <span title={row.model}>{row.model}</span>
                      </TableCell>
                      <TableCell>{formatInteger(row.inputTokens)}</TableCell>
                      <TableCell>{formatInteger(row.outputTokens)}</TableCell>
                      <TableCell>{formatInteger(row.cacheCreationTokens)}</TableCell>
                      <TableCell>{formatInteger(row.cacheReadTokens)}</TableCell>
                      <TableCell class="font-bold">{formatInteger(row.totalTokens)}</TableCell>
                      <TableCell>{formatUsd(row.costUsd)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      class="rounded-xl border border-dashed border-[var(--app-border)] py-8 text-center text-[var(--app-muted)]"
                      colSpan={9}
                    >
                      当前筛选范围没有模型明细。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </section>
  )
}

function UsageDetailsFiltersForm(props: { filters: UsageDetailsFilters }) {
  return (
    <form method="get" class="grid gap-3 sm:grid-cols-[160px_1fr_1fr_auto] lg:min-w-[680px]">
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
      <Button class="mt-7 h-11" type="submit">应用</Button>
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
