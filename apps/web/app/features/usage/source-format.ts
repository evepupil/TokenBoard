import { costUnavailableSources } from '@tokenboard/usage-core'
import { formatUsd } from '../../lib/money'

const costUnavailableLabels: Record<string, string> = {
  'antigravity-cli': 'Antigravity CLI 费用不可用',
  antigravity: 'Antigravity 费用不可用',
  'antigravity-ide': 'Antigravity IDE 费用不可用',
  'grok-build': 'Grok Build 费用不可用',
  'deepseek-harness': 'DeepSeek Harness 费用不可用'
}
const costUnavailableSourceSet = new Set<string>(costUnavailableSources)
const antigravityCollectiveLabel = 'Antigravity 费用不可用'
const mixedCollectiveLabel = '部分来源费用不可用'

const sourceLabels: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'antigravity-cli': 'Antigravity CLI (agy)',
  antigravity: 'Antigravity',
  'antigravity-ide': 'Antigravity IDE',
  opencode: 'OpenCode',
  pi: 'Pi',
  'grok-build': 'Grok Build',
  'deepseek-harness': 'DeepSeek Harness',
  all: '全部来源'
}

export type SourceSplitItem = {
  source: string
}

export function formatSource(source: string) {
  return sourceLabels[source] ?? source
}

export function hasUnavailableCostSource(sourceSplit: SourceSplitItem[]) {
  return sourceSplit.some((item) => costUnavailableSourceSet.has(item.source))
}

/**
 * The notice to show beside an aggregate cost, naming the single unavailable
 * source when there is only one and staying generic when several disagree.
 * Returns an empty string when every source in the split reports cost.
 */
export function formatUnavailableCostLabel(sourceSplit: SourceSplitItem[]) {
  const sources = unavailableCostSources(sourceSplit)
  if (sources.length === 0) return ''
  if (sources.length === 1) return costUnavailableLabel(sources[0])
  return sources.every(isAntigravitySource) ? antigravityCollectiveLabel : mixedCollectiveLabel
}

export function formatCostWithAvailability(costUsd: number, sourceSplit: SourceSplitItem[]) {
  const formatted = formatUsd(costUsd)
  const label = formatUnavailableCostLabel(sourceSplit)
  return label ? `${formatted} (${label})` : formatted
}

export function formatModelCostWithAvailability(
  costUsd: number,
  modelSourceSplit: SourceSplitItem[] | undefined,
  reportSourceSplit: SourceSplitItem[]
) {
  if (modelSourceSplit?.length) return formatCostWithAvailability(costUsd, modelSourceSplit)
  const formatted = formatUsd(costUsd)
  return hasUnavailableCostSource(reportSourceSplit) ? `${formatted} (费用可用性未知)` : formatted
}

export function formatSourceCostNote(source: string) {
  return costUnavailableSourceSet.has(source) ? costUnavailableLabel(source) : ''
}

/**
 * The collective notice for card details and page prose, where naming every
 * unavailable source would be too long. Keeps reading as
 * `Antigravity 费用不可用` while Antigravity is the only unavailable family, so
 * existing surfaces are unchanged for users who only run Antigravity.
 */
export function formatCostUnavailableNotice(sourceSplit: SourceSplitItem[]) {
  const sources = unavailableCostSources(sourceSplit)
  if (sources.length === 0) return ''
  if (sources.every(isAntigravitySource)) return antigravityCollectiveLabel
  if (sources.length === 1) return costUnavailableLabel(sources[0])
  return mixedCollectiveLabel
}

/**
 * Short name of the unavailable-cost source family, for labels that already
 * carry their own wording (`范围费用(不含 …)`). Reads `Antigravity` while
 * Antigravity is the only unavailable family.
 */
export function formatCostUnavailableSourceName(sourceSplit: SourceSplitItem[]) {
  const sources = unavailableCostSources(sourceSplit)
  if (sources.length === 0) return ''
  if (sources.every(isAntigravitySource)) return 'Antigravity'
  if (sources.length === 1) return formatSource(sources[0])
  return '无费用来源'
}

/** Every source whose cost is unavailable, named for platform-wide notices. */
export function costUnavailableSourceNames() {
  return [
    ...new Set(
      costUnavailableSources.map((source) => (isAntigravitySource(source) ? 'Antigravity' : formatSource(source)))
    )
  ]
}

function unavailableCostSources(sourceSplit: SourceSplitItem[]) {
  return [...new Set(sourceSplit.map((item) => item.source).filter((source) => costUnavailableSourceSet.has(source)))]
}

function costUnavailableLabel(source: string) {
  return costUnavailableLabels[source] ?? `${formatSource(source)} 费用不可用`
}

function isAntigravitySource(source: string) {
  return source === 'antigravity' || source.startsWith('antigravity-')
}
