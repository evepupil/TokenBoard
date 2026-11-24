import { describe, expect, test } from 'vitest'
import {
  computeFolioMatrixLayout,
  FOLIO_MATRIX_TOTAL_SQUARES,
  FOLIO_MATRIX_VIEWBOX_WIDTH,
  type FolioMatrixMode
} from './folio-matrix-layout'

describe('computeFolioMatrixLayout', () => {
  const modes: FolioMatrixMode[] = ['all', 'model', 'source', 'tokenType']

  test.each(modes)('produces exactly 400 positioned squares in %s mode within viewBox bounds', (mode) => {
    const layout = computeFolioMatrixLayout(mode)

    expect(layout.squares).toHaveLength(FOLIO_MATRIX_TOTAL_SQUARES)
    expect(layout.viewBoxWidth).toBe(FOLIO_MATRIX_VIEWBOX_WIDTH)
    expect(layout.viewBoxHeight).toBeGreaterThan(100)

    const groupTotal = layout.groups.reduce((sum, group) => sum + group.count, 0)
    expect(groupTotal).toBe(FOLIO_MATRIX_TOTAL_SQUARES)

    for (const sq of layout.squares) {
      expect(sq.x).toBeGreaterThanOrEqual(0)
      expect(sq.y).toBeGreaterThanOrEqual(0)
      expect(sq.x + layout.cellSize).toBeLessThanOrEqual(layout.viewBoxWidth + 0.5)
      expect(sq.y + layout.cellSize).toBeLessThanOrEqual(layout.viewBoxHeight + 0.5)
    }
  })

  test('arranges grouped model sub-matrices in non-overlapping two-column rows with headings', () => {
    const layout = computeFolioMatrixLayout('model')

    expect(layout.groups).toHaveLength(6)
    expect(layout.groups[0].headingText).toBe('claude-sonnet-4-6 · 1,194M (37.3%)')
    expect(layout.groups[0].headingX).toBe(0)
    expect(layout.groups[1].headingX).toBeGreaterThan(layout.groups[0].hitWidth)
    expect(layout.groups[2].headingY).toBeGreaterThan(layout.groups[0].hitY + layout.groups[0].hitHeight)
  })
})
