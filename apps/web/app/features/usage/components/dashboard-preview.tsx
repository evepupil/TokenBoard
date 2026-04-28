import { formatUsd } from '../../../lib/money'

export function DashboardPreview() {
  return (
    <section class="mx-auto flex max-w-6xl flex-col gap-6">
      <header class="flex flex-col gap-2 border-b border-zinc-800 pb-6">
        <p class="text-sm font-medium uppercase tracking-wide text-cyan-300">TokenBoard</p>
        <h1 class="text-3xl font-semibold">AI token usage board</h1>
      </header>

      <div class="grid gap-4 md:grid-cols-4">
        <Metric label="Today tokens" value="0" />
        <Metric label="Today cost" value={formatUsd(0)} />
        <Metric label="Month tokens" value="0" />
        <Metric label="Month cost" value={formatUsd(0)} />
      </div>

      <section class="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div class="min-h-72 rounded-lg border border-zinc-800 bg-zinc-900/70 p-5">
          <h2 class="text-base font-semibold">30 day trend</h2>
          <div class="mt-8 h-40 rounded border border-dashed border-zinc-700" />
        </div>
        <div class="min-h-72 rounded-lg border border-zinc-800 bg-zinc-900/70 p-5">
          <h2 class="text-base font-semibold">Source split</h2>
          <div class="mt-8 space-y-3 text-sm text-zinc-400">
            <p>Claude Code: 0%</p>
            <p>Codex: 0%</p>
          </div>
        </div>
      </section>
    </section>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
      <p class="text-sm text-zinc-400">{props.label}</p>
      <p class="mt-3 text-2xl font-semibold text-zinc-50">{props.value}</p>
    </div>
  )
}

