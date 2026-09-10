import { describe, expect, test } from 'vitest'
import {
  markAntigravityFileScanned,
  selectAntigravityFileScanIds,
  type AntigravityFileScanState
} from './antigravity-file-scan'

describe('selectAntigravityFileScanIds', () => {
  test('reserves refresh capacity while unseen files fill the discovery budget', () => {
    const state = scanState()
    markFile(state, 'known-stale', { checkedSequence: 1, mtimeMs: 1 })
    markFile(state, 'known-hot', { checkedSequence: 9, mtimeMs: 100 })

    const selected = selectAntigravityFileScanIds(
      ['known-stale', 'known-hot', 'unseen-1', 'unseen-2', 'unseen-3', 'unseen-4'],
      state,
      4
    )

    expect(selected.filter((id) => id.startsWith('unseen-'))).toHaveLength(2)
    expect(selected).toEqual(expect.arrayContaining(['known-stale', 'known-hot']))
  })

  test('mixes hot cached files with the stalest refresh candidates', () => {
    const state = scanState()
    for (let index = 1; index <= 6; index += 1) {
      markFile(state, `known-${index}`, {
        checkedSequence: index,
        mtimeMs: index >= 5 ? index * 100 : index
      })
    }

    const selected = selectAntigravityFileScanIds(
      Array.from({ length: 6 }, (_, index) => `known-${index + 1}`),
      state,
      4
    )

    expect(selected).toEqual(expect.arrayContaining(['known-1', 'known-2', 'known-5', 'known-6']))
  })
})

function scanState(): AntigravityFileScanState {
  return { nextSequence: 10, files: {} }
}

function markFile(state: AntigravityFileScanState, id: string, input: { checkedSequence: number; mtimeMs: number }) {
  markAntigravityFileScanned(
    state,
    id,
    {
      mtimeMs: input.mtimeMs,
      size: 1,
      hasDatabaseFile: true
    },
    input.checkedSequence
  )
}
