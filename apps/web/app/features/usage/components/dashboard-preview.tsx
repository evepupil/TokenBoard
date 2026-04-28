import { formatUsd } from '../../../lib/money'
import type { UsageSummary } from '../queries'

export function DashboardPreview(props: { summary: UsageSummary }) {
  const totalSourceTokens = props.summary.sourceSplit.reduce(
    (total, item) => total + item.totalTokens,
    0
  )

  return (
    <section class="mx-auto flex max-w-6xl flex-col gap-6">
      <header class="flex flex-col gap-4 border-b border-zinc-800 pb-6 md:flex-row md:items-end md:justify-between">
        <div class="flex flex-col gap-2">
          <p class="text-sm font-medium uppercase tracking-wide text-cyan-300">TokenBoard</p>
          <h1 class="text-3xl font-semibold">AI token usage board</h1>
          <p class="text-sm text-zinc-400">
            Last sync: {props.summary.lastSyncedAt ?? 'not synced yet'}
          </p>
        </div>
        <a class="w-fit rounded border border-cyan-400/60 px-3 py-2 text-sm font-medium text-cyan-200" href="/settings/install">
          Connect a machine
        </a>
      </header>

      <div class="grid gap-4 md:grid-cols-4">
        <Metric label="Today tokens" value={formatInteger(props.summary.todayTokens)} />
        <Metric label="Today cost" value={formatUsd(props.summary.todayCostUsd)} />
        <Metric label="Month tokens" value={formatInteger(props.summary.monthTokens)} />
        <Metric label="Month cost" value={formatUsd(props.summary.monthCostUsd)} />
      </div>

      <section class="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div class="min-h-72 rounded-lg border border-zinc-800 bg-zinc-900/70 p-5">
          <h2 class="text-base font-semibold">30 day trend</h2>
          <div class="mt-8 flex h-40 items-center justify-center rounded border border-dashed border-zinc-700 text-sm text-zinc-500">
            Trend chart is next after daily query wiring.
          </div>
        </div>
        <div class="min-h-72 rounded-lg border border-zinc-800 bg-zinc-900/70 p-5">
          <h2 class="text-base font-semibold">Source split</h2>
          <div class="mt-8 space-y-3 text-sm text-zinc-400">
            {props.summary.sourceSplit.length > 0 ? (
              props.summary.sourceSplit.map((item) => (
                <div class="flex items-center justify-between gap-4">
                  <span>{formatSource(item.source)}</span>
                  <span class="text-zinc-200">
                    {formatPercent(item.totalTokens, totalSourceTokens)}
                  </span>
                </div>
              ))
            ) : (
              <p>No usage uploaded yet.</p>
            )}
          </div>
        </div>
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

function Metric(props: { label: string; value: string }) {
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
      <p class="text-sm text-zinc-400">{props.label}</p>
      <p class="mt-3 text-2xl font-semibold text-zinc-50">{props.value}</p>
    </div>
  )
}
