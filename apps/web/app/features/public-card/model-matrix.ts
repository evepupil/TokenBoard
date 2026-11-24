export type UsageCardModelSlice = {
  model: string
  totalTokens: number
}

export type AggregatedModelGroup = {
  key: string
  label: string
  tokens: number
  share: number
  isOther: boolean
  otherCount: number
  seriesIndex: number
}

export type AggregateCardModelsOptions = {
  language: 'zh' | 'en'
  /**
   * Optional total token denominator (e.g. `monthTokens`) when `models` only contains top-K rows
   * from SQL and there are additional tail models omitted beyond the LIMIT.
   */
  totalTokens?: number
  /**
   * Optional total distinct model count behind `totalTokens`.
   */
  totalModelCount?: number
  /**
   * Minimum share (0..1) required for a model to keep its own named cluster.
   * Models below this share are aggregated into "其他 N 个模型" / "Other N models".
   */
  minShare?: number
  /**
   * Maximum number of named model clusters before remaining models are folded into "Other".
   */
  maxNamedGroups?: number
}

export type HeatmapCell = {
  col: number
  row: number
  x: number
  y: number
  groupIndex: number
  seriesIndex: number
  isOther: boolean
}

export const DEFAULT_MIN_MODEL_SHARE = 0.05
export const DEFAULT_MAX_NAMED_MODELS = 4

export function aggregateCardModels(
  models: ReadonlyArray<UsageCardModelSlice> | undefined,
  options: AggregateCardModelsOptions
): { groups: AggregatedModelGroup[]; totalTokens: number; totalModelCount: number } {
  if (!models || models.length === 0) {
    return { groups: [], totalTokens: 0, totalModelCount: 0 }
  }

  const minShare = options.minShare ?? DEFAULT_MIN_MODEL_SHARE
  const maxNamed = Math.max(1, options.maxNamedGroups ?? DEFAULT_MAX_NAMED_MODELS)

  const cleaned = models
    .filter((entry) => entry.model.trim().length > 0 && Number.isFinite(entry.totalTokens) && entry.totalTokens > 0)
    .map((entry) => ({ model: entry.model.trim(), totalTokens: entry.totalTokens }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  if (cleaned.length === 0) {
    return { groups: [], totalTokens: 0, totalModelCount: 0 }
  }

  const listedSum = cleaned.reduce((sum, item) => sum + item.totalTokens, 0)
  const extraCount = Math.max(0, Math.round(options.totalModelCount ?? cleaned.length) - cleaned.length)
  const extraTokens =
    extraCount > 0 && options.totalTokens && options.totalTokens > listedSum ? options.totalTokens - listedSum : 0
  const denominator = listedSum + extraTokens
  if (denominator <= 0) {
    return { groups: [], totalTokens: 0, totalModelCount: 0 }
  }

  const named: Array<{ model: string; totalTokens: number; share: number }> = []
  let otherTokens = extraTokens
  let otherCount = extraCount

  for (const item of cleaned) {
    const share = item.totalTokens / denominator
    // Always keep at least the single largest model named so the matrix never collapses into a lone "Other" blob.
    const meetsThreshold = named.length === 0 || (named.length < maxNamed && share >= minShare)
    if (meetsThreshold) {
      named.push({ ...item, share })
    } else {
      otherTokens += item.totalTokens
      otherCount += 1
    }
  }

  const groups: AggregatedModelGroup[] = named.map((item, idx) => ({
    key: item.model,
    label: item.model,
    tokens: item.totalTokens,
    share: item.share,
    isOther: false,
    otherCount: 0,
    seriesIndex: idx
  }))

  if (otherCount > 0 && otherTokens > 0) {
    groups.push({
      key: '__other__',
      label: formatOtherModelsLabel(otherCount, options.language),
      tokens: otherTokens,
      share: otherTokens / denominator,
      isOther: true,
      otherCount,
      seriesIndex: 4
    })
  }

  return {
    groups,
    totalTokens: denominator,
    totalModelCount: cleaned.length + extraCount
  }
}

export function formatOtherModelsLabel(count: number, language: 'zh' | 'en') {
  if (language === 'en') {
    return count === 1 ? 'Other 1 model' : `Other ${count} models`
  }
  return `其他 ${count} 个模型`
}

/**
 * Largest-remainder (Hamilton) integer cell allocation across model groups.
 * Guarantees exact sum === totalCells and at least 1 cell for every non-empty group
 * whenever totalCells >= groups.length.
 */
export function allocateUnitCells(groups: ReadonlyArray<{ share: number }>, totalCells: number): number[] {
  if (groups.length === 0 || totalCells <= 0) return []
  if (groups.length === 1) return [totalCells]

  const totalShare = groups.reduce((sum, group) => sum + Math.max(0, group.share), 0)
  if (totalShare <= 0) return groups.map(() => 0)

  const exact = groups.map((group) => (Math.max(0, group.share) / totalShare) * totalCells)
  const counts = exact.map((val) => Math.floor(val))

  // Ensure every represented group gets at least 1 visible square when grid capacity permits.
  if (totalCells >= groups.length) {
    for (let i = 0; i < counts.length; i += 1) {
      if (counts[i] === 0 && groups[i].share > 0) {
        counts[i] = 1
      }
    }
  }

  let assigned = counts.reduce((sum, count) => sum + count, 0)

  if (assigned < totalCells) {
    const remainders = exact
      .map((val, idx) => ({ idx, rem: val - counts[idx] }))
      .sort((a, b) => b.rem - a.rem || a.idx - b.idx)
    let cursor = 0
    while (assigned < totalCells) {
      counts[remainders[cursor % remainders.length].idx] += 1
      assigned += 1
      cursor += 1
    }
  } else if (assigned > totalCells) {
    // Trim from the largest buckets with smallest fractional remainder without zeroing any 1-cell group.
    const trimOrder = exact
      .map((val, idx) => ({ idx, rem: val - Math.floor(val) }))
      .sort((a, b) => a.rem - b.rem || counts[b.idx] - counts[a.idx])
    let guard = 0
    while (assigned > totalCells && guard < totalCells * 2) {
      for (const item of trimOrder) {
        if (assigned <= totalCells) break
        if (counts[item.idx] > 1) {
          counts[item.idx] -= 1
          assigned -= 1
        }
      }
      guard += 1
    }
  }

  return counts
}

/**
 * Generates column-first heatmap cell coordinates (top-to-bottom within each column, advancing left-to-right),
 * matching GitHub's contribution heatmap flow so model shares read naturally as crisp color bands.
 */
export function buildHeatmapCells(input: {
  groups: ReadonlyArray<AggregatedModelGroup>
  cols: number
  rows: number
  startX: number
  startY: number
  cellSize: number
  gap: number
}): HeatmapCell[] {
  const totalCells = input.cols * input.rows
  const allocation = allocateUnitCells(input.groups, totalCells)
  const cells: HeatmapCell[] = []
  const pitch = input.cellSize + input.gap

  let cellIndex = 0
  for (let groupIndex = 0; groupIndex < input.groups.length; groupIndex += 1) {
    const group = input.groups[groupIndex]
    const count = allocation[groupIndex] ?? 0
    for (let k = 0; k < count && cellIndex < totalCells; k += 1) {
      const col = Math.floor(cellIndex / input.rows)
      const row = cellIndex % input.rows
      cells.push({
        col,
        row,
        x: Number((input.startX + col * pitch).toFixed(1)),
        y: Number((input.startY + row * pitch).toFixed(1)),
        groupIndex,
        seriesIndex: group.seriesIndex,
        isOther: group.isOther
      })
      cellIndex += 1
    }
  }

  return cells
}

/**
 * Editorial big-number formatter for SVG KPI strips:
 * - Below 1,000,000: keeps exact comma-separated integer (`128,420`, `345,678`, `1,200`)
 * - 1,000,000 and above: formats as crisp Swiss compact telemetry (`1.55B`, `482.9M`, `12.8M`)
 */
export function formatEditorialTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000_000_000) {
    const scaled = value / 1_000_000_000_000
    return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}T`
  }
  if (value >= 1_000_000_000) {
    const scaled = value / 1_000_000_000
    return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}B`
  }
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000
    return `${scaled >= 100 ? scaled.toFixed(1) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}M`
  }
  return new Intl.NumberFormat('en-US').format(Math.round(value))
}

export function formatUnitScaleTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) {
    const m = value / 1_000_000
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`
  }
  if (value >= 1_000) {
    const k = value / 1_000
    return `${k >= 10 ? k.toFixed(0) : k.toFixed(1)}K`
  }
  return `${Math.max(1, Math.round(value))}`
}

export function formatSharePercent(share: number): string {
  const pct = Math.max(0, Math.min(100, share * 100))
  return pct >= 10 || Math.abs(pct - Math.round(pct)) < 0.05 ? `${pct.toFixed(1).replace(/\.0$/, '')}%` : `${pct.toFixed(1)}%`
}

export function truncateModelLabel(label: string, maxChars = 17): string {
  if (label.length <= maxChars) return label
  return `${label.slice(0, Math.max(1, maxChars - 1))}…`
}
