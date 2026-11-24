import { computeFolioMatrixLayout, type FolioMatrixMode, type FolioMatrixTone } from '../../lib/folio-matrix-layout'

export type FolioSegment = {
  label: string
  detail?: string
  share: number
  tone: 1 | 2 | 3 | 4 | 5
}

const TONE_FILL: Record<FolioSegment['tone'], string> = {
  1: 'fill-[var(--app-viz-2)]',
  2: 'fill-[var(--app-viz-1)]',
  3: 'fill-[var(--app-viz-3)]',
  4: 'fill-[var(--app-viz-4)]',
  5: 'fill-[var(--app-viz-neutral)]'
}

const TONE_TEXT: Record<FolioSegment['tone'], string> = {
  1: 'fill-[#121116]',
  2: 'fill-[#121116]',
  3: 'fill-[#121116]',
  4: 'fill-[var(--app-bg)]',
  5: 'fill-[var(--app-text)]'
}

const TONE_SWATCH: Record<FolioSegment['tone'], string> = {
  1: 'app-viz-bar-2',
  2: 'app-viz-bar-1',
  3: 'app-viz-bar-3',
  4: 'app-viz-bar-4',
  5: 'app-viz-bar-neutral'
}

/**
 * 100% Stacked Composition Ribbon Bar with vertical leader ticks and inline percentages
 * modeled directly on Folio Section 02. Zero inline `style=` attributes.
 */
export function FolioStackedRibbon(props: { segments: FolioSegment[]; ariaLabel: string }) {
  const normalized = normalizeSegments(props.segments)
  const totalWidth = 560
  const barY = 54
  const barHeight = 46

  let cursor = 0
  const rects = normalized.map((seg, index) => {
    const rawWidth = index === normalized.length - 1 ? totalWidth - cursor : Math.round(seg.share * totalWidth)
    const width = Math.max(0, rawWidth)
    const x = cursor
    cursor += width
    const center = x + width / 2
    const pct = Math.round(seg.share * 100)
    const labelY = index % 2 === 0 ? 18 : 34
    const tickTop = labelY + 5
    return { seg, x, width, center, pct, labelY, tickTop }
  })

  return (
    <div class="w-full" data-folio-stacked-ribbon="true">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${totalWidth} 112`}
        class="block h-auto w-full"
        role="img"
        aria-label={props.ariaLabel}
      >
        {rects.map(({ seg, x, width, center, pct, labelY, tickTop }, index) =>
          width > 0 ? (
            <g
              key={`${seg.label}-${index}`}
              class="app-folio-hover-seg"
              tabindex="0"
              data-folio-tooltip-target="true"
              data-folio-tooltip-cat="100% 堆叠构成"
              data-folio-tooltip-val={seg.label}
              data-folio-tooltip-sub={seg.detail ? `${seg.detail} · 占比 ${pct}%` : `占比 ${pct}%`}
            >
              {width >= 42 ? (
                <>
                  <text
                    x={center}
                    y={labelY}
                    text-anchor="middle"
                    class="fill-[var(--app-muted)] font-mono text-[10px]"
                  >
                    {truncateLabel(seg.label, width >= 96 ? 18 : width >= 56 ? 14 : 10)}
                  </text>
                  <line
                    x1={center}
                    y1={tickTop}
                    x2={center}
                    y2={barY}
                    class="stroke-[var(--app-border-strong)]"
                    stroke-width="0.9"
                  />
                </>
              ) : null}
              <rect x={x} y={barY} width={width} height={barHeight} class={TONE_FILL[seg.tone]} />
              {width >= 36 ? (
                <text
                  x={x + 8}
                  y={barY + 28}
                  class={`${TONE_TEXT[seg.tone]} pointer-events-none font-mono text-[12px] font-bold`}
                >
                  {pct}%
                </text>
              ) : null}
            </g>
          ) : null
        )}
      </svg>

      <div class="mt-3 flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-[var(--app-muted)]">
        {normalized.map((seg, index) => (
          <span key={`${seg.label}-legend-${index}`} class="inline-flex items-center gap-2">
            <span class={`inline-block h-2.5 w-2.5 shrink-0 ${TONE_SWATCH[seg.tone]}`} />
            <span class="font-semibold text-[var(--app-text)]">{seg.label}</span>
            <span class="tabular-nums">{Math.round(seg.share * 100)}%</span>
            {seg.detail ? <span class="text-[var(--app-subtle)]">({seg.detail})</span> : null}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * 10x10 Prompt Cache Reuse Waffle Matrix paired with a monumental rotated -90deg numeral
 * modeled directly on Folio Section 08.
 */
export function FolioCacheWaffle(props: {
  cacheHitRate: number
  freshInputRate?: number
  caption?: string
  patternId?: string
}) {
  const hitPct = Math.max(0, Math.min(100, Math.round(props.cacheHitRate * 100)))
  const freshPct =
    props.freshInputRate !== undefined
      ? Math.max(0, Math.min(100 - hitPct, Math.round(props.freshInputRate * 100)))
      : 100 - hitPct
  const otherPct = Math.max(0, 100 - hitPct - freshPct)
  const patternId = props.patternId ?? 'folio-waffle-hatch'

  const cell = 20
  const gap = 4
  const gridSpan = 10 * cell + 9 * gap // 236
  const cells = []
  for (let i = 0; i < 100; i += 1) {
    // Fill column-first (left to right) just like Folio Section 08!
    const col = Math.floor(i / 10)
    const row = i % 10
    const x = col * (cell + gap)
    const y = row * (cell + gap)
    if (i < hitPct) {
      cells.push(<rect key={i} x={x} y={y} width={cell} height={cell} class="fill-[var(--app-viz-2)]" />)
    } else if (i < hitPct + freshPct) {
      cells.push(
        <rect
          key={i}
          x={x + 0.6}
          y={y + 0.6}
          width={cell - 1.2}
          height={cell - 1.2}
          fill={`url(#${patternId})`}
          class="stroke-[var(--app-viz-2)]"
          stroke-width="1.2"
        />
      )
    } else {
      cells.push(
        <rect
          key={i}
          x={x + 0.6}
          y={y + 0.6}
          width={cell - 1.2}
          height={cell - 1.2}
          fill="none"
          class="stroke-[var(--app-border-strong)]"
          stroke-width="1"
        />
      )
    }
  }

  return (
    <div class="w-full" data-folio-cache-waffle="true">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 430 242"
        class="block h-auto w-full max-w-[460px]"
        role="img"
        aria-label={`10x10 缓存复用华夫格：缓存读取 ${hitPct}%，新增输入 ${freshPct}%，输出/其他 ${otherPct}%`}
      >
        <defs>
          <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" class="stroke-[var(--app-viz-2)]" stroke-width="1.6" />
          </pattern>
        </defs>
        <g>{cells}</g>
        {/* Monumental -90deg rotated numeral beside the 10x10 matrix */}
        <g transform={`translate(${gridSpan + 114} 178) rotate(-90)`}>
          <text x="0" y="0" class="fill-[var(--app-text)] font-sans text-[128px] font-medium tracking-tighter">
            {hitPct}
          </text>
        </g>
        <text x={gridSpan + 36} y="214" class="fill-[var(--app-muted)] font-sans text-[11px]">
          每 100 个消耗 Token 中直接命中
        </text>
        <text x={gridSpan + 36} y="232" class="fill-[var(--app-muted)] font-sans text-[11px]">
          Prompt Cache 缓存读取
        </text>
      </svg>

      <div class="mt-3 flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-[var(--app-muted)]">
        <span class="inline-flex items-center gap-1.5">
          <span class="app-viz-bar-2 inline-block h-2.5 w-2.5" />
          缓存读取 <strong class="tabular-nums text-[var(--app-text)]">{hitPct}%</strong>
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block h-2.5 w-2.5 border border-[var(--app-viz-2)] bg-[var(--app-accent-soft)]" />
          新增输入 <strong class="tabular-nums text-[var(--app-text)]">{freshPct}%</strong>
        </span>
        {otherPct > 0 ? (
          <span class="inline-flex items-center gap-1.5">
            <span class="inline-block h-2.5 w-2.5 border border-[var(--app-border-strong)]" />
            输出/其他 <strong class="tabular-nums text-[var(--app-text)]">{otherPct}%</strong>
          </span>
        ) : null}
      </div>
      {props.caption ? <p class="app-fig-caption mt-2.5">{props.caption}</p> : null}
    </div>
  )
}

export type FolioRotatedColumnItem = {
  label: string
  share: number
  tone: 1 | 2 | 3
}

/**
 * Giant Rotated -90deg Percentage Column Chart (3-column editorial signature from Folio Sections 04 & 10).
 */
export function FolioRotatedColumns(props: { items: FolioRotatedColumnItem[]; ariaLabel: string }) {
  const items = props.items.slice(0, 3)
  const colW = 164
  const totalW = colW * items.length
  const chartH = 270
  const baseLineY = chartH
  const maxShare = Math.max(...items.map((item) => item.share), 0.01)

  const toneClass: Record<1 | 2 | 3, string> = {
    1: 'fill-[var(--app-viz-1)]',
    2: 'fill-[var(--app-viz-2)]',
    3: 'fill-[var(--app-viz-3)]'
  }

  return (
    <div class="w-full">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${totalW} ${chartH + 34}`}
        class="block h-auto w-full"
        role="img"
        aria-label={props.ariaLabel}
      >
        {items.map((item, idx) => {
          const pct = Math.max(0, Math.min(100, Math.round(item.share * 100)))
          // Scale bars proportionally while ensuring a readable architectural floor
          const height = Math.max(46, Math.round((item.share / Math.max(maxShare, 0.5)) * (chartH - 36)))
          const x = idx * colW
          const y = baseLineY - height
          return (
            <g
              key={`${item.label}-${idx}`}
              class="app-folio-hover-seg"
              tabindex="0"
              data-folio-tooltip-target="true"
              data-folio-tooltip-cat="来源集中度结构"
              data-folio-tooltip-val={item.label}
              data-folio-tooltip-sub={`占总吞吐比例 ${pct}%`}
            >
              <rect x={x} y={y} width={colW} height={height} class={toneClass[item.tone]} />
              <g transform={`translate(${x + 88} ${baseLineY - 12}) rotate(-90)`} class="pointer-events-none">
                <text x="0" y="0" class="fill-[var(--app-text)] font-sans text-[92px] font-medium tracking-tighter">
                  {pct}%
                </text>
              </g>
              <text x={x + 2} y={baseLineY + 22} class="fill-[var(--app-text)] font-sans text-[12px] font-bold">
                {truncateLabel(item.label, 16)}
              </text>
            </g>
          )
        })}
        <line
          x1="0"
          y1={baseLineY}
          x2={totalW}
          y2={baseLineY}
          class="stroke-[var(--app-border-strong)]"
          stroke-width="1.2"
        />
      </svg>
    </div>
  )
}

/**
 * 400-Square Morphable Folio Unit Matrix (modeled directly on Folio #s01).
 * Renders a single persistent pool of 400 squares in SSR (`all` mode by default, zero inline `style=`),
 * which smoothly flies & regroups into two-column categorical sub-matrices with hover tooltips in the client.
 */
export function FolioUnitMatrix(props: { initialMode?: FolioMatrixMode; ariaLabel: string }) {
  const mode = props.initialMode ?? 'all'
  const layout = computeFolioMatrixLayout(mode)

  return (
    <div class="w-full" data-folio-matrix-root="true" data-matrix-mode={mode}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${layout.viewBoxWidth} ${layout.viewBoxHeight}`}
        class="app-matrix-svg block h-auto w-full overflow-visible"
        role="img"
        aria-label={props.ariaLabel}
        data-folio-matrix-svg="true"
      >
        <g data-matrix-labels="true">
          {layout.groups.map((group) =>
            group.headingText ? (
              <text
                key={group.id}
                x={group.headingX}
                y={group.headingY}
                class="app-matrix-group-label"
                data-matrix-group-id={group.id}
              >
                {group.headingText}
              </text>
            ) : null
          )}
        </g>
        <g data-matrix-squares="true">
          {layout.squares.map((sq) => (
            <rect
              key={sq.index}
              x="0"
              y="0"
              width={layout.cellSize}
              height={layout.cellSize}
              transform={`translate(${sq.x} ${sq.y})`}
              class={`app-matrix-sq ${MATRIX_TONE_CLASS[sq.tone]}`}
              data-matrix-sq="true"
              data-matrix-group-id={sq.groupId}
              aria-hidden="true"
            />
          ))}
        </g>
        <g data-matrix-hits="true">
          {layout.groups.map((group) => (
            <rect
              key={group.id}
              x={group.hitX}
              y={group.hitY}
              width={group.hitWidth}
              height={group.hitHeight}
              fill="transparent"
              class="app-matrix-hit"
              tabindex="0"
              role="img"
              aria-label={`${group.label}: ${group.tokensLabel}，占比 ${group.percentLabel}`}
              data-matrix-hit="true"
              data-matrix-group-id={group.id}
              data-folio-tooltip-target="true"
              data-folio-tooltip-cat={group.categoryLabel}
              data-folio-tooltip-val={group.label}
              data-folio-tooltip-sub={`${group.tokensLabel.includes('Tokens') ? group.tokensLabel : `${group.tokensLabel} Tokens`} · 占比 ${group.percentLabel}`}
            />
          ))}
        </g>
      </svg>
    </div>
  )
}

const MATRIX_TONE_CLASS: Record<FolioMatrixTone, string> = {
  muted: 'fill-[var(--app-muted)]',
  violet: 'fill-[var(--app-viz-2)]',
  vermilion: 'fill-[var(--app-viz-1)]',
  magenta: 'fill-[var(--app-viz-3)]',
  ink: 'fill-[var(--app-viz-4)]',
  neutral: 'fill-[var(--app-viz-neutral)]'
}

function normalizeSegments(segments: FolioSegment[]) {
  const positive = segments.filter((seg) => seg.share > 0)
  const sum = positive.reduce((acc, seg) => acc + seg.share, 0)
  if (sum <= 0) return []
  return positive.map((seg) => ({ ...seg, share: seg.share / sum }))
}

function truncateLabel(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}
