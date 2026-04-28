import { Badge } from '../../../components/ui/badge'
import { LinkButton } from '../../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card'
import { formatUsd } from '../../../lib/money'
import type { UsageSummary } from '../queries'

export function DashboardPreview(props: { summary: UsageSummary; userName?: string }) {
  const totalSourceTokens = props.summary.sourceSplit.reduce(
    (total, item) => total + item.totalTokens,
    0
  )

  return (
    <section class="mx-auto flex max-w-6xl flex-col gap-5">
      <header class="relative overflow-hidden rounded-2xl border border-lime-200/20 bg-[radial-gradient(circle_at_85%_10%,rgba(190,242,100,.24),transparent_28%),linear-gradient(135deg,var(--app-panel-strong),var(--app-bg-soft))] p-6">
        <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <Badge>控制台</Badge>
            <h1 class="mt-3 text-4xl font-black tracking-tight md:text-5xl">
              {props.userName ? `${props.userName} 的 token 面板` : 'AI token 使用面板'}
            </h1>
            <p class="mt-3 text-sm text-[var(--app-muted)]">
              最近同步：{props.summary.lastSyncedAt ?? '尚未同步'} / 设备数：{props.summary.deviceCount}
            </p>
          </div>
          <LinkButton href="/settings/install">连接设备</LinkButton>
        </div>
      </header>

      <div class="grid gap-3 md:grid-cols-4">
        <Metric label="今日 tokens" value={formatInteger(props.summary.todayTokens)} tone="lime" />
        <Metric label="今日费用" value={formatUsd(props.summary.todayCostUsd)} />
        <Metric label="本月 tokens" value={formatInteger(props.summary.monthTokens)} />
        <Metric label="本月费用" value={formatUsd(props.summary.monthCostUsd)} />
      </div>

      <section class="grid gap-4 lg:grid-cols-[1.45fr_0.85fr]">
        <Card class="min-h-80">
          <CardHeader class="flex-row items-center justify-between gap-4">
            <div>
              <CardTitle>30 天趋势</CardTitle>
              <CardDescription>下一步会接入真实每日查询。</CardDescription>
            </div>
            <Badge variant="outline">tokens</Badge>
          </CardHeader>
          <CardContent>
            <div class="flex h-44 items-end gap-2 rounded-md border border-dashed border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
              {Array.from({ length: 18 }).map((_, index) => (
                <div class="flex flex-1 items-end">
                  <div class="w-full rounded-t bg-lime-300/70" style={`height:${20 + ((index * 17) % 70)}%`} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>来源占比</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4 text-sm text-[var(--app-muted)]">
            {props.summary.sourceSplit.length > 0 ? (
              props.summary.sourceSplit.map((item) => (
                <div>
                  <div class="flex items-center justify-between gap-4">
                    <span>{formatSource(item.source)}</span>
                    <span class="font-bold text-[var(--app-text)]">
                      {formatPercent(item.totalTokens, totalSourceTokens)}
                    </span>
                  </div>
                  <div class="mt-2 h-2 overflow-hidden rounded-full bg-[var(--app-border)]">
                    <div class="h-full rounded-full bg-lime-300" style={`width:${formatPercent(item.totalTokens, totalSourceTokens)}`} />
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

function Metric(props: { label: string; value: string; tone?: 'lime' }) {
  return (
    <div class={`rounded-lg border p-4 ${props.tone === 'lime' ? 'border-lime-300/40 bg-lime-300 text-stone-950' : 'border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)]'}`}>
      <p class={`text-sm ${props.tone === 'lime' ? 'text-stone-700' : 'text-[var(--app-muted)]'}`}>{props.label}</p>
      <p class="mt-3 text-3xl font-black tracking-tight">{props.value}</p>
    </div>
  )
}
