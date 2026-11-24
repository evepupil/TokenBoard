import { describe, expect, test } from 'vitest'
import {
  aggregateCardModels,
  allocateUnitCells,
  buildHeatmapCells,
  formatEditorialTokens,
  truncateModelLabel
} from './model-matrix'

describe('public card model matrix aggregation', () => {
  test('folds models below the 5% threshold into "其他 N 个模型" (zh) and "Other N models" (en)', () => {
    const models = [
      { model: 'claude-sonnet-4-6', totalTokens: 1_194_000_000 },
      { model: 'gemini-4-hydrogen', totalTokens: 824_000_000 },
      { model: 'gpt-5.4-codex', totalTokens: 666_000_000 },
      { model: 'gemini-2.5-pro', totalTokens: 170_000_000 },
      { model: 'claude-opus-4-6', totalTokens: 137_000_000 },
      { model: 'deepseek-r1', totalTokens: 118_000_000 },
      { model: 'o3-mini', totalTokens: 91_000_000 }
    ]

    const zh = aggregateCardModels(models, { language: 'zh' })
    expect(zh.totalModelCount).toBe(7)
    expect(zh.groups.map((g) => g.label)).toEqual([
      'claude-sonnet-4-6',
      'gemini-4-hydrogen',
      'gpt-5.4-codex',
      'gemini-2.5-pro',
      '其他 3 个模型'
    ])
    expect(zh.groups[4]).toMatchObject({
      isOther: true,
      otherCount: 3,
      tokens: 346_000_000
    })

    const en = aggregateCardModels(models, { language: 'en' })
    expect(en.groups[4].label).toBe('Other 3 models')
  })

  test('incorporates omitted tail models beyond SQL top-K into the folded "Other" group', () => {
    const topFive = [
      { model: 'claude-sonnet-4-6', totalTokens: 500 },
      { model: 'gpt-5.4-codex', totalTokens: 300 },
      { model: 'gemini-2.5-pro', totalTokens: 120 },
      { model: 'o3-mini', totalTokens: 30 },
      { model: 'haiku-4', totalTokens: 20 }
    ]

    const result = aggregateCardModels(topFive, {
      language: 'zh',
      totalTokens: 1000,
      totalModelCount: 8
    })

    // Top 3 meet >= 5%; o3-mini (3%), haiku-4 (2%), plus 3 unlisted models (30 tokens) => 5 other models
    expect(result.groups.map((g) => g.label)).toEqual([
      'claude-sonnet-4-6',
      'gpt-5.4-codex',
      'gemini-2.5-pro',
      '其他 5 个模型'
    ])
    expect(result.groups[3]).toMatchObject({
      isOther: true,
      otherCount: 5,
      tokens: 80
    })
  })

  test('keeps the top model named even when every model is below the share threshold', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      model: `model-${i + 1}`,
      totalTokens: 40 - i
    }))
    const result = aggregateCardModels(many, { language: 'en', minShare: 0.1 })
    expect(result.groups).toHaveLength(2)
    expect(result.groups[0].label).toBe('model-1')
    expect(result.groups[1].label).toBe('Other 24 models')
  })

  test('allocates exact cell totals with Hamilton rounding and preserves at least 1 cell per group', () => {
    const allocation = allocateUnitCells(
      [{ share: 0.72 }, { share: 0.2 }, { share: 0.06 }, { share: 0.018 }, { share: 0.002 }],
      240
    )
    expect(allocation.reduce((sum, n) => sum + n, 0)).toBe(240)
    expect(allocation.every((n) => n >= 1)).toBe(true)
  })

  test('builds column-first heatmap cell coordinates covering the entire grid', () => {
    const { groups } = aggregateCardModels(
      [
        { model: 'claude-sonnet-4-6', totalTokens: 60 },
        { model: 'gpt-5.4-codex', totalTokens: 40 }
      ],
      { language: 'zh' }
    )
    const cells = buildHeatmapCells({
      groups,
      cols: 10,
      rows: 5,
      startX: 18,
      startY: 120,
      cellSize: 8,
      gap: 2
    })
    expect(cells).toHaveLength(50)
    // Column-first: index 0 is (col 0, row 0), index 1 is (col 0, row 1), index 5 is (col 1, row 0)
    expect(cells[0]).toMatchObject({ col: 0, row: 0, x: 18, y: 120, seriesIndex: 0 })
    expect(cells[1]).toMatchObject({ col: 0, row: 1, x: 18, y: 130, seriesIndex: 0 })
    expect(cells[5]).toMatchObject({ col: 1, row: 0, x: 28, y: 120, seriesIndex: 0 })
    expect(cells[30]).toMatchObject({ col: 6, row: 0, seriesIndex: 1 })
  })

  test('formats editorial tokens with exact commas below 1M and Swiss compact units at 1M+', () => {
    expect(formatEditorialTokens(0)).toBe('0')
    expect(formatEditorialTokens(860)).toBe('860')
    expect(formatEditorialTokens(1200)).toBe('1,200')
    expect(formatEditorialTokens(345678)).toBe('345,678')
    expect(formatEditorialTokens(1_234_567)).toBe('1.23M')
    expect(formatEditorialTokens(12_842_000)).toBe('12.8M')
    expect(formatEditorialTokens(482_910_000)).toBe('482.9M')
    expect(formatEditorialTokens(1_550_420_000)).toBe('1.55B')
  })

  test('truncates overly long model identifiers gracefully', () => {
    expect(truncateModelLabel('claude-sonnet-4-6', 18)).toBe('claude-sonnet-4-6')
    expect(truncateModelLabel('claude-3-7-sonnet-20250219', 17)).toBe('claude-3-7-sonne…')
  })
})
