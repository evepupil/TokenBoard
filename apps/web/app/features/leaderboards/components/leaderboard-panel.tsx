import { Badge } from '../../../components/ui/badge'
import { Card, CardContent, CardHeader } from '../../../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table'
import { cn } from '../../../lib/cn'
import { formatUsd } from '../../../lib/money'
import type { LeaderboardEntry } from '../queries'

export type LeaderboardPanelProps = {
  entries: LeaderboardEntry[]
  period: 'daily' | 'monthly'
  metric: 'tokens' | 'cost'
}

export function LeaderboardPanel(props: LeaderboardPanelProps) {
  const title = `${props.period === 'monthly' ? '每月' : '每日'}${props.metric === 'cost' ? '费用' : ' token'}排名`

  return (
    <div data-leaderboard-panel="true">
      <Card class="mx-auto max-w-6xl rounded-2xl">
        <LeaderboardPanelHeader title={title} period={props.period} metric={props.metric} />
        <LeaderboardPanelContent entries={props.entries} />
      </Card>
    </div>
  )
}

function LeaderboardPanelHeader(props: {
  title: string
  period: 'daily' | 'monthly'
  metric: 'tokens' | 'cost'
}) {
  return (
    <CardHeader class="flex-col gap-4 border-b border-[var(--app-border)] md:flex-row md:items-end md:justify-between">
      <div>
        <Badge>排行榜</Badge>
        <h1 class="mt-3 text-4xl font-black tracking-tight">{props.title}</h1>
      </div>
      <div class="flex flex-col gap-2 sm:flex-row">
        <SegmentedControl items={periodItems(props.period, props.metric)} />
        <SegmentedControl items={metricItems(props.period, props.metric)} />
      </div>
    </CardHeader>
  )
}

function LeaderboardPanelContent(props: { entries: LeaderboardEntry[] }) {
  return (
    <CardContent class="pt-5">
      {props.entries.length > 0 ? (
        <>
          <div class="grid gap-3 md:hidden" data-leaderboard-mobile-list="true">
            {props.entries.map((entry) => (
              <LeaderboardMobileItem entry={entry} />
            ))}
          </div>
          <LeaderboardTable entries={props.entries} />
        </>
      ) : (
        <div
          class="rounded-xl border border-dashed border-[var(--app-border)] px-4 py-8 text-center text-sm text-[var(--app-muted)]"
          data-leaderboard-empty="true"
        >
          还没有公开排行榜数据。
        </div>
      )}
    </CardContent>
  )
}

function periodItems(period: 'daily' | 'monthly', metric: 'tokens' | 'cost') {
  return [
    { label: '每日', href: leaderboardHref('daily', metric), active: period === 'daily' },
    { label: '每月', href: leaderboardHref('monthly', metric), active: period === 'monthly' }
  ]
}

function metricItems(period: 'daily' | 'monthly', metric: 'tokens' | 'cost') {
  return [
    { label: 'Tokens', href: leaderboardHref(period, 'tokens'), active: metric === 'tokens' },
    { label: '费用', href: leaderboardHref(period, 'cost'), active: metric === 'cost' }
  ]
}

function LeaderboardMobileItem(props: { entry: LeaderboardEntry }) {
  return (
    <article class="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-xs font-black uppercase text-lime-300">#{props.entry.rank}</p>
          <h2 class="mt-1 truncate text-lg font-black">{props.entry.displayName}</h2>
        </div>
        <p class="shrink-0 text-sm font-bold text-[var(--app-muted)]">{formatUsd(props.entry.costUsd)}</p>
      </div>
      <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt class="text-xs font-bold uppercase text-[var(--app-muted)]">Tokens</dt>
          <dd class="mt-1 font-black">{formatInteger(props.entry.totalTokens)}</dd>
        </div>
        <div>
          <dt class="text-xs font-bold uppercase text-[var(--app-muted)]">费用</dt>
          <dd class="mt-1 font-black">{formatUsd(props.entry.costUsd)}</dd>
        </div>
      </dl>
    </article>
  )
}

function LeaderboardTable(props: { entries: LeaderboardEntry[] }) {
  return (
    <div class="hidden overflow-x-auto md:block" data-leaderboard-desktop-table="true">
      <Table class="min-w-[620px] border-separate border-spacing-y-2">
        <TableHeader>
          <TableRow class="border-0">
            <TableHead>排名</TableHead>
            <TableHead>用户</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>费用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.entries.map((entry) => (
            <TableRow class="border-0 bg-[var(--app-bg-soft)]">
              <TableCell class="rounded-l-xl font-black text-lime-300">
                #{entry.rank}
              </TableCell>
              <TableCell>{entry.displayName}</TableCell>
              <TableCell class="font-bold">{formatInteger(entry.totalTokens)}</TableCell>
              <TableCell class="rounded-r-xl text-[var(--app-muted)]">
                {formatUsd(entry.costUsd)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function leaderboardHref(period: 'daily' | 'monthly', metric: 'tokens' | 'cost') {
  return `/leaderboards?period=${period}&metric=${metric}`
}

function SegmentedControl(props: {
  items: Array<{ label: string; href: string; active: boolean }>
}) {
  return (
    <div class="flex rounded-full border border-[var(--app-border)] p-1 text-sm text-[var(--app-muted)]">
      {props.items.map((item) =>
        item.active ? (
          <Badge>{item.label}</Badge>
        ) : (
          <a
            class={cn(
              'inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-xs font-black text-[var(--app-muted)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]'
            )}
            href={item.href}
            data-leaderboard-link="true"
          >
            {item.label}
          </a>
        )
      )}
    </div>
  )
}
