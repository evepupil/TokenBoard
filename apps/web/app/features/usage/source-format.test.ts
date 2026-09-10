import { describe, expect, test } from 'vitest'
import { costUnavailableSources } from '@tokenboard/usage-core'
import {
  costUnavailableSourceNames,
  formatCostUnavailableNotice,
  formatCostUnavailableSourceName,
  formatCostWithAvailability,
  formatSource,
  formatSourceCostNote,
  hasUnavailableCostSource
} from './source-format'

describe('source-format', () => {
  test('formats all Antigravity sources', () => {
    expect(formatSource('antigravity-cli')).toBe('Antigravity CLI (agy)')
    expect(formatSource('antigravity')).toBe('Antigravity')
    expect(formatSource('antigravity-ide')).toBe('Antigravity IDE')
  })

  test('marks all Antigravity sources as cost unavailable', () => {
    const sourceSplit = [{ source: 'codex' }, { source: 'antigravity-ide' }]

    expect(hasUnavailableCostSource(sourceSplit)).toBe(true)
    expect(formatCostWithAvailability(0.42, sourceSplit)).toBe('$0.42 (Antigravity IDE 费用不可用)')
    expect(formatSourceCostNote('antigravity')).toBe('Antigravity 费用不可用')
    expect(formatSourceCostNote('antigravity-cli')).toBe('Antigravity CLI 费用不可用')
    expect(formatCostWithAvailability(0.42, [{ source: 'antigravity-cli' }, { source: 'antigravity-ide' }])).toBe(
      '$0.42 (Antigravity 费用不可用)'
    )
  })

  test('formats the new sources', () => {
    expect(formatSource('opencode')).toBe('OpenCode')
    expect(formatSource('pi')).toBe('Pi')
    expect(formatSource('grok-build')).toBe('Grok Build')
    expect(formatSource('deepseek-harness')).toBe('DeepSeek Harness')
    expect(formatSource('unknown-tool')).toBe('unknown-tool')
  })

  test('treats Grok Build and DeepSeek Harness cost as unavailable', () => {
    expect(hasUnavailableCostSource([{ source: 'grok-build' }])).toBe(true)
    expect(hasUnavailableCostSource([{ source: 'deepseek-harness' }])).toBe(true)
    expect(hasUnavailableCostSource([{ source: 'opencode' }, { source: 'pi' }])).toBe(false)

    expect(formatCostWithAvailability(0.42, [{ source: 'grok-build' }])).toBe('$0.42 (Grok Build 费用不可用)')
    expect(formatSourceCostNote('deepseek-harness')).toBe('DeepSeek Harness 费用不可用')
  })

  test('stays generic when unavailable sources span different families', () => {
    const mixed = [{ source: 'antigravity-cli' }, { source: 'grok-build' }]

    expect(formatCostWithAvailability(0.42, mixed)).toBe('$0.42 (部分来源费用不可用)')
    expect(formatCostUnavailableNotice(mixed)).toBe('部分来源费用不可用')
    expect(formatCostUnavailableSourceName(mixed)).toBe('无费用来源')
  })

  test('keeps Antigravity wording when it is the only unavailable family', () => {
    const antigravityOnly = [{ source: 'codex' }, { source: 'antigravity-ide' }]

    expect(formatCostUnavailableNotice(antigravityOnly)).toBe('Antigravity 费用不可用')
    expect(formatCostUnavailableSourceName(antigravityOnly)).toBe('Antigravity')
    expect(formatCostUnavailableNotice([{ source: 'codex' }])).toBe('')
    expect(formatCostUnavailableSourceName([{ source: 'codex' }])).toBe('')
  })

  test('names a single non-Antigravity unavailable source', () => {
    expect(formatCostUnavailableNotice([{ source: 'grok-build' }])).toBe('Grok Build 费用不可用')
    expect(formatCostUnavailableSourceName([{ source: 'grok-build' }])).toBe('Grok Build')
  })

  test('lists every cost-unavailable source family once', () => {
    expect(costUnavailableSourceNames()).toEqual(['Antigravity', 'Grok Build', 'DeepSeek Harness'])
  })

  test('derives unavailable-cost detection from the shared source contract', () => {
    expect(costUnavailableSources.every((source) => hasUnavailableCostSource([{ source }]))).toBe(true)
  })

  test('does not treat inherited object keys as unavailable-cost sources', () => {
    expect(hasUnavailableCostSource([{ source: 'toString' }])).toBe(false)
    expect(formatCostWithAvailability(0.42, [{ source: 'toString' }])).toBe('$0.42')
    expect(formatSourceCostNote('toString')).toBe('')
  })
})
