import { describe, expect, test } from 'vitest'
import { errorMessage } from './error-message'

describe('errorMessage', () => {
  test('normalizes empty thrown values', () => {
    expect(errorMessage(new Error(''))).toBe('Error')
    expect(errorMessage('')).toBe('Unknown error')
  })

  test('does not throw while formatting hostile thrown values', () => {
    expect(errorMessage(Object.create(null))).toBe('Unknown error')
    expect(
      errorMessage({
        toString: () => {
          throw new Error('failed')
        }
      })
    ).toBe('Unknown error')
  })
})
