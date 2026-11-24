export type FolioMatrixMode = 'all' | 'model' | 'source' | 'tokenType'

export type FolioMatrixTone = 'muted' | 'violet' | 'vermilion' | 'magenta' | 'ink' | 'neutral'

export type FolioMatrixGroupSpec = {
  id: string
  label: string
  tokensLabel: string
  percentLabel: string
  count: number
  tone: FolioMatrixTone
}

export type FolioMatrixSquare = {
  index: number
  x: number
  y: number
  tone: FolioMatrixTone
  groupId: string
  staggerMs: number
}

export type FolioMatrixGroupBox = {
  id: string
  categoryLabel: string
  label: string
  tokensLabel: string
  percentLabel: string
  headingText: string
  headingX: number
  headingY: number
  hitX: number
  hitY: number
  hitWidth: number
  hitHeight: number
  count: number
  tone: FolioMatrixTone
}

export type FolioMatrixLayout = {
  mode: FolioMatrixMode
  categoryLabel: string
  viewBoxWidth: number
  viewBoxHeight: number
  cellSize: number
  squares: FolioMatrixSquare[]
  groups: FolioMatrixGroupBox[]
}

export const FOLIO_MATRIX_TOTAL_SQUARES = 400
export const FOLIO_MATRIX_VIEWBOX_WIDTH = 640

const ALL_COLS = 25
const GROUP_COLS = 15
const GROUP_COLUMN_GAP = 24
const GROUP_LABEL_HEIGHT = 22
const GROUP_ROW_GAP = 26

const MODE_META: Record<FolioMatrixMode, { categoryLabel: string; groups: FolioMatrixGroupSpec[] }> = {
  all: {
    categoryLabel: '全部',
    groups: [
      {
        id: 'all-tokens',
        label: '全周期累计吞吐',
        tokensLabel: '3.20B Tokens',
        percentLabel: '100.0%',
        count: 400,
        tone: 'muted'
      }
    ]
  },
  model: {
    categoryLabel: '按模型',
    groups: [
      {
        id: 'claude-sonnet-4-6',
        label: 'claude-sonnet-4-6',
        tokensLabel: '1,194M',
        percentLabel: '37.3%',
        count: 149,
        tone: 'violet'
      },
      {
        id: 'gemini-4-hydrogen',
        label: 'gemini-4-hydrogen',
        tokensLabel: '824M',
        percentLabel: '25.7%',
        count: 103,
        tone: 'vermilion'
      },
      {
        id: 'gpt-5.4-codex',
        label: 'gpt-5.4-codex',
        tokensLabel: '666M',
        percentLabel: '20.8%',
        count: 83,
        tone: 'magenta'
      },
      {
        id: 'gemini-2.5-pro',
        label: 'gemini-2.5-pro',
        tokensLabel: '170M',
        percentLabel: '5.3%',
        count: 21,
        tone: 'ink'
      },
      {
        id: 'claude-opus-4-6',
        label: 'claude-opus-4-6',
        tokensLabel: '137M',
        percentLabel: '4.3%',
        count: 17,
        tone: 'neutral'
      },
      {
        id: 'other-models',
        label: '其他 2 个模型',
        tokensLabel: '212M',
        percentLabel: '6.6%',
        count: 27,
        tone: 'violet'
      }
    ]
  },
  source: {
    categoryLabel: '按工具源',
    groups: [
      {
        id: 'claude-code',
        label: 'Claude Code',
        tokensLabel: '1,760M',
        percentLabel: '55.0%',
        count: 220,
        tone: 'violet'
      },
      {
        id: 'codex',
        label: 'Codex',
        tokensLabel: '896M',
        percentLabel: '28.0%',
        count: 112,
        tone: 'vermilion'
      },
      {
        id: 'antigravity',
        label: 'Antigravity',
        tokensLabel: '352M',
        percentLabel: '11.0%',
        count: 44,
        tone: 'magenta'
      },
      {
        id: 'opencode',
        label: 'OpenCode',
        tokensLabel: '128M',
        percentLabel: '4.0%',
        count: 16,
        tone: 'ink'
      },
      {
        id: 'other-sources',
        label: 'Pi 与其他工具源',
        tokensLabel: '64M',
        percentLabel: '2.0%',
        count: 8,
        tone: 'neutral'
      }
    ]
  },
  tokenType: {
    categoryLabel: '按 Token 类型',
    groups: [
      {
        id: 'cache-read',
        label: 'Prompt Cache 缓存读',
        tokensLabel: '2,944M',
        percentLabel: '92.0%',
        count: 368,
        tone: 'violet'
      },
      {
        id: 'fresh-input',
        label: '新增输入与缓存写入',
        tokensLabel: '192M',
        percentLabel: '6.0%',
        count: 24,
        tone: 'vermilion'
      },
      {
        id: 'output',
        label: '输出与推理生成',
        tokensLabel: '64M',
        percentLabel: '2.0%',
        count: 8,
        tone: 'magenta'
      }
    ]
  }
}

export function isFolioMatrixMode(value: string): value is FolioMatrixMode {
  return value === 'all' || value === 'model' || value === 'source' || value === 'tokenType'
}

export function computeFolioMatrixLayout(mode: FolioMatrixMode): FolioMatrixLayout {
  const { categoryLabel, groups: specs } = MODE_META[mode]
  const viewBoxWidth = FOLIO_MATRIX_VIEWBOX_WIDTH

  if (mode === 'all') {
    const gap = 4.2
    const cellSize = Number(((viewBoxWidth - (ALL_COLS - 1) * gap) / ALL_COLS).toFixed(2))
    const step = cellSize + gap
    const rows = Math.ceil(FOLIO_MATRIX_TOTAL_SQUARES / ALL_COLS)
    const gridHeight = Number((rows * cellSize + (rows - 1) * gap).toFixed(2))
    const squares: FolioMatrixSquare[] = []

    for (let i = 0; i < FOLIO_MATRIX_TOTAL_SQUARES; i += 1) {
      const col = i % ALL_COLS
      const row = Math.floor(i / ALL_COLS)
      squares.push({
        index: i,
        x: Number((col * step).toFixed(2)),
        y: Number((row * step).toFixed(2)),
        tone: 'muted',
        groupId: specs[0].id,
        staggerMs: Math.round(((col + row) / (ALL_COLS + rows)) * 120)
      })
    }

    return {
      mode,
      categoryLabel,
      viewBoxWidth,
      viewBoxHeight: gridHeight,
      cellSize,
      squares,
      groups: [
        {
          id: specs[0].id,
          categoryLabel,
          label: specs[0].label,
          tokensLabel: specs[0].tokensLabel,
          percentLabel: specs[0].percentLabel,
          headingText: '',
          headingX: 0,
          headingY: 0,
          hitX: 0,
          hitY: 0,
          hitWidth: viewBoxWidth,
          hitHeight: gridHeight,
          count: FOLIO_MATRIX_TOTAL_SQUARES,
          tone: 'muted'
        }
      ]
    }
  }

  // Two-column Swiss grouped sub-matrix layout matching Folio #s01
  const colWidth = (viewBoxWidth - GROUP_COLUMN_GAP) / 2 // 308
  const gap = 3.8
  const cellSize = Number(((colWidth - (GROUP_COLS - 1) * gap) / GROUP_COLS).toFixed(2))
  const step = cellSize + gap

  const squares: FolioMatrixSquare[] = []
  const groups: FolioMatrixGroupBox[] = []
  let squareCursor = 0
  let currentY = 0

  for (let rowPair = 0; rowPair < specs.length; rowPair += 2) {
    const pair = [specs[rowPair], specs[rowPair + 1]].filter((item): item is FolioMatrixGroupSpec => Boolean(item))
    let maxRowBlockHeight = 0

    pair.forEach((spec, colIdx) => {
      const originX = colIdx === 0 ? 0 : colWidth + GROUP_COLUMN_GAP
      const gridTopY = currentY + GROUP_LABEL_HEIGHT
      const groupRows = Math.max(1, Math.ceil(spec.count / GROUP_COLS))
      const gridHeight = Number((groupRows * cellSize + (groupRows - 1) * gap).toFixed(2))
      maxRowBlockHeight = Math.max(maxRowBlockHeight, GROUP_LABEL_HEIGHT + gridHeight)

      groups.push({
        id: spec.id,
        categoryLabel,
        label: spec.label,
        tokensLabel: spec.tokensLabel,
        percentLabel: spec.percentLabel,
        headingText: `${spec.label} · ${spec.tokensLabel} (${spec.percentLabel})`,
        headingX: Number(originX.toFixed(2)),
        headingY: Number((currentY + 13).toFixed(2)),
        hitX: Number(originX.toFixed(2)),
        hitY: Number(gridTopY.toFixed(2)),
        hitWidth: Number(colWidth.toFixed(2)),
        hitHeight: gridHeight,
        count: spec.count,
        tone: spec.tone
      })

      for (let localIdx = 0; localIdx < spec.count; localIdx += 1) {
        const localCol = localIdx % GROUP_COLS
        const localRow = Math.floor(localIdx / GROUP_COLS)
        squares.push({
          index: squareCursor,
          x: Number((originX + localCol * step).toFixed(2)),
          y: Number((gridTopY + localRow * step).toFixed(2)),
          tone: spec.tone,
          groupId: spec.id,
          staggerMs: Math.round(((localCol + localRow) / (GROUP_COLS + groupRows)) * 130)
        })
        squareCursor += 1
      }
    })

    currentY += maxRowBlockHeight + GROUP_ROW_GAP
  }

  return {
    mode,
    categoryLabel,
    viewBoxWidth,
    viewBoxHeight: Number(Math.max(0, currentY - GROUP_ROW_GAP).toFixed(2)),
    cellSize,
    squares,
    groups
  }
}
