import {
  FolioCacheWaffle,
  FolioRotatedColumns,
  FolioStackedRibbon,
  type FolioRotatedColumnItem,
  type FolioSegment
} from '../../../components/charts/folio-charts'
import { LinkButton } from '../../../components/ui/button'
import { formatPercentRate } from '../../../lib/usage-metrics'
import type { DashboardSummary } from '../service'
import { formatCostUnavailableNotice, formatSource } from '../source-format'
import { UsageMetricCard, UsageMetricGrid } from './usage-metric-card'
import { formatUsageMetricInteger, formatUsageMetricUsdWithCostAvailability } from './usage-metric-format'

export function DashboardPreview(props: {
  summary: DashboardSummary
  userName?: string
  /** The zone the "today" figures are measured in — the user's own profile zone. */
  timezone?: string
  /** The offset of `timezone` right now, e.g. `UTC+8`. */
  timezoneLabel?: string
}) {
  const totalSourceTokens = props.summary.sourceSplit.reduce((total, item) => total + item.totalTokens, 0)
  const totalSourceTokensWithoutCacheRead = props.summary.sourceSplit.reduce(
    (total, item) => total + item.totalTokensWithoutCacheRead,
    0
  )
  const trendMaxTokens = Math.max(...props.summary.dailyTrend.map((item) => item.totalTokens), 0)
  const peakDay = props.summary.dailyTrend.reduce(
    (best, item) => (item.totalTokens > (best?.totalTokens ?? -1) ? item : best),
    props.summary.dailyTrend[0]
  )
  const costUnavailableNotice = formatCostUnavailableNotice(props.summary.sourceSplit)
  const trendTotalTokens = props.summary.dailyTrend.reduce((total, item) => total + item.totalTokens, 0)
  const trendTotalTokensWithoutCacheRead = props.summary.dailyTrend.reduce(
    (total, item) => total + item.totalTokensWithoutCacheRead,
    0
  )

  const ribbonSegments = buildSourceRibbonSegments(props.summary.sourceSplit, totalSourceTokensWithoutCacheRead)
  const rotatedColumns = buildConcentrationColumns(props.summary.sourceSplit, totalSourceTokensWithoutCacheRead)

  return (
    <section class="app-folio-container flex flex-col gap-12 pb-12">
      {/* Chapter 01 — Editorial Header & 4×2 Hairline KPI Matrix */}
      <div class="space-y-6">
        <header class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div class="min-w-0">
            <p class="app-folio-kicker">01 — 个人遥测控制台 · TELEMETRY OVERVIEW</p>
            <h1 class="app-folio-h2 mt-2">
              {props.userName ? `${props.userName} 的算力面板` : 'AI token 使用面板'}
            </h1>
            <p class="mt-2 font-mono text-xs text-[var(--app-muted)]">
              最近同步：{props.summary.lastSyncedAt ?? '尚未同步'} {' · '}
              <a class="app-accent-link font-bold underline underline-offset-4" href="/settings/devices">
                已连设备：{props.summary.deviceCount}
              </a>
            </p>
            <DashboardTimezoneCaption
              timezone={props.timezone}
              timezoneLabel={props.timezoneLabel}
              mismatchedUsageTimezones={props.summary.mismatchedUsageTimezones}
            />
          </div>
          <div class="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
            <LinkButton class="w-full sm:w-auto" variant="secondary" href="/dashboard/details">
              展开全量明细 ↓
            </LinkButton>
            <LinkButton class="w-full sm:w-auto" href="/settings/install">
              连接新设备 →
            </LinkButton>
          </div>
        </header>

        <UsageMetricGrid>
          <UsageMetricCard label="今日 tokens" value={formatUsageMetricInteger(props.summary.todayTokens)} tone="lime" />
          <UsageMetricCard
            label="今日不含缓存读"
            value={formatUsageMetricInteger(props.summary.todayTokensWithoutCacheRead)}
          />
          <UsageMetricCard label="今日缓存率" value={formatPercentRate(props.summary.todayCacheReadRate)} />
          <UsageMetricCard
            label="今日费用"
            value={formatUsageMetricUsdWithCostAvailability(
              props.summary.todayCostUsd,
              props.summary.todayCostAvailable,
              costUnavailableNotice
            )}
          />
          <UsageMetricCard label="本月 tokens" value={formatUsageMetricInteger(props.summary.monthTokens)} />
          <UsageMetricCard
            label="本月不含缓存读"
            value={formatUsageMetricInteger(props.summary.monthTokensWithoutCacheRead)}
          />
          <UsageMetricCard label="本月缓存率" value={formatPercentRate(props.summary.monthCacheReadRate)} />
          <UsageMetricCard
            label="本月费用"
            value={formatUsageMetricUsdWithCostAvailability(
              props.summary.monthCostUsd,
              props.summary.monthCostAvailable,
              costUnavailableNotice
            )}
          />
        </UsageMetricGrid>
      </div>

      {/* Chapter 02 — Book Spread: 30-Day Pulse Trajectory + 10×10 Cache Efficiency Waffle */}
      <section class="app-folio-chapter-rule pt-10">
        <div class="app-folio-spread items-start">
          <div class="app-folio-spread-left space-y-5">
            <div class="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p class="app-folio-kicker">02 — 30 天时间脉冲 · DAILY TRAJECTORY</p>
                <h2 class="mt-1.5 text-xl font-extrabold tracking-tight sm:text-2xl">30 天趋势</h2>
                <p class="mt-1 font-mono text-xs text-[var(--app-muted)]">
                  最近 30 天共 {formatInteger(trendTotalTokens)} tokens，不含缓存读{' '}
                  {formatInteger(trendTotalTokensWithoutCacheRead)}。
                </p>
              </div>
              <div class="flex flex-wrap gap-3 font-mono text-[11px] text-[var(--app-muted)]">
                <span class="inline-flex items-center gap-1.5">
                  <span class="app-viz-bar-neutral inline-block h-2.5 w-2.5" />
                  total
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span class="app-viz-bar-2 inline-block h-2.5 w-2.5" />
                  不含缓存读
                </span>
              </div>
            </div>

            {peakDay && peakDay.totalTokens > 0 ? (
              <div class="flex flex-wrap items-center justify-between gap-2 border-y border-[var(--app-border)] py-2 font-mono text-xs">
                <span class="text-[var(--app-muted)]">
                  峰值里程碑：<strong class="text-[var(--app-text)]">{peakDay.usageDate}</strong>
                </span>
                <span class="app-accent-text font-bold tabular-nums">
                  {formatInteger(peakDay.totalTokens)} total · {formatInteger(peakDay.totalTokensWithoutCacheRead)} 不含缓存读
                </span>
              </div>
            ) : null}

            {/* Interactive 30-Day Telemetry Bars with Folio crisp geometry */}
            <div
              class="app-surface-subtle relative flex h-44 items-end gap-1 border border-[var(--app-border)] bg-[var(--app-panel)] p-3 sm:h-48"
              data-dashboard-trend-chart="true"
            >
              {props.summary.dailyTrend.map((item) => (
                <div
                  class="group relative flex h-full flex-1 items-end justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-viz-2)]"
                  aria-label={`${item.usageDate}: ${formatInteger(item.totalTokens)} total tokens, ${formatInteger(item.totalTokensWithoutCacheRead)} 不含缓存读`}
                  tabindex={0}
                  title={`${item.usageDate}: ${formatInteger(item.totalTokens)} total tokens, ${formatInteger(item.totalTokensWithoutCacheRead)} 不含缓存读`}
                  data-dashboard-trend-bar="true"
                  data-trend-date={item.usageDate}
                  data-trend-total={formatInteger(item.totalTokens)}
                  data-trend-without-cache-read={formatInteger(item.totalTokensWithoutCacheRead)}
                >
                  <div
                    class={`relative w-full max-w-3 overflow-hidden transition ${item.totalTokens > 0 ? 'bg-[var(--app-viz-neutral)] group-hover:bg-[var(--app-muted)]' : 'bg-[var(--app-border)]'} h-[${trendBarHeight(item.totalTokens, trendMaxTokens)}%]`}
                  >
                    <div
                      class={`app-viz-bar-2 absolute inset-x-0 bottom-0 transition group-hover:opacity-85 h-[${containedBarHeight(item.totalTokensWithoutCacheRead, item.totalTokens)}%]`}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div class="flex justify-between font-mono text-xs text-[var(--app-subtle)]">
              <span>{props.summary.dailyTrend[0]?.usageDate ?? '-'}</span>
              <span>FIG. 01 · 悬停或聚焦任意柱查看当日精确数值</span>
              <span>{props.summary.dailyTrend.at(-1)?.usageDate ?? '-'}</span>
            </div>
          </div>

          <div class="app-folio-spread-right space-y-5">
            <div>
              <p class="app-folio-kicker">03 — 缓存复用效率 · CACHE WAFFLE</p>
              <h2 class="mt-1.5 text-xl font-extrabold tracking-tight sm:text-2xl">本月 Prompt Cache 华夫格</h2>
              <p class="mt-1 text-sm text-[var(--app-muted)]">
                将本月总消耗具象为 10×10 网格，直观对比直接命中的缓存读取与新增输入占比。
              </p>
            </div>
            <FolioCacheWaffle
              cacheHitRate={props.summary.monthCacheReadRate}
              patternId="dashboard-cache-hatch"
              caption="FIG. 02 — 按本月全来源汇总计算；若尚未同步数据则显示为 0%。"
            />
          </div>
        </div>
      </section>

      {/* Chapter 03 — Book Spread: 100% Stacked Source Composition & Concentration Columns */}
      <section class="app-folio-chapter-rule pt-10">
        <div class="app-folio-spread items-start">
          <div class="app-folio-spread-left space-y-6">
            <div>
              <p class="app-folio-kicker">04 — 来源结构拆解 · SOURCE COMPOSITION</p>
              <h2 class="mt-1.5 text-xl font-extrabold tracking-tight sm:text-2xl">来源占比</h2>
              <p class="mt-1 text-sm text-[var(--app-muted)]">
                按本月不含缓存读 token 计算，同时保留 total token 与缓存率对照。
              </p>
            </div>

            {props.summary.sourceSplit.length > 0 ? (
              <>
                <FolioStackedRibbon
                  segments={ribbonSegments}
                  ariaLabel="本月各来源不含缓存读 Token 100% 堆叠构成图"
                />

                <div class="border-t border-[var(--app-border-strong)] pt-3">
                  <div class="divide-y divide-[var(--app-border)]">
                    {props.summary.sourceSplit.map((item, idx) => {
                      const pct = formatPercent(item.totalTokensWithoutCacheRead, totalSourceTokensWithoutCacheRead)
                      const barTone = idx === 0 ? 'app-viz-bar-2' : idx === 1 ? 'app-viz-bar-1' : idx === 2 ? 'app-viz-bar-3' : 'app-viz-bar-4'
                      return (
                        <div class="min-w-0 py-3">
                          <div class="flex min-w-0 items-center justify-between gap-4">
                            <span class="min-w-0 break-words font-bold text-[var(--app-text)] [overflow-wrap:anywhere]">
                              {formatSource(item.source)}
                            </span>
                            <span class="shrink-0 font-mono text-sm font-bold tabular-nums text-[var(--app-text)]">
                              {pct}
                            </span>
                          </div>
                          <p class="mt-1 break-words font-mono text-xs text-[var(--app-muted)] [overflow-wrap:anywhere]">
                            {formatInteger(item.totalTokensWithoutCacheRead)} 不含缓存读 / {formatInteger(item.totalTokens)}{' '}
                            total / 缓存率 {formatPercentRate(item.cacheReadRate)}
                          </p>
                          <div class="mt-2 h-1.5 overflow-hidden bg-[var(--app-viz-neutral)]">
                            <div
                              class={`h-full ${barTone} w-[${pct}]`}
                              title={`Total 占比：${formatPercent(item.totalTokens, totalSourceTokens)}`}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </>
            ) : (
              <p class="app-surface-subtle border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-6 text-sm text-[var(--app-muted)]">
                还没有上传使用数据。点击右上角「连接新设备」获取采集器安装提示词。
              </p>
            )}
          </div>

          <div class="app-folio-spread-right space-y-5">
            <div>
              <p class="app-folio-kicker">05 — 集中度柱图 · CONCENTRATION</p>
              <h2 class="mt-1.5 text-xl font-extrabold tracking-tight sm:text-2xl">主力来源集中度结构</h2>
              <p class="mt-1 text-sm text-[var(--app-muted)]">
                以三柱巨型旋转数字柱状图呈现头号主力、次主力与其余工具源的算力集中度。
              </p>
            </div>
            {rotatedColumns.length > 0 ? (
              <>
                <FolioRotatedColumns
                  items={rotatedColumns}
                  ariaLabel="本月主力来源集中度三柱旋转数字图"
                />
                <p class="app-fig-caption border-t border-[var(--app-border)] pt-2.5">
                  FIG. 03 — 基于本月不含缓存读 Token 占比实时计算。
                </p>
              </>
            ) : (
              <div class="border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-6 font-mono text-xs text-[var(--app-muted)]">
                同步至少一条用量快照后，此处自动绘制主力来源集中度柱图。
              </div>
            )}
          </div>
        </div>
      </section>
    </section>
  )
}

function buildSourceRibbonSegments(
  sourceSplit: DashboardSummary['sourceSplit'],
  totalWithoutCacheRead: number
): FolioSegment[] {
  if (totalWithoutCacheRead <= 0 || sourceSplit.length === 0) return []
  const top = sourceSplit.slice(0, 4)
  const rest = sourceSplit.slice(4)
  const segments: FolioSegment[] = top.map((item, idx) => ({
    label: formatSource(item.source),
    detail: formatInteger(item.totalTokensWithoutCacheRead),
    share: item.totalTokensWithoutCacheRead / totalWithoutCacheRead,
    tone: ((idx % 4) + 1) as 1 | 2 | 3 | 4
  }))
  if (rest.length > 0) {
    const restTokens = rest.reduce((acc, item) => acc + item.totalTokensWithoutCacheRead, 0)
    segments.push({
      label: `其他 ${rest.length} 源`,
      detail: formatInteger(restTokens),
      share: restTokens / totalWithoutCacheRead,
      tone: 5
    })
  }
  return segments
}

function buildConcentrationColumns(
  sourceSplit: DashboardSummary['sourceSplit'],
  totalWithoutCacheRead: number
): FolioRotatedColumnItem[] {
  if (totalWithoutCacheRead <= 0 || sourceSplit.length === 0) return []
  const sorted = [...sourceSplit].sort((a, b) => b.totalTokensWithoutCacheRead - a.totalTokensWithoutCacheRead)
  const top1 = sorted[0]
  const mid = sorted.slice(1, 3)
  const tail = sorted.slice(3)

  const columns: FolioRotatedColumnItem[] = [
    {
      label: formatSource(top1.source),
      share: top1.totalTokensWithoutCacheRead / totalWithoutCacheRead,
      tone: 1
    }
  ]
  if (mid.length > 0) {
    const midSum = mid.reduce((sum, item) => sum + item.totalTokensWithoutCacheRead, 0)
    columns.push({
      label: mid.length === 1 ? formatSource(mid[0].source) : '次主力 2–3',
      share: midSum / totalWithoutCacheRead,
      tone: 2
    })
  }
  if (tail.length > 0) {
    const tailSum = tail.reduce((sum, item) => sum + item.totalTokensWithoutCacheRead, 0)
    columns.push({
      label: `长尾 ${tail.length} 源`,
      share: tailSum / totalWithoutCacheRead,
      tone: 3
    })
  }
  return columns
}

function DashboardTimezoneCaption(props: {
  timezone?: string
  timezoneLabel?: string
  mismatchedUsageTimezones?: string[]
}) {
  if (!props.timezone) return null

  return (
    <>
      <p class="mt-1 font-mono text-xs text-[var(--app-subtle)]" data-dashboard-timezone="true">
        「今日」按 {props.timezone}
        {props.timezoneLabel ? `（${props.timezoneLabel}）` : ''} 的本地日历日统计。
      </p>
      <CollectorTimezoneMismatchWarning
        timezone={props.timezone}
        mismatchedUsageTimezones={props.mismatchedUsageTimezones}
      />
    </>
  )
}

function CollectorTimezoneMismatchWarning(props: { timezone: string; mismatchedUsageTimezones?: string[] }) {
  const mismatched = props.mismatchedUsageTimezones ?? []
  if (mismatched.length === 0) return null

  return (
    <p
      class="app-danger-notice mt-3 border px-3 py-2 text-xs font-medium"
      data-dashboard-timezone-mismatch="true"
    >
      采集端仍在按 {mismatched.join('、')} 写入日期，与上面「今日」使用的 {props.timezone} 不一致，今日数据可能显示为
      0。 请在{' '}
      <a class="app-accent-link font-bold underline underline-offset-4" href="/settings/install">
        连接设备
      </a>{' '}
      页用新时区重新安装采集器。
    </p>
  )
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatPercent(value: number, total: number) {
  if (total <= 0) return '0%'
  if (value <= 0) return '0%'
  return `${Math.max(1, Math.round((value / total) * 100))}%`
}

function trendBarHeight(value: number, max: number) {
  if (max <= 0 || value <= 0) return 2
  return Math.max(8, Math.round((value / max) * 100))
}

function containedBarHeight(value: number, total: number) {
  if (total <= 0 || value <= 0) return 0
  return Math.min(100, Math.max(8, Math.round((value / total) * 100)))
}

export const dashboardPreviewTestUtils = {
  containedBarHeight
}
