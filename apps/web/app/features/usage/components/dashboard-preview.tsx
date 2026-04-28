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
      <header class="relative overflow-hidden rounded-[1.75rem] border border-lime-200/10 bg-[radial-gradient(circle_at_85%_10%,rgba(190,242,100,.22),transparent_28%),linear-gradient(135deg,#171b12,#0b0d0a)] p-6">
        <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <Badge>Dashboard</Badge>
            <h1 class="mt-3 text-4xl font-black tracking-tight md:text-5xl">
              {props.userName ? `${props.userName}'s token board` : 'AI token usage board'}
            </h1>
            <p class="mt-3 text-sm text-stone-400">
              Last sync: {props.summary.lastSyncedAt ?? 'not synced yet'} / Devices: {props.summary.deviceCount}
            </p>
          </div>
          <LinkButton href="/settings/install">Connect a machine</LinkButton>
        </div>
      </header>

      <div class="grid gap-3 md:grid-cols-4">
        <Metric label="Today tokens" value={formatInteger(props.summary.todayTokens)} tone="lime" />
        <Metric label="Today cost" value={formatUsd(props.summary.todayCostUsd)} />
        <Metric label="Month tokens" value={formatInteger(props.summary.monthTokens)} />
        <Metric label="Month cost" value={formatUsd(props.summary.monthCostUsd)} />
      </div>

      <section class="grid gap-4 lg:grid-cols-[1.45fr_0.85fr]">
        <Card class="min-h-80">
          <CardHeader class="flex-row items-center justify-between gap-4">
            <div>
              <CardTitle>30 day trend</CardTitle>
              <CardDescription>Daily query wiring is the next backend slice.</CardDescription>
            </div>
            <Badge variant="outline">tokens</Badge>
          </CardHeader>
          <CardContent>
            <div class="flex h-44 items-end gap-2 rounded-2xl border border-dashed border-stone-800 bg-stone-900/50 p-4">
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
            <CardTitle>Source split</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4 text-sm text-stone-400">
            {props.summary.sourceSplit.length > 0 ? (
              props.summary.sourceSplit.map((item) => (
                <div>
                  <div class="flex items-center justify-between gap-4">
                    <span>{formatSource(item.source)}</span>
                    <span class="font-bold text-stone-100">
                      {formatPercent(item.totalTokens, totalSourceTokens)}
                    </span>
                  </div>
                  <div class="mt-2 h-2 overflow-hidden rounded-full bg-stone-800">
                    <div class="h-full rounded-full bg-lime-300" style={`width:${formatPercent(item.totalTokens, totalSourceTokens)}`} />
                  </div>
                </div>
              ))
            ) : (
              <p class="rounded-2xl border border-dashed border-stone-800 p-4">No usage uploaded yet.</p>
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
    <div class={`rounded-[1.35rem] border p-4 ${props.tone === 'lime' ? 'border-lime-300/40 bg-lime-300 text-stone-950' : 'border-stone-800 bg-stone-950/75 text-stone-50'}`}>
      <p class={`text-sm ${props.tone === 'lime' ? 'text-stone-700' : 'text-stone-500'}`}>{props.label}</p>
      <p class="mt-3 text-3xl font-black tracking-tight">{props.value}</p>
    </div>
  )
}
