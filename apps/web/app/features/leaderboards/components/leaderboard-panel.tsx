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
        <CardHeader class="flex-col gap-4 border-b border-[var(--app-border)] md:flex-row md:items-end md:justify-between">
          <div>
            <Badge>排行榜</Badge>
            <h1 class="mt-3 text-4xl font-black tracking-tight">{title}</h1>
          </div>
          <div class="flex flex-col gap-2 sm:flex-row">
            <SegmentedControl
              items={[
                {
                  label: '每日',
                  href: leaderboardHref('daily', props.metric),
                  active: props.period === 'daily'
                },
                {
                  label: '每月',
                  href: leaderboardHref('monthly', props.metric),
                  active: props.period === 'monthly'
                }
              ]}
            />
            <SegmentedControl
              items={[
                {
                  label: 'Tokens',
                  href: leaderboardHref(props.period, 'tokens'),
                  active: props.metric === 'tokens'
                },
                {
                  label: '费用',
                  href: leaderboardHref(props.period, 'cost'),
                  active: props.metric === 'cost'
                }
              ]}
            />
          </div>
        </CardHeader>
        <CardContent class="pt-5">
          <div class="overflow-x-auto">
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
                {props.entries.length > 0 ? (
                  props.entries.map((entry) => (
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
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      class="rounded-xl border border-dashed border-[var(--app-border)] py-8 text-center text-[var(--app-muted)]"
                      colSpan={4}
                    >
                      还没有公开排行榜数据。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
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
              'inline-flex h-auto items-center justify-center rounded-full px-3 py-1.5 text-xs font-black text-[var(--app-muted)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]'
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
