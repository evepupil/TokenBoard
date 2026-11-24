import { formatUsd } from '../../lib/money'
import { cacheReadRateFromTotals, formatPercentRate } from '../../lib/usage-metrics'
import { defaultPublicCardConfig, parsePublicCardConfig, type PublicCardConfig, type PublicCardMetric } from './config'
import {
  aggregateCardModels,
  buildHeatmapCells,
  formatEditorialTokens,
  formatSharePercent,
  formatUnitScaleTokens,
  truncateModelLabel,
  type AggregatedModelGroup
} from './model-matrix'
import { palettes, type Palette, type UsageCardInput } from './svg-types'

export type { UsageCardInput } from './svg-types'

const SANS_FONT = "'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', Arial, sans-serif"
const MONO_FONT = "'SFMono-Regular', Menlo, Monaco, Consolas, monospace"

export function renderUsageCardSvg(input: UsageCardInput, configInput?: Partial<PublicCardConfig> | null) {
  const config = parsePublicCardConfig(configInput ? { ...defaultPublicCardConfig, ...configInput } : null)
  const palette = palettes[config.theme]
  const unavailableCostNote = buildUnavailableCostNote(input, config)
  const hasFooter = Boolean(unavailableCostNote)
  const bodyBottom = hasFooter ? 198 : 220
  const title = config.title || labels(config.language).title
  const subtitle = config.subtitle || subtitleText(input, config)
  const colorScheme = config.theme === 'light' ? 'only light' : 'dark'
  const timezoneNote = buildTimezoneNote(input, config)
  const updatedNote = buildUpdatedNote(input, config)
  const cacheRate = resolvedCacheRate(input)
  const isCompact = config.layout === 'compact'
  const modelSummary = aggregateCardModels(input.models, {
    language: config.language,
    totalTokens: input.monthTokens > 0 ? input.monthTokens : input.totalTokens,
    totalModelCount: input.totalModelCount
  })

  const mastheadMeta = buildMastheadMeta(timezoneNote, updatedNote, isCompact, palette)
  const mastheadMiniMatrix = isCompact
    ? buildCompactMastheadMatrix(modelSummary.groups, cacheRate, config.language, palette, Boolean(mastheadMeta))
    : ''

  const bodyMarkup = isCompact
    ? buildCompactBody(input, config, palette, bodyBottom)
    : buildEditorialMatrixBody(input, config, palette, bodyBottom, modelSummary, cacheRate)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="220" viewBox="0 0 520 220" role="img" aria-label="${escapeXml(title)}" color-scheme="${colorScheme}">
  <title>${escapeXml(title)}</title>
  <defs>
    ${glowDefinition(config, palette)}
    <pattern id="folio-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="4" stroke="${palette.viz2}" stroke-width="1.2"/>
    </pattern>
  </defs>
  <rect width="520" height="220" fill="${palette.bg}"/>
  ${hasFooter ? `<rect x="0" y="${bodyBottom}" width="520" height="${220 - bodyBottom}" fill="${palette.footerBg}"/>` : ''}
  ${config.glow.enabled ? '<rect width="520" height="220" fill="url(#glow)"/>' : ''}
  ${logoMark(palette)}
  <text x="50" y="23.5" fill="${palette.text}" font-family="${SANS_FONT}" font-size="14" font-weight="800" letter-spacing="-0.25">${escapeXml(title)}</text>
  <text x="50" y="36" fill="${palette.muted}" font-family="${MONO_FONT}" font-size="8.5">${escapeXml(subtitle)}</text>
  ${mastheadMiniMatrix}
  ${mastheadMeta}
  <line x1="18" y1="43" x2="502" y2="43" stroke="${palette.ruleStrong}" stroke-width="1.2"/>
  ${bodyMarkup}
  ${
    hasFooter
      ? `<line x1="0" y1="${bodyBottom}" x2="520" y2="${bodyBottom}" stroke="${palette.border}" stroke-width="1"/>
  <text x="18" y="213" fill="${palette.muted}" font-family="${MONO_FONT}" font-size="9">${escapeXml(unavailableCostNote)}</text>`
      : ''
  }
  <rect x="0.5" y="0.5" width="519" height="219" fill="none" stroke="${palette.border}" stroke-width="1"/>
</svg>`
}

function maxMetricCount(layout: PublicCardConfig['layout']) {
  if (layout === 'compact') return 6
  if (layout === 'wide') return 3
  return 4
}

function visibleMetrics(config: PublicCardConfig) {
  return config.metrics.slice(0, maxMetricCount(config.layout))
}

/**
 * Editorial Folio Layout (`balanced` & `wide`):
 * Top band: Swiss Big-Number + Small-Description KPI strip with vertical hairlines.
 * Bottom band: Full-width Heatmap-Style Model Unit Matrix (or Prompt Cache Matrix fallback).
 */
function buildEditorialMatrixBody(
  input: UsageCardInput,
  config: PublicCardConfig,
  palette: Palette,
  bodyBottom: number,
  modelSummary: ReturnType<typeof aggregateCardModels>,
  cacheRate: number
) {
  const isWide = config.layout === 'wide'
  const items = visibleMetrics(config)
  const count = Math.max(1, items.length)
  const stripTop = 43
  const stripBottom = isWide ? 111 : 105
  const totalWidth = 484
  const colWidth = totalWidth / count

  const kpiColumns = items.map((metric, index) => {
    const colX = 18 + index * colWidth
    const textX = index === 0 ? 18 : Number((colX + 10).toFixed(1))
    const value = metricValue(input, metric)
    const label = metricLabel(metric, config, !costAvailabilityForMetric(input, metric))
    const sub = metricSubCaption(input, metric, config)
    const baseSize = isWide ? 28.5 : count <= 2 ? 27 : 25
    const valueSize = fitBigNumberSize(value, baseSize, colWidth - (index === 0 ? 10 : 18))
    const valueY = isWide ? 77 : 73
    const labelY = isWide ? 92.5 : 87.5
    const subY = isWide ? 104.5 : 99

    return `<g>
    <text x="${textX}" y="${valueY}" fill="${palette.text}" font-family="${SANS_FONT}" font-size="${valueSize}" font-weight="600" letter-spacing="-0.9">${escapeXml(value)}</text>
    <text x="${textX}" y="${labelY}" fill="${palette.text}" font-family="${SANS_FONT}" font-size="${isWide ? 9.5 : 9}" font-weight="600">${escapeXml(label)}</text>
    <text x="${textX}" y="${subY}" fill="${palette.highlightText}" font-family="${MONO_FONT}" font-size="${isWide ? 8.1 : 7.7}">${escapeXml(sub)}</text>
  </g>`
  })

  const verticalRules = Array.from({ length: Math.max(0, count - 1) }, (_, idx) => {
    const rx = Number((18 + (idx + 1) * colWidth).toFixed(1))
    return `<line x1="${rx}" y1="${stripTop + 6}" x2="${rx}" y2="${stripBottom - 6}" stroke="${palette.border}" stroke-width="1"/>`
  })

  const matrixSection = buildFullWidthHeatmapSection({
    topY: stripBottom,
    bottomY: bodyBottom,
    isWide,
    language: config.language,
    palette,
    modelSummary,
    cacheRate
  })

  return `${kpiColumns.join('\n  ')}
  ${verticalRules.join('\n  ')}
  <line x1="18" y1="${stripBottom}" x2="502" y2="${stripBottom}" stroke="${palette.border}" stroke-width="1"/>
  ${matrixSection}`
}

/**
 * Full-width Heatmap Unit Matrix Section:
 * - When `modelSummary.groups` has data: renders a 48-col color-coded model heatmap
 *   where low-share models (< 5% or beyond top 4) are folded into "其他 N 个模型" / "Other N models".
 * - Otherwise: renders the identical 48-col heatmap grid driven by Prompt Cache reuse rate.
 */
function buildFullWidthHeatmapSection(input: {
  topY: number
  bottomY: number
  isWide: boolean
  language: PublicCardConfig['language']
  palette: Palette
  modelSummary: ReturnType<typeof aggregateCardModels>
  cacheRate: number
}) {
  const { topY, bottomY, isWide, language, palette, modelSummary, cacheRate } = input
  const availH = bottomY - topY
  const cols = 48
  const cellSize = 8
  const gap = 2.08
  const startX = 18.6
  const hasModels = modelSummary.groups.length > 0
  const legendRows = hasModels && modelSummary.groups.length > 3 ? 2 : 1

  // Select row count cleanly so header + heatmap + legend always fit with generous breathing room.
  let rows = 5
  if (availH < 88) {
    rows = 3
  } else if (availH < 104 || (isWide && legendRows === 2) || (availH < 110 && legendRows === 2)) {
    rows = 4
  }

  const totalCells = cols * rows
  const gridHeight = rows * cellSize + (rows - 1) * gap
  const headerY = topY + 13.5
  const gridStartY = topY + 21
  const legendStartY = Number((gridStartY + gridHeight + (availH < 96 ? 12 : 14.5)).toFixed(1))

  if (hasModels) {
    const cells = buildHeatmapCells({
      groups: modelSummary.groups,
      cols,
      rows,
      startX,
      startY: gridStartY,
      cellSize,
      gap
    })

    const rects = cells.map((cell) => {
      const fill = seriesColor(cell.seriesIndex, cell.isOther, palette)
      return `<rect x="${cell.x}" y="${cell.y}" width="${cellSize}" height="${cellSize}" fill="${fill}"/>`
    })

    const perCellTokens = modelSummary.totalTokens / totalCells
    const titleText = language === 'en' ? 'MODEL UNIT MATRIX' : '模型用量矩阵'
    const scaleText =
      language === 'en'
        ? `1 cell ≈ ${formatUnitScaleTokens(perCellTokens)} · ${modelSummary.totalModelCount} models`
        : `每格 ≈ ${formatUnitScaleTokens(perCellTokens)} · 共 ${modelSummary.totalModelCount} 个模型`

    const legendItems = buildModelLegend(modelSummary.groups, legendStartY, legendRows === 2 ? 13 : 0, palette)

    return `<g data-card-model-matrix="true">
    <text x="18" y="${headerY}" fill="${palette.text}" font-family="${SANS_FONT}" font-size="8.4" font-weight="700" letter-spacing="0.2">${escapeXml(titleText)}</text>
    <text x="502" y="${headerY}" text-anchor="end" fill="${palette.subtle}" font-family="${MONO_FONT}" font-size="7.8">${escapeXml(scaleText)}</text>
    ${rects.join('\n    ')}
    ${legendItems}
  </g>`
  }

  // Fallback: Prompt Cache Reuse Heatmap Matrix (same 48-col visual architecture)
  const filledCells = Math.round(cacheRate * totalCells)
  const pitch = cellSize + gap
  const cells: string[] = []
  for (let idx = 0; idx < totalCells; idx += 1) {
    const col = Math.floor(idx / rows)
    const row = idx % rows
    const cx = Number((startX + col * pitch).toFixed(1))
    const cy = Number((gridStartY + row * pitch).toFixed(1))
    if (idx < filledCells) {
      cells.push(`<rect x="${cx}" y="${cy}" width="${cellSize}" height="${cellSize}" fill="${palette.viz2}"/>`)
    } else {
      cells.push(
        `<rect x="${cx + 0.35}" y="${cy + 0.35}" width="${cellSize - 0.7}" height="${cellSize - 0.7}" fill="url(#folio-hatch)" stroke="${palette.viz2}" stroke-width="0.7"/>`
      )
    }
  }

  const pct = Math.round(cacheRate * 100)
  const freshPct = Math.max(0, 100 - pct)
  const heading = language === 'en' ? 'PROMPT CACHE MATRIX' : 'Prompt Cache 复用矩阵'
  const rightStat =
    language === 'en' ? `${pct}% hit · ${filledCells}/${totalCells} cells` : `命中 ${pct}% · ${filledCells}/${totalCells} 格`
  const hitLabel = language === 'en' ? `Cache Read ${pct}%` : `缓存读取 ${pct}%`
  const freshLabel = language === 'en' ? `Fresh Input ${freshPct}%` : `新增输入 ${freshPct}%`

  return `<g data-card-cache-waffle="true">
    <text x="18" y="${headerY}" fill="${palette.text}" font-family="${SANS_FONT}" font-size="8.4" font-weight="700" letter-spacing="0.2">${escapeXml(heading)}</text>
    <text x="502" y="${headerY}" text-anchor="end" fill="${palette.subtle}" font-family="${MONO_FONT}" font-size="7.8">${escapeXml(rightStat)}</text>
    ${cells.join('\n    ')}
    <rect x="18" y="${(legendStartY - 6.2).toFixed(1)}" width="6.5" height="6.5" fill="${palette.viz2}"/>
    <text x="29" y="${legendStartY}" fill="${palette.text}" font-family="${SANS_FONT}" font-size="8.2" font-weight="600">${escapeXml(hitLabel)}</text>
    <rect x="150" y="${(legendStartY - 5.9).toFixed(1)}" width="5.9" height="5.9" fill="url(#folio-hatch)" stroke="${palette.viz2}" stroke-width="0.7"/>
    <text x="161" y="${legendStartY}" fill="${palette.muted}" font-family="${SANS_FONT}" font-size="8.2">${escapeXml(freshLabel)}</text>
  </g>`
}

function buildModelLegend(
  groups: ReadonlyArray<AggregatedModelGroup>,
  startY: number,
  rowStep: number,
  palette: Palette
) {
  const colXs = [18, 184, 350]
  return groups
    .map((group, idx) => {
      const col = idx % 3
      const row = Math.floor(idx / 3)
      const x = colXs[col]
      const y = Number((startY + row * rowStep).toFixed(1))
      const swatchColor = seriesColor(group.seriesIndex, group.isOther, palette)
      const shortName = truncateModelLabel(group.label, 18)
      const shareText = formatSharePercent(group.share)
      const rightEdge = col === 2 ? 502 : colXs[col + 1] - 12

      return `<g>
      <rect x="${x}" y="${(y - 6.2).toFixed(1)}" width="6.5" height="6.5" fill="${swatchColor}"/>
      <text x="${x + 10.5}" y="${y}" fill="${group.isOther ? palette.muted : palette.text}" font-family="${SANS_FONT}" font-size="8.2" font-weight="${group.isOther ? 500 : 600}">${escapeXml(shortName)}</text>
      <text x="${rightEdge}" y="${y}" text-anchor="end" fill="${palette.subtle}" font-family="${MONO_FONT}" font-size="7.9">${escapeXml(shareText)}</text>
    </g>`
    })
    .join('\n    ')
}

/**
 * Compact 3×2 Swiss Big-Number Grid (`compact` layout):
 * Six big-number-first metrics with crisp labels and cobalt sub-captions, separated by pure hairlines.
 */
function buildCompactBody(
  input: UsageCardInput,
  config: PublicCardConfig,
  palette: Palette,
  bodyBottom: number
) {
  const items = visibleMetrics(config)
  const bodyHeight = bodyBottom - 43
  const rowHeight = Math.round(bodyHeight / 2)
  const colXs = [18, 180, 342]
  const colWidths = [162, 162, 160]
  const midY = 43 + rowHeight

  const cells = items.map((metric, index) => {
    const col = index % 3
    const row = Math.floor(index / 3)
    const x = colXs[col]
    const y = 43 + row * rowHeight
    const textX = col === 0 ? 18 : x + 10
    const value = metricValue(input, metric)
    const label = metricLabel(metric, config, !costAvailabilityForMetric(input, metric))
    const sub = metricSubCaption(input, metric, config)
    const valueSize = fitBigNumberSize(value, rowHeight < 80 ? 21 : 23.5, colWidths[col] - 14)
    const valueY = y + (rowHeight < 80 ? 31.5 : 36)
    const labelY = y + (rowHeight < 80 ? 46 : 52)
    const subY = y + (rowHeight < 80 ? 58 : 65)

    return `<g>
    <text x="${textX}" y="${valueY}" fill="${palette.text}" font-family="${SANS_FONT}" font-size="${valueSize}" font-weight="600" letter-spacing="-0.8">${escapeXml(value)}</text>
    <text x="${textX}" y="${labelY}" fill="${palette.text}" font-family="${SANS_FONT}" font-size="8.8" font-weight="600">${escapeXml(label)}</text>
    <text x="${textX}" y="${subY}" fill="${palette.highlightText}" font-family="${MONO_FONT}" font-size="7.6">${escapeXml(sub)}</text>
  </g>`
  })

  const rules = `<g stroke="${palette.border}" stroke-width="1">
    <line x1="180" y1="50" x2="180" y2="${bodyBottom - 8}"/>
    <line x1="342" y1="50" x2="342" y2="${bodyBottom - 8}"/>
    <line x1="18" y1="${midY}" x2="502" y2="${midY}"/>
  </g>`

  return `${cells.join('\n  ')}
  ${rules}`
}

/**
 * Compact layout masthead 16×2 (32-cell) Model Heatmap Ribbon (or Cache Waffle fallback).
 */
function buildCompactMastheadMatrix(
  groups: ReadonlyArray<AggregatedModelGroup>,
  cacheRate: number,
  language: PublicCardConfig['language'],
  palette: Palette,
  hasMastheadMeta: boolean
) {
  const cols = 16
  const rows = 2
  const cellSize = 5.4
  const gap = 1.6
  const startX = 391.6
  const startY = 10.5

  if (groups.length > 0) {
    const cells = buildHeatmapCells({ groups, cols, rows, startX, startY, cellSize, gap })
    const rects = cells.map((cell) => {
      const fill = seriesColor(cell.seriesIndex, cell.isOther, palette)
      return `<rect x="${cell.x}" y="${cell.y}" width="${cellSize}" height="${cellSize}" fill="${fill}"/>`
    })
    const topModel = truncateModelLabel(groups[0].label, 20)
    const caption = `${topModel} ${formatSharePercent(groups[0].share)}`
    const captionMarkup = hasMastheadMeta
      ? `<text x="385" y="21" text-anchor="end" fill="${palette.subtle}" font-family="${MONO_FONT}" font-size="7.8">${escapeXml(caption)}</text>`
      : `<text x="502" y="36.5" text-anchor="end" fill="${palette.subtle}" font-family="${MONO_FONT}" font-size="7.8">${escapeXml(caption)}</text>`

    return `<g data-card-model-matrix="true">
    ${rects.join('\n    ')}
    ${captionMarkup}
  </g>`
  }

  const totalCells = cols * rows
  const filledCells = Math.round(cacheRate * totalCells)
  const pitch = cellSize + gap
  const cells: string[] = []
  for (let idx = 0; idx < totalCells; idx += 1) {
    const col = Math.floor(idx / rows)
    const row = idx % rows
    const cx = Number((startX + col * pitch).toFixed(1))
    const cy = Number((startY + row * pitch).toFixed(1))
    if (idx < filledCells) {
      cells.push(`<rect x="${cx}" y="${cy}" width="${cellSize}" height="${cellSize}" fill="${palette.viz2}"/>`)
    } else {
      cells.push(
        `<rect x="${cx + 0.3}" y="${cy + 0.3}" width="${cellSize - 0.6}" height="${cellSize - 0.6}" fill="url(#folio-hatch)" stroke="${palette.viz2}" stroke-width="0.6"/>`
      )
    }
  }
  const pct = Math.round(cacheRate * 100)
  const caption = language === 'en' ? `CACHE ${pct}%` : `缓存 ${pct}%`
  const captionMarkup = hasMastheadMeta
    ? `<text x="385" y="21" text-anchor="end" fill="${palette.subtle}" font-family="${MONO_FONT}" font-size="7.8">${escapeXml(caption)}</text>`
    : `<text x="502" y="36.5" text-anchor="end" fill="${palette.subtle}" font-family="${MONO_FONT}" font-size="7.8">${escapeXml(caption)}</text>`

  return `<g data-card-cache-waffle="true">
    ${cells.join('\n    ')}
    ${captionMarkup}
  </g>`
}

function seriesColor(seriesIndex: number, isOther: boolean, palette: Palette) {
  if (isOther) return palette.vizOther
  const colors = [palette.viz2, palette.viz1, palette.viz3, palette.vizInk]
  return colors[seriesIndex % colors.length]
}

function fitBigNumberSize(value: string, baseSize: number, maxWidth: number) {
  const estimatedWidth = value.length * (baseSize * 0.57)
  if (estimatedWidth <= maxWidth) return baseSize
  const scaled = Math.floor((maxWidth / Math.max(1, value.length * 0.58)) * 2) / 2
  return Math.max(14, Math.min(baseSize, scaled))
}

function buildMastheadMeta(timezoneNote: string, updatedNote: string, isCompact: boolean, palette: Palette) {
  if (!timezoneNote && !updatedNote) return ''

  const text = timezoneNote && updatedNote ? `${timezoneNote} · ${updatedNote}` : timezoneNote || updatedNote
  const attrs = [
    timezoneNote ? 'data-card-timezone="true"' : '',
    updatedNote ? 'data-card-updated="true"' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const y = isCompact ? '36.5' : '24.5'

  return `<g ${attrs}><text x="502" y="${y}" text-anchor="end" fill="${palette.muted}" font-family="${MONO_FONT}" font-size="8.5">${escapeXml(text)}</text></g>`
}

function labels(language: PublicCardConfig['language']) {
  if (language === 'en') {
    return {
      title: 'TokenBoard Stats',
      costUnavailableNote: '* Some sources report no cost',
      metrics: {
        totalTokens: 'Total Tokens',
        totalTokensWithoutCacheRead: 'No Cache Read',
        totalCacheReadRate: 'Cache Read Rate',
        totalCost: 'Total Cost',
        monthTokens: 'Monthly Tokens',
        monthTokensWithoutCacheRead: 'Monthly No Cache Read',
        monthCacheReadRate: 'Monthly Cache Read',
        monthCost: 'Monthly Cost',
        todayTokens: 'Today Tokens',
        todayTokensWithoutCacheRead: 'Today No Cache Read',
        todayCacheReadRate: 'Today Cache Read',
        todayCost: 'Today Cost'
      } satisfies Record<PublicCardMetric, string>
    }
  }

  return {
    title: 'TokenBoard 统计',
    costUnavailableNote: '* 部分来源费用不可用',
    metrics: {
      totalTokens: '总 token',
      totalTokensWithoutCacheRead: '总量不含缓存读',
      totalCacheReadRate: '总缓存率',
      totalCost: '总额度',
      monthTokens: '本月 token',
      monthTokensWithoutCacheRead: '本月不含缓存读',
      monthCacheReadRate: '本月缓存率',
      monthCost: '本月额度',
      todayTokens: '今日 token',
      todayTokensWithoutCacheRead: '今日不含缓存读',
      todayCacheReadRate: '今日缓存率',
      todayCost: '今日额度'
    } satisfies Record<PublicCardMetric, string>
  }
}

function metricLabel(metric: PublicCardMetric, config: PublicCardConfig, marksUnavailableCost: boolean) {
  const label = labels(config.language).metrics[metric]
  return marksUnavailableCost && isCostMetric(metric) ? `${label}*` : label
}

function metricSubCaption(input: UsageCardInput, metric: PublicCardMetric, config: PublicCardConfig) {
  const isEn = config.language === 'en'
  const totalRate = resolvedCacheRate(input)
  const monthRate = resolvedRateForWindow(input.monthTokens, input.monthTokensWithoutCacheRead, input.monthCacheReadRate)
  const todayRate = resolvedRateForWindow(
    input.todayTokens ?? 0,
    input.todayTokensWithoutCacheRead,
    input.todayCacheReadRate
  )

  switch (metric) {
    case 'totalTokens': {
      const fresh = input.totalTokensWithoutCacheRead
      if (fresh !== undefined && fresh < input.totalTokens) {
        return isEn ? `Fresh ${formatEditorialTokens(fresh)}` : `不含缓存 ${formatEditorialTokens(fresh)}`
      }
      return isEn ? 'All-time volume' : '全周期累计'
    }
    case 'totalTokensWithoutCacheRead':
      return isEn ? `Cache ${formatPercentRate(totalRate)}` : `缓存命中 ${formatPercentRate(totalRate)}`
    case 'totalCacheReadRate': {
      if (totalRate > 0.05 && totalRate < 0.999) {
        const mult = (1 / (1 - totalRate)).toFixed(1)
        return isEn ? `↑ ${mult}× reuse` : `↑ ${mult}× 缓存复用`
      }
      return isEn ? 'Prompt cache hit' : '全局缓存复用'
    }
    case 'totalCost': {
      if (!costAvailabilityForMetric(input, 'totalCost')) {
        return isEn ? 'Partial billed' : '含未计费源'
      }
      return isEn ? `Month ${formatUsd(input.monthCostUsd)}` : `本月 ${formatUsd(input.monthCostUsd)}`
    }
    case 'monthTokens':
      return isEn ? `Cache ${formatPercentRate(monthRate)}` : `缓存命中 ${formatPercentRate(monthRate)}`
    case 'monthTokensWithoutCacheRead':
      return isEn ? `Cache ${formatPercentRate(monthRate)}` : `本月缓存 ${formatPercentRate(monthRate)}`
    case 'monthCacheReadRate': {
      if (monthRate > 0.05 && monthRate < 0.999) {
        const mult = (1 / (1 - monthRate)).toFixed(1)
        return isEn ? `↑ ${mult}× reuse` : `↑ ${mult}× 复用倍率`
      }
      return isEn ? 'Monthly cache' : '本月缓存复用'
    }
    case 'monthCost': {
      if (!costAvailabilityForMetric(input, 'monthCost')) {
        return isEn ? 'Partial billed' : '含未计费源'
      }
      if (input.totalCostUsd > 0) {
        const pct = Math.min(100, Math.round((input.monthCostUsd / input.totalCostUsd) * 100))
        return isEn ? `${pct}% of total` : `占总开销 ${pct}%`
      }
      return isEn ? 'Current month' : '当月计费开销'
    }
    case 'todayTokens': {
      const fresh = input.todayTokensWithoutCacheRead
      if (fresh !== undefined && fresh < (input.todayTokens ?? 0)) {
        return isEn ? `Fresh ${formatEditorialTokens(fresh)}` : `不含缓存 ${formatEditorialTokens(fresh)}`
      }
      return isEn ? 'Local day' : '当日累计'
    }
    case 'todayTokensWithoutCacheRead':
      return isEn ? `Cache ${formatPercentRate(todayRate)}` : `今日缓存 ${formatPercentRate(todayRate)}`
    case 'todayCacheReadRate':
      return isEn ? 'Today reuse' : '当日缓存复用'
    case 'todayCost': {
      if (!costAvailabilityForMetric(input, 'todayCost')) {
        return isEn ? 'Partial billed' : '含未计费源'
      }
      return isEn ? 'Billed today' : '当日计费开销'
    }
  }
}

function buildUnavailableCostNote(input: UsageCardInput, config: PublicCardConfig) {
  return visibleMetrics(config).some((metric) => isCostMetric(metric) && !costAvailabilityForMetric(input, metric))
    ? labels(config.language).costUnavailableNote
    : ''
}

function buildTimezoneNote(input: UsageCardInput, config: PublicCardConfig) {
  if (!input.timezoneLabel) return ''
  const showsToday = visibleMetrics(config).some((metric) => metric.startsWith('today'))
  if (!showsToday) return ''

  return config.language === 'en' ? `Today: ${input.timezoneLabel}` : `今日：${input.timezoneLabel}`
}

function buildUpdatedNote(input: UsageCardInput, config: PublicCardConfig) {
  if (!config.showUpdatedAt || !input.updatedAtLabel) return ''
  return config.language === 'en' ? `Updated: ${input.updatedAtLabel}` : `数据更新：${input.updatedAtLabel}`
}

function costAvailabilityForMetric(input: UsageCardInput, metric: PublicCardMetric) {
  if (metric === 'totalCost') return input.totalCostAvailable ?? true
  if (metric === 'monthCost') return input.monthCostAvailable ?? true
  if (metric === 'todayCost') return input.todayCostAvailable ?? true
  return true
}

function isCostMetric(metric: PublicCardMetric) {
  return metric === 'totalCost' || metric === 'monthCost' || metric === 'todayCost'
}

function subtitleText(input: UsageCardInput, config: PublicCardConfig) {
  if (!config.showPublicUrl) return input.displayName
  return `${input.displayName} · ${input.publicUrl}`
}

function resolvedRateForWindow(total: number, withoutCacheRead: number | undefined, explicitRate: number | undefined) {
  const rate =
    explicitRate ??
    cacheReadRateFromTotals({
      totalTokens: total,
      totalTokensWithoutCacheRead: withoutCacheRead ?? total
    })
  return Math.max(0, Math.min(1, Number.isFinite(rate) ? rate : 0))
}

function resolvedCacheRate(input: UsageCardInput) {
  return resolvedRateForWindow(input.totalTokens, input.totalTokensWithoutCacheRead, input.totalCacheReadRate)
}

function metricValue(input: UsageCardInput, metric: PublicCardMetric) {
  const values = {
    totalTokens: formatEditorialTokens(input.totalTokens),
    totalTokensWithoutCacheRead: formatEditorialTokens(input.totalTokensWithoutCacheRead ?? input.totalTokens),
    totalCacheReadRate: formatPercentRate(resolvedCacheRate(input)),
    totalCost: formatUsd(input.totalCostUsd),
    monthTokens: formatEditorialTokens(input.monthTokens),
    monthTokensWithoutCacheRead: formatEditorialTokens(input.monthTokensWithoutCacheRead ?? input.monthTokens),
    monthCacheReadRate: formatPercentRate(
      resolvedRateForWindow(input.monthTokens, input.monthTokensWithoutCacheRead, input.monthCacheReadRate)
    ),
    monthCost: formatUsd(input.monthCostUsd),
    todayTokens: formatEditorialTokens(input.todayTokens ?? 0),
    todayTokensWithoutCacheRead: formatEditorialTokens(input.todayTokensWithoutCacheRead ?? input.todayTokens ?? 0),
    todayCacheReadRate: formatPercentRate(
      resolvedRateForWindow(input.todayTokens ?? 0, input.todayTokensWithoutCacheRead, input.todayCacheReadRate)
    ),
    todayCost: formatUsd(input.todayCostUsd ?? 0)
  } satisfies Record<PublicCardMetric, string>
  return values[metric]
}

function glowDefinition(config: PublicCardConfig, palette: Palette) {
  const centers = {
    'top-right': { cx: '88%', cy: '14%' },
    'top-left': { cx: '12%', cy: '14%' },
    center: { cx: '50%', cy: '45%' }
  }
  const center = centers[config.glow.position]
  const opacity = (config.glow.intensity * 0.28).toFixed(2)
  return `<radialGradient id="glow" cx="${center.cx}" cy="${center.cy}" r="52%">
      <stop stop-color="${palette.glowColor}" stop-opacity="${opacity}"/>
      <stop offset="1" stop-color="${palette.glowColor}" stop-opacity="0"/>
    </radialGradient>`
}

/**
 * Matches the redesigned Swiss geometric TokenBoard T-monogram + 2x2 telemetry matrix in /public/logo.svg.
 */
function logoMark(palette: Palette) {
  return `<g transform="translate(18 12)">
    <rect width="24" height="24" fill="${palette.logoBg}"/>
    <rect x="0.5" y="0.5" width="23" height="23" fill="none" stroke="${palette.logoBorder}" stroke-width="0.9"/>
    <rect x="4" y="4.5" width="12" height="3.4" fill="${palette.logoInk}"/>
    <rect x="16.8" y="4.5" width="3.2" height="3.4" fill="${palette.logoCapstone}"/>
    <rect x="8.6" y="7.9" width="3.4" height="11.6" fill="${palette.logoInk}"/>
    <rect x="13.8" y="10.8" width="2.7" height="2.7" fill="${palette.viz2}"/>
    <rect x="17.3" y="10.8" width="2.7" height="2.7" fill="${palette.viz1}"/>
    <rect x="13.8" y="14.3" width="2.7" height="2.7" fill="${palette.viz3}"/>
    <rect x="17.6" y="14.6" width="2.1" height="2.1" fill="none" stroke="${palette.logoInk}" stroke-opacity="0.45" stroke-width="0.6"/>
    <line x1="13.8" y1="19.3" x2="20" y2="19.3" stroke="${palette.logoInk}" stroke-opacity="0.35" stroke-width="0.7"/>
  </g>`
}

function escapeXml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
