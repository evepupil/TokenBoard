import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table'
import { cn } from '../../../lib/cn'
import { formatUsd } from '../../../lib/money'
import { formatPercentRate } from '../../../lib/usage-metrics'
import type { LeaderboardEntry, LeaderboardSourceBreakdown } from '../queries'
import { costUnavailableSourceNames, formatSource } from '../../usage/source-format'

type LeaderboardMetric = 'tokens' | 'tokens-without-cache-read' | 'cost'

export type LeaderboardPanelProps = {
  entries: LeaderboardEntry[]
  period: 'daily' | 'monthly'
  metric: LeaderboardMetric
  rangeLabel: string
  timezone: string
  timezoneLabel: string
  limit: number
}

export function LeaderboardPanel(props: LeaderboardPanelProps) {
  const title = `${props.period === 'monthly' ? '每月' : '每日'}${metricTitle(props.metric)}排名`
  const truncated = props.entries.length >= props.limit

  return (
    <div data-leaderboard-panel="true">
      <section class="app-folio-container space-y-8 pb-14">
        <LeaderboardPanelHeader
          title={title}
          period={props.period}
          metric={props.metric}
          rangeLabel={props.rangeLabel}
          timezone={props.timezone}
          timezoneLabel={props.timezoneLabel}
          entryCount={props.entries.length}
        />
        <LeaderboardPanelContent
          entries={props.entries}
          metric={props.metric}
          limit={props.limit}
          truncated={truncated}
        />
      </section>
    </div>
  )
}

function LeaderboardPanelHeader(props: {
  title: string
  period: 'daily' | 'monthly'
  metric: LeaderboardMetric
  rangeLabel: string
  timezone: string
  timezoneLabel: string
  entryCount: number
}) {
  return (
    <header class="space-y-6">
      <div class="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div class="min-w-0">
          <p class="app-folio-kicker">02 — 公开算力榜单 · PUBLIC LEADERBOARD</p>
          <h1 class="app-folio-h2 mt-2">{props.title}</h1>
          <LeaderboardRangeCaption
            period={props.period}
            rangeLabel={props.rangeLabel}
            timezone={props.timezone}
            timezoneLabel={props.timezoneLabel}
          />
        </div>
        <div class="flex w-full flex-col gap-2.5 sm:w-auto sm:flex-row sm:items-center">
          <SegmentedControl group="period" items={periodItems(props.period, props.metric)} />
          <SegmentedControl group="metric" items={metricItems(props.period, props.metric)} />
        </div>
      </div>

      <div class="flex flex-col justify-between gap-2 border-t border-[var(--app-border)] pt-3 text-xs text-[var(--app-muted)] sm:flex-row sm:items-center">
        <p class="max-w-3xl leading-5">
          {costUnavailableSourceNames().join('、')} 费用不可用，费用列和费用排名不包含这些来源成本。主要模型和来源占比按
          total token 计算。
        </p>
        <span class="shrink-0 font-mono text-[var(--app-subtle)]">INDEX · {props.entryCount} 名公开贡献者</span>
      </div>
    </header>
  )
}

function LeaderboardRangeCaption(props: {
  period: 'daily' | 'monthly'
  rangeLabel: string
  timezone: string
  timezoneLabel: string
}) {
  const rangeText = props.period === 'monthly' ? `${props.rangeLabel} 当月` : `${props.rangeLabel} 当天`

  return (
    <div class="mt-3 flex flex-col gap-1" data-leaderboard-range="true">
      <p class="font-mono text-xs font-bold text-[var(--app-text)]">
        统计范围：{rangeText}
        <span class="ml-2 font-normal text-[var(--app-muted)]">
          （{props.timezone}，{props.timezoneLabel}）
        </span>
      </p>
      <p class="max-w-2xl text-xs text-[var(--app-subtle)]">
        每位用户的用量按各自本地时区归属到日期，跨时区对比时同一天的绝对时间窗口并不完全重合。
      </p>
    </div>
  )
}

function LeaderboardPanelContent(props: {
  entries: LeaderboardEntry[]
  metric: LeaderboardMetric
  limit: number
  truncated: boolean
}) {
  const topThree = props.entries.slice(0, 3)
  const leaderMetricValue = props.entries.length > 0 ? metricNumericValue(props.entries[0], props.metric) : 0

  return (
    <div class="space-y-8">
      {props.entries.length > 0 ? (
        <>
          {/* Editorial Top-3 Podium Strip */}
          {topThree.length > 0 ? (
            <div class="grid grid-cols-1 gap-px border-y border-[var(--app-border-strong)] bg-[var(--app-border)] md:grid-cols-3">
              {topThree.map((entry, idx) => (
                <div
                  key={entry.slug}
                  class={cn(
                    'flex flex-col justify-between p-5',
                    idx === 0 ? 'app-metric-card-primary bg-[var(--app-panel-strong)]' : 'bg-[var(--app-panel)]'
                  )}
                >
                  <div>
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-mono text-xs font-bold text-[var(--app-muted)]">
                        RANK #{String(entry.rank).padStart(2, '0')}
                      </span>
                      <span class="font-mono text-xs text-[var(--app-subtle)]">
                        缓存率 {formatPercentRate(entry.cacheReadRate)}
                      </span>
                    </div>
                    <p class="mt-3 truncate text-lg font-extrabold tracking-tight text-[var(--app-text)]">
                      {entry.displayName}
                    </p>
                    <p class="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-[var(--app-text)] xl:text-4xl">
                      {formatPrimaryMetric(entry, props.metric)}
                    </p>
                  </div>
                  <div class="mt-4 flex items-center justify-between gap-2 border-t border-[var(--app-border)] pt-3 font-mono text-[11px] text-[var(--app-muted)]">
                    <span class="truncate" title={entry.primaryModel ?? ''}>
                      {formatPrimaryModel(entry.primaryModel)}
                    </span>
                    <span class="app-accent-text shrink-0 font-bold">{formatLeaderboardCost(entry)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div class="grid gap-3 md:hidden" data-leaderboard-mobile-list="true">
            {props.entries.map((entry) => (
              <LeaderboardMobileItem entry={entry} />
            ))}
          </div>

          <LeaderboardTable entries={props.entries} metric={props.metric} leaderValue={leaderMetricValue} />

          {props.truncated ? (
            <p class="font-mono text-xs text-[var(--app-subtle)]" data-leaderboard-truncated="true">
              仅显示前 {props.limit} 名。榜单按排名截断，未上榜不代表没有用量。
            </p>
          ) : null}
        </>
      ) : (
        <div
          class="border border-dashed border-[var(--app-border-strong)] bg-[var(--app-panel)] px-6 py-12 text-center"
          data-leaderboard-empty="true"
        >
          <p class="font-mono text-xs uppercase tracking-wider text-[var(--app-subtle)]">EMPTY LEDGER</p>
          <p class="mt-2 text-base font-bold text-[var(--app-text)]">还没有公开排行榜数据。</p>
          <p class="mt-1 text-sm text-[var(--app-muted)]">
            使用 GitHub 登录后开启公开资料并同步本机采集器，即可出现在当日或当月公开榜单中。
          </p>
        </div>
      )}
    </div>
  )
}

function periodItems(period: 'daily' | 'monthly', metric: LeaderboardMetric) {
  return [
    { label: '每日', value: 'daily', href: leaderboardHref('daily', metric), active: period === 'daily' },
    { label: '每月', value: 'monthly', href: leaderboardHref('monthly', metric), active: period === 'monthly' }
  ]
}

function metricItems(period: 'daily' | 'monthly', metric: LeaderboardMetric) {
  return [
    { label: 'Tokens', value: 'tokens', href: leaderboardHref(period, 'tokens'), active: metric === 'tokens' },
    {
      label: '不含缓存读',
      value: 'tokens-without-cache-read',
      href: leaderboardHref(period, 'tokens-without-cache-read'),
      active: metric === 'tokens-without-cache-read'
    },
    { label: '费用', value: 'cost', href: leaderboardHref(period, 'cost'), active: metric === 'cost' }
  ]
}

function LeaderboardMobileItem(props: { entry: LeaderboardEntry }) {
  return (
    <article
      class={cn(
        'border border-[var(--app-border)] bg-[var(--app-panel)] p-4',
        props.entry.isCurrentViewer && 'app-current-viewer-row app-current-viewer-marker'
      )}
      data-leaderboard-entry="true"
      data-leaderboard-current-user={props.entry.isCurrentViewer ? 'true' : undefined}
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <RankBadge rank={props.entry.rank} />
            <CurrentViewerBadge isCurrentViewer={props.entry.isCurrentViewer} />
          </div>
          <h2 class="mt-2 truncate text-lg font-extrabold">{props.entry.displayName}</h2>
        </div>
        <p class="shrink-0 font-mono text-sm font-bold text-[var(--app-muted)]">{formatLeaderboardCost(props.entry)}</p>
      </div>
      <dl class="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--app-border)] pt-3 text-sm">
        <div class="min-w-0">
          <dt class="font-mono text-[11px] font-bold uppercase text-[var(--app-muted)]">Tokens</dt>
          <dd class="mt-1 break-words font-mono font-bold tabular-nums">{formatInteger(props.entry.totalTokens)}</dd>
        </div>
        <div class="min-w-0">
          <dt class="font-mono text-[11px] font-bold uppercase text-[var(--app-muted)]">不含缓存读</dt>
          <dd class="mt-1 break-words font-mono font-bold tabular-nums">
            {formatInteger(props.entry.totalTokensWithoutCacheRead)}
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="font-mono text-[11px] font-bold uppercase text-[var(--app-muted)]">费用</dt>
          <dd class="mt-1 break-words font-mono font-bold tabular-nums">{formatLeaderboardCost(props.entry)}</dd>
        </div>
        <div class="min-w-0">
          <dt class="font-mono text-[11px] font-bold uppercase text-[var(--app-muted)]">缓存率</dt>
          <dd class="mt-1 break-words font-mono font-bold tabular-nums">
            {formatPercentRate(props.entry.cacheReadRate)}
          </dd>
        </div>
      </dl>
      <dl class="mt-3 grid grid-cols-1 gap-3 border-t border-[var(--app-border)] pt-3 text-sm">
        <div class="min-w-0">
          <dt class="font-mono text-[11px] font-bold uppercase text-[var(--app-muted)]">主要模型</dt>
          <dd class="mt-1 break-words font-mono text-xs font-bold [overflow-wrap:anywhere]">
            {formatPrimaryModel(props.entry.primaryModel)}
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="font-mono text-[11px] font-bold uppercase text-[var(--app-muted)]">来源占比</dt>
          <dd class="mt-1">
            <LeaderboardSourceShare breakdown={props.entry.sourceBreakdown} />
          </dd>
        </div>
      </dl>
    </article>
  )
}

function LeaderboardTable(props: { entries: LeaderboardEntry[]; metric: LeaderboardMetric; leaderValue: number }) {
  return (
    <div
      class="hidden overflow-x-auto border-t border-[var(--app-border-strong)] md:block"
      data-leaderboard-desktop-table="true"
    >
      <Table class="min-w-[920px]">
        <TableHeader>
          <TableRow>
            <TableHead>排名</TableHead>
            <TableHead>用户</TableHead>
            <TableHead>主要模型</TableHead>
            <TableHead>来源占比</TableHead>
            <TableHead class="text-right">相对占比</TableHead>
            <TableHead class="text-right">Tokens</TableHead>
            <TableHead class="text-right">不含缓存读</TableHead>
            <TableHead class="text-right">缓存率</TableHead>
            <TableHead class="text-right">费用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.entries.map((entry) => {
            const relativePct =
              props.leaderValue > 0
                ? Math.max(
                    2,
                    Math.min(100, Math.round((metricNumericValue(entry, props.metric) / props.leaderValue) * 100))
                  )
                : 0
            return (
              <TableRow class={cn(entry.isCurrentViewer && 'app-current-viewer-row')}>
                <TableCell class={cn(entry.isCurrentViewer && 'app-current-viewer-marker')}>
                  <div
                    class="flex flex-wrap items-center gap-2"
                    data-leaderboard-entry="true"
                    data-leaderboard-current-user={entry.isCurrentViewer ? 'true' : undefined}
                  >
                    <RankBadge rank={entry.rank} />
                    <CurrentViewerBadge isCurrentViewer={entry.isCurrentViewer} />
                  </div>
                </TableCell>
                <TableCell class="font-bold text-[var(--app-text)]">{entry.displayName}</TableCell>
                <TableCell class="max-w-[16rem]">
                  <span
                    class="block break-words font-mono text-xs font-semibold [overflow-wrap:anywhere]"
                    title={entry.primaryModel ?? ''}
                  >
                    {formatPrimaryModel(entry.primaryModel)}
                  </span>
                </TableCell>
                <TableCell class="align-top">
                  <LeaderboardSourceShare breakdown={entry.sourceBreakdown} />
                </TableCell>
                <TableCell class="w-32 align-middle">
                  <div class="flex items-center justify-end gap-2">
                    <div class="h-1.5 w-20 overflow-hidden bg-[var(--app-viz-neutral)]">
                      <div class={`app-viz-bar-2 h-full w-[${relativePct}%]`} />
                    </div>
                    <span class="w-8 text-right font-mono text-[11px] tabular-nums text-[var(--app-muted)]">
                      {relativePct}%
                    </span>
                  </div>
                </TableCell>
                <TableCell class="text-right font-mono font-bold tabular-nums">
                  {formatInteger(entry.totalTokens)}
                </TableCell>
                <TableCell class="text-right font-mono font-bold tabular-nums">
                  {formatInteger(entry.totalTokensWithoutCacheRead)}
                </TableCell>
                <TableCell class="text-right font-mono font-semibold tabular-nums">
                  {formatPercentRate(entry.cacheReadRate)}
                </TableCell>
                <TableCell class="text-right font-mono text-[var(--app-muted)] tabular-nums">
                  {formatLeaderboardCost(entry)}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function CurrentViewerBadge(props: { isCurrentViewer: boolean }) {
  if (!props.isCurrentViewer) return null

  return (
    <span class="app-current-viewer-tag" data-leaderboard-current-user-badge="true">
      我
    </span>
  )
}

function LeaderboardSourceShare(props: { breakdown: LeaderboardSourceBreakdown[] }) {
  if (props.breakdown.length === 0) return <span class="font-mono text-[var(--app-muted)]">—</span>

  const named = props.breakdown.slice(0, 2)
  const rest = props.breakdown.slice(2)
  const restShare = rest.reduce((total, item) => total + item.share, 0)

  return (
    <div class="min-w-0 space-y-1" data-leaderboard-source-share="true" title={sourceShareTitle(props.breakdown)}>
      {named.map((item) => (
        <div class="flex items-baseline justify-between gap-2 font-mono text-xs">
          <span class="min-w-0 truncate">{formatSource(item.source)}</span>
          <span class="shrink-0 font-bold tabular-nums text-[var(--app-text)]">{formatShare(item.share)}</span>
        </div>
      ))}
      {rest.length > 0 ? (
        <div class="flex items-baseline justify-between gap-2 font-mono text-xs text-[var(--app-muted)]">
          <span class="min-w-0 truncate">其他 {rest.length} 个来源</span>
          <span class="shrink-0 font-bold tabular-nums">{formatShare(restShare)}</span>
        </div>
      ) : null}
    </div>
  )
}

function sourceShareTitle(breakdown: LeaderboardSourceBreakdown[]) {
  return breakdown.map((item) => `${formatSource(item.source)} ${formatShare(item.share)}`).join(' / ')
}

function formatShare(share: number) {
  if (!(share > 0)) return '0%'
  return `${Math.max(1, Math.round(share * 100))}%`
}

function formatPrimaryModel(model: string | null) {
  return model ?? '—'
}

function RankBadge(props: { rank: number }) {
  return <span class={cn('app-rank-badge', props.rank <= 3 && 'app-rank-badge-top')}>#{props.rank}</span>
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatLeaderboardCost(entry: LeaderboardEntry) {
  return entry.costAvailable ? formatUsd(entry.costUsd) : '费用不可用'
}

function metricNumericValue(entry: LeaderboardEntry, metric: LeaderboardMetric) {
  if (metric === 'cost') return entry.costAvailable ? entry.costUsd : 0
  if (metric === 'tokens-without-cache-read') return entry.totalTokensWithoutCacheRead
  return entry.totalTokens
}

function formatPrimaryMetric(entry: LeaderboardEntry, metric: LeaderboardMetric) {
  if (metric === 'cost') return formatLeaderboardCost(entry)
  if (metric === 'tokens-without-cache-read') return formatInteger(entry.totalTokensWithoutCacheRead)
  return formatInteger(entry.totalTokens)
}

function metricTitle(metric: LeaderboardMetric) {
  if (metric === 'cost') return '费用'
  if (metric === 'tokens-without-cache-read') return '不含缓存读 token'
  return ' token'
}

function leaderboardHref(period: 'daily' | 'monthly', metric: LeaderboardMetric) {
  return `/leaderboards?period=${period}&metric=${metric}`
}

function SegmentedControl(props: {
  group: 'period' | 'metric'
  items: Array<{ label: string; value: string; href: string; active: boolean }>
}) {
  return (
    <div
      class={cn(
        'grid border border-[var(--app-border-strong)] bg-[var(--app-panel-strong)] divide-x divide-[var(--app-border-strong)] text-sm sm:flex',
        props.items.length === 3 ? 'grid-cols-3' : 'grid-cols-2'
      )}
      data-leaderboard-group={props.group}
    >
      {props.items.map((item) =>
        item.active ? (
          <span
            class="inline-flex min-h-10 w-full items-center justify-center bg-[var(--app-text)] px-4 py-2 font-mono text-xs font-bold text-[var(--app-bg)] sm:w-auto"
            aria-current="true"
            tabindex={-1}
            data-leaderboard-value={item.value}
          >
            {item.label}
          </span>
        ) : (
          <a
            class="inline-flex min-h-10 w-full items-center justify-center px-4 py-2 font-mono text-xs font-bold text-[var(--app-text)] transition hover:bg-[var(--app-hover)] sm:w-auto"
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
