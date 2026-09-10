import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

describe('ccusage pricing configuration', () => {
  test('keeps Codex speed normalization on the ccusage automatic mode', async () => {
    const config = await readConfig()

    expect(config.codex?.defaults?.speed).toBe('auto')
  })

  test('uses ccusage 20.0.20-compatible Grok long-context fields', async () => {
    const config = await readConfig()
    const pricing = config.defaults.pricingOverrides

    expect(pricing['grok-4.5']).toEqual({
      cacheReadInputTokenCost: 0.3 / 1_000_000,
      cacheReadInputTokenCostAbove200kTokens: 0.6 / 1_000_000,
      inputCostPerToken: 2 / 1_000_000,
      inputCostPerTokenAbove200kTokens: 4 / 1_000_000,
      outputCostPerToken: 6 / 1_000_000,
      outputCostPerTokenAbove200kTokens: 12 / 1_000_000,
      maxInputTokens: 500_000
    })
  })

  test('does not encode the 272k GPT pricing threshold as ccusage Above200k fields', async () => {
    const config = await readConfig()
    const pricing = config.defaults.pricingOverrides
    const gptModels = [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.6',
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.4',
      'gpt-5.4-pro'
    ]

    for (const model of gptModels) {
      expect(Object.keys(pricing[model]).some((key) => key.endsWith('Above200kTokens'))).toBe(false)
      expect(pricing[model].maxInputTokens).toBeGreaterThan(272_000)
    }
  })

  test('does not invent a cache-read price for GPT-5.4 Pro', async () => {
    const config = await readConfig()

    expect(config.defaults.pricingOverrides['gpt-5.4-pro']).not.toHaveProperty('cacheReadInputTokenCost')
  })
})

async function readConfig() {
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
  return JSON.parse(await readFile(join(packageDir, 'ccusage.json'), 'utf8')) as {
    codex?: {
      defaults?: {
        speed?: string
      }
    }
    defaults: {
      pricingOverrides: Record<string, Record<string, number>>
    }
  }
}
