import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { formatUsd } from '../../lib/money'
import { formatPercentRate } from '../../lib/usage-metrics'
import type { DailyReportHistoryItem } from './report-history'

export function DailyReportHistoryCard(props: {
  reportHistory: DailyReportHistoryItem[]
  retentionDays: number
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>历史日报</CardTitle>
        <CardDescription>保留最近 {props.retentionDays} 天的 token 日报快照。</CardDescription>
      </CardHeader>
      <CardContent>
        {props.reportHistory.length > 0 ? (
          <div class="overflow-x-auto">
            <Table class="min-w-[760px] border-separate border-spacing-y-2">
              <TableHeader>
                <TableRow class="border-0">
                  <TableHead>日期</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>不含缓存读</TableHead>
                  <TableHead>缓存率</TableHead>
                  <TableHead>费用</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead>生成时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.reportHistory.map((item) => <DailyReportHistoryRow item={item} />)}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p class="rounded-lg border border-dashed border-[var(--app-border)] p-4 text-sm text-[var(--app-muted)]">
            还没有历史日报。
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function DailyReportHistoryRow(props: { item: DailyReportHistoryItem }) {
  return (
    <TableRow class="border-0 bg-[var(--app-bg-soft)]">
      <TableCell class="rounded-l-xl font-bold">
        <div>{props.item.reportDate}</div>
        <div class="text-xs text-[var(--app-muted)]">{scheduleSlotLabel(props.item.scheduleSlot)}</div>
      </TableCell>
      <TableCell class="font-bold tabular-nums">{formatInteger(props.item.totalTokens)}</TableCell>
      <TableCell class="font-bold tabular-nums">
        {formatInteger(props.item.totalTokensWithoutCacheRead)}
      </TableCell>
      <TableCell class="font-bold tabular-nums">{formatPercentRate(props.item.cacheReadRate ?? 0)}</TableCell>
      <TableCell class="font-bold tabular-nums">{formatUsd(props.item.costUsd)}</TableCell>
      <TableCell class="font-bold tabular-nums">{formatInteger(props.item.sessionCount)}</TableCell>
      <TableCell class="rounded-r-xl text-xs text-[var(--app-muted)]">
        <div>{props.item.generatedAt}</div>
        <HistoryDetails item={props.item} />
      </TableCell>
    </TableRow>
  )
}

function HistoryDetails(props: { item: DailyReportHistoryItem }) {
  return (
    <details class="mt-2">
      <summary class="cursor-pointer font-bold text-[var(--app-text)]">明细</summary>
      <div class="mt-2 grid gap-2">
        <HistoryList
          title="主要来源"
          items={props.item.sourceSplit.map((source) => (
            `${formatSource(source.source)}: ${formatInteger(source.totalTokensWithoutCacheRead)} / ${formatInteger(source.totalTokens)} tokens, ${formatPercentRate(source.cacheReadRate ?? 0)}`
          ))}
        />
        <HistoryList
          title="主要模型"
          items={props.item.topModels.map((model) => (
            `${model.model}: ${formatInteger(model.totalTokensWithoutCacheRead)} / ${formatInteger(model.totalTokens)} tokens, ${formatUsd(model.costUsd)}`
          ))}
        />
      </div>
    </details>
  )
}

function HistoryList(props: { title: string; items: string[] }) {
  return (
    <div>
      <p class="font-bold text-[var(--app-muted)]">{props.title}</p>
      {props.items.length > 0 ? (
        <ul class="mt-1 space-y-1">
          {props.items.map((item) => <li class="break-words">{item}</li>)}
        </ul>
      ) : (
        <p class="mt-1 text-[var(--app-muted)]">暂无数据</p>
      )}
    </div>
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
  return scheduleSlot.includes('T') ? scheduleSlot.slice(scheduleSlot.indexOf('T') + 1) : scheduleSlot
}
