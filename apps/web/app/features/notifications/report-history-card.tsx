import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { formatPercentRate } from '../../lib/usage-metrics'
import { formatCostWithAvailability, formatModelCostWithAvailability, formatSource } from '../usage/source-format'
import type { DailyReportHistoryItem } from './report-history-item'

export function DailyReportHistoryCard(props: {
  reportHistory: DailyReportHistoryItem[]
  dailyReportShareEnabled: boolean
  retentionDays: number
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>历史日报索引</CardTitle>
        <CardDescription>保留最近 {props.retentionDays} 天的 token 日报快照。</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <DailyReportShareSettings enabled={props.dailyReportShareEnabled} />
        {props.reportHistory.length > 0 ? (
          <div class="overflow-x-auto border-t border-[var(--app-border-strong)]">
            <Table class="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead class="text-right">Tokens</TableHead>
                  <TableHead class="text-right">不含缓存读</TableHead>
                  <TableHead class="text-right">缓存率</TableHead>
                  <TableHead class="text-right">费用</TableHead>
                  <TableHead class="text-right">Sessions</TableHead>
                  <TableHead>生成时间与操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.reportHistory.map((item) => (
                  <DailyReportHistoryRow item={item} />
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p class="border border-dashed border-[var(--app-border)] bg-[var(--app-bg-soft)] p-5 text-sm text-[var(--app-muted)]">
            还没有历史日报。
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function DailyReportShareSettings(props: { enabled: boolean }) {
  return (
    <form
      method="post"
      class="flex flex-col gap-3 border border-[var(--app-border)] bg-[var(--app-panel-strong)] p-4 sm:flex-row sm:items-center sm:justify-between"
      data-submit-feedback="true"
    >
      <input type="hidden" name="action" value="update-share-settings" />
      <label class="flex min-h-11 items-center gap-3 text-sm font-bold text-[var(--app-text)]">
        <input
          class="accent-[var(--app-accent-bar)]"
          type="checkbox"
          name="dailyReportShareEnabled"
          checked={props.enabled}
        />
        日报分享
      </label>
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
        <span class="font-mono text-xs text-[var(--app-muted)]">
          {props.enabled ? '未登录访问已允许' : '未登录访问已关闭'}
        </span>
        <Button type="submit" data-submitting-label="正在保存...">
          保存分享设置
        </Button>
      </div>
    </form>
  )
}

function DailyReportHistoryRow(props: { item: DailyReportHistoryItem }) {
  return (
    <TableRow>
      <TableCell class="font-mono font-bold">
        <div>{props.item.reportDate}</div>
        <div class="text-xs font-normal text-[var(--app-muted)]">{scheduleSlotLabel(props.item.scheduleSlot)}</div>
      </TableCell>
      <TableCell class="text-right font-mono font-bold tabular-nums">{formatInteger(props.item.totalTokens)}</TableCell>
      <TableCell class="text-right font-mono font-bold tabular-nums">
        {formatInteger(props.item.totalTokensWithoutCacheRead)}
      </TableCell>
      <TableCell class="text-right font-mono font-semibold tabular-nums">
        {formatPercentRate(props.item.cacheReadRate ?? 0)}
      </TableCell>
      <TableCell class="text-right font-mono font-semibold tabular-nums">{formatHistoryCost(props.item)}</TableCell>
      <TableCell class="text-right font-mono tabular-nums">{formatInteger(props.item.sessionCount)}</TableCell>
      <TableCell class="font-mono text-xs text-[var(--app-muted)]">
        <div>{props.item.generatedAt}</div>
        <a
          class="mt-2 inline-flex min-h-9 items-center border border-[var(--app-border-strong)] bg-[var(--app-panel-strong)] px-3 py-1.5 font-sans text-xs font-bold text-[var(--app-text)] transition hover:bg-[var(--app-text)] hover:text-[var(--app-bg)]"
          href={props.item.reportUrl}
        >
          查看
        </a>
        <ReportShareAction item={props.item} />
        <HistoryDetails item={props.item} />
      </TableCell>
    </TableRow>
  )
}

function ReportShareAction(props: { item: DailyReportHistoryItem }) {
  if (props.item.shareRevokedAt) {
    return <p class="mt-2 text-xs font-bold text-[var(--app-muted)]">分享已撤销</p>
  }

  return (
    <form method="post" class="mt-2" data-submit-feedback="true">
      <input type="hidden" name="action" value="revoke-report-share" />
      <input type="hidden" name="reportId" value={props.item.id} />
      <button
        class="app-danger-action inline-flex min-h-9 items-center border px-3 py-1.5 font-sans text-xs font-bold transition"
        type="submit"
        data-confirm="确认撤销这条日报的未登录访问？"
        data-submitting-label="正在撤销..."
        data-submitting-tone="danger"
      >
        撤销分享
      </button>
    </form>
  )
}

function HistoryDetails(props: { item: DailyReportHistoryItem }) {
  if (props.item.detailsParseError) {
    return <p class="app-danger-text mt-2 text-xs font-bold">历史明细格式异常，费用不可用，请重新生成日报。</p>
  }

  return (
    <details class="mt-2">
      <summary class="cursor-pointer font-sans font-bold text-[var(--app-text)]">明细</summary>
      <div class="mt-2 grid gap-2">
        <HistoryList
          title="主要来源"
          items={props.item.sourceSplit.map(
            (source) =>
              `${formatSource(source.source)}: ${formatInteger(source.totalTokensWithoutCacheRead)} / ${formatInteger(source.totalTokens)} tokens, ${formatPercentRate(source.cacheReadRate ?? 0)}`
          )}
        />
        <HistoryList
          title="主要模型"
          items={props.item.topModels.map(
            (model) =>
              `${model.model}: ${formatInteger(model.totalTokensWithoutCacheRead)} / ${formatInteger(model.totalTokens)} tokens, ${formatModelCostWithAvailability(model.costUsd, model.sourceSplit, props.item.sourceSplit)}`
          )}
        />
      </div>
    </details>
  )
}

function formatHistoryCost(item: DailyReportHistoryItem) {
  return item.detailsParseError
    ? '费用不可用（历史明细异常）'
    : formatCostWithAvailability(item.costUsd, item.sourceSplit)
}

function HistoryList(props: { title: string; items: string[] }) {
  return (
    <div>
      <p class="font-bold text-[var(--app-muted)]">{props.title}</p>
      {props.items.length > 0 ? (
        <ul class="mt-1 space-y-1">
          {props.items.map((item) => (
            <li class="break-words">{item}</li>
          ))}
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

function scheduleSlotLabel(scheduleSlot: string) {
  if (scheduleSlot === 'test-preview') return '测试预览'
  return scheduleSlot.includes('T') ? scheduleSlot.slice(scheduleSlot.indexOf('T') + 1) : scheduleSlot
}
