import { describe, expect, test, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'

describe('clipboard utilities', () => {
  test('copies text with the provided clipboard writer', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)

    await expect(copyTextToClipboard({ writeText }, 'install prompt')).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('install prompt')
  })

  test('reports failure when clipboard writing is unavailable', async () => {
    await expect(copyTextToClipboard(undefined, 'install prompt')).resolves.toBe(false)
  })
})
