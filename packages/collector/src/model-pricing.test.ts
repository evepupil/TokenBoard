import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createCcusagePricingOverrides,
  dynamicCcusageConfigPath,
  endpointOriginFromEndpoint,
  fetchModelPricingCatalogue,
  loadModelPricingCatalogue,
  modelPricingUrl,
  prepareDynamicCcusageConfig,
  resetModelPricingMemo,
  validateModelPricingResponse,
  type CollectorPricingModel,
  type PricingFetcher
} from './model-pricing'
import { selectUnambiguousDynamicPricingModels } from './providers/codex-context-pricing'

const tempDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('model pricing catalogue client', () => {
  test('derives the endpoint origin and builds cursor URLs without retaining endpoint paths', () => {
    expect(endpointOriginFromEndpoint('https://tokenboard.example/api/v1/ingest')).toBe('https://tokenboard.example')
    expect(endpointOriginFromEndpoint('not a URL')).toBeNull()
    expect(modelPricingUrl('https://tokenboard.example', 'opaque cursor')).toBe(
      'https://tokenboard.example/api/v1/model-pricing?limit=1000&cursor=opaque+cursor'
    )
  })

  // Both an unset endpoint and an unusable one fall back the same way, but the log line has to
  // say which, or an operator with a typo'd `TOKENBOARD_ENDPOINT` is told to configure it.
  test('distinguishes an invalid endpoint from an unset one in the fallback diagnostic', async () => {
    const stateDir = await tempDirectory()

    const unsetDiagnostics: string[] = []
    await loadModelPricingCatalogue({
      endpoint: undefined,
      stateDir,
      stderr: (line) => unsetDiagnostics.push(line),
      fetcher: async () => {
        throw new Error('network should not be used without an endpoint')
      }
    })
    expect(unsetDiagnostics.join('\n')).toContain('TOKENBOARD_ENDPOINT is not configured')

    const invalidDiagnostics: string[] = []
    await loadModelPricingCatalogue({
      endpoint: 'not-a-url',
      stateDir,
      stderr: (line) => invalidDiagnostics.push(line),
      fetcher: async () => {
        throw new Error('network should not be used with an invalid endpoint')
      }
    })
    const invalidOutput = invalidDiagnostics.join('\n')
    expect(invalidOutput).toContain('TOKENBOARD_ENDPOINT is invalid')
    expect(invalidOutput).not.toContain('is not configured')
  })

  test('reads every catalogue page and rejects a cursor loop', async () => {
    const stateDir = await tempDirectory()
    const requests: string[] = []
    const fetcher: PricingFetcher = async (input) => {
      const url = new URL(String(input))
      requests.push(url.toString())
      if (url.searchParams.get('cursor') === null)
        return jsonResponse({ models: [model('gpt-6-astra')], nextCursor: 'page-2' })
      return jsonResponse({ models: [model('grok-4.6')], nextCursor: null })
    }

    const result = await loadModelPricingCatalogue({
      endpoint: 'https://tokenboard.example/api/v1/ingest',
      stateDir,
      now: new Date('2026-09-10T00:00:00.000Z'),
      fetcher
    })

    expect(result.source).toBe('network')
    expect(result.models.map(({ modelId }) => modelId)).toEqual(['gpt-6-astra', 'grok-4.6'])
    expect(requests).toEqual([
      'https://tokenboard.example/api/v1/model-pricing?limit=1000',
      'https://tokenboard.example/api/v1/model-pricing?limit=1000&cursor=page-2'
    ])

    await expect(
      fetchModelPricingCatalogue({
        endpointOrigin: 'https://loop.example',
        cached: null,
        now: new Date('2026-09-10T00:00:00.000Z'),
        fetcher: async (input) => {
          const cursor = new URL(String(input)).searchParams.get('cursor')
          return jsonResponse({ models: [model(cursor ? 'looped-2' : 'looped')], nextCursor: 'same' })
        }
      })
    ).rejects.toThrow('cursor loop')
  })

  test('uses a fresh cache without network and refreshes an expired cache with ETag/304', async () => {
    const stateDir = await tempDirectory()
    const firstRequests: Request[] = []
    const first = await loadModelPricingCatalogue({
      endpoint: 'https://tokenboard.example',
      stateDir,
      now: new Date('2026-09-10T00:00:00.000Z'),
      fetcher: async (input, init) => {
        firstRequests.push(new Request(input, init))
        return jsonResponse({ models: [model('gpt-6-astra')], nextCursor: null }, { ETag: '"catalogue-v1"' })
      }
    })
    expect(first.source).toBe('network')

    let freshCalls = 0
    const fresh = await loadModelPricingCatalogue({
      endpoint: 'https://tokenboard.example',
      stateDir,
      now: new Date('2026-09-10T12:00:00.000Z'),
      fetcher: async () => {
        freshCalls += 1
        throw new Error('network should not be used for a fresh cache')
      }
    })
    expect(fresh.source).toBe('cache')
    expect(freshCalls).toBe(0)

    const expiredRequests: Request[] = []
    const refreshed = await loadModelPricingCatalogue({
      endpoint: 'https://tokenboard.example',
      stateDir,
      now: new Date('2026-09-11T00:00:01.000Z'),
      fetcher: async (input, init) => {
        expiredRequests.push(new Request(input, init))
        return new Response(null, { status: 304 })
      }
    })
    expect(refreshed.source).toBe('network')
    expect(refreshed.fetchedAt).toBe('2026-09-11T00:00:01.000Z')
    expect(firstRequests[0]?.headers.get('if-none-match')).toBeNull()
    expect(expiredRequests[0]?.headers.get('if-none-match')).toBe('"catalogue-v1"')
  })

  test('falls back from network to stale cache, then to bundled static pricing, and keeps hook mode offline', async () => {
    const stateDir = await tempDirectory()
    await loadModelPricingCatalogue({
      endpoint: 'https://tokenboard.example',
      stateDir,
      now: new Date('2026-09-01T00:00:00.000Z'),
      fetcher: async () => jsonResponse({ models: [model('gpt-6-astra')], nextCursor: null })
    })

    const freshWithoutEndpoint = await loadModelPricingCatalogue({
      endpoint: undefined,
      stateDir,
      now: new Date('2026-09-01T12:00:00.000Z'),
      fetcher: async () => {
        throw new Error('network should not be used without an endpoint')
      }
    })
    expect(freshWithoutEndpoint.source).toBe('cache')
    expect(freshWithoutEndpoint.endpointOrigin).toBe('https://tokenboard.example')

    const staleWithoutEndpointDiagnostics: string[] = []
    const staleWithoutEndpoint = await loadModelPricingCatalogue({
      endpoint: undefined,
      stateDir,
      now: new Date('2026-09-03T00:00:00.000Z'),
      stderr: (line) => staleWithoutEndpointDiagnostics.push(line),
      fetcher: async () => {
        throw new Error('network should not be used without an endpoint')
      }
    })
    expect(staleWithoutEndpoint.source).toBe('cache')
    expect(staleWithoutEndpointDiagnostics.join('\n')).toContain('using last successful cache')

    const diagnostics: string[] = []
    const stale = await loadModelPricingCatalogue({
      endpoint: 'https://tokenboard.example',
      stateDir,
      now: new Date('2026-09-03T00:00:00.000Z'),
      fetcher: async () => {
        throw new Error('offline')
      },
      stderr: (line) => diagnostics.push(line)
    })
    expect(stale.source).toBe('cache')
    expect(stale.models[0]?.modelId).toBe('gpt-6-astra')
    expect(diagnostics.join('\n')).toContain('using last successful cache')

    const hookRequests: string[] = []
    const hook = await loadModelPricingCatalogue({
      endpoint: 'https://tokenboard.example',
      stateDir,
      hookMode: true,
      now: new Date('2026-09-04T00:00:00.000Z'),
      fetcher: async (input) => {
        hookRequests.push(String(input))
        throw new Error('hook must not reach the network')
      }
    })
    expect(hook.source).toBe('cache')
    expect(hookRequests).toHaveLength(0)

    const staticFallback = await loadModelPricingCatalogue({
      endpoint: undefined,
      stateDir: await tempDirectory(),
      fetcher: async () => {
        throw new Error('endpoint is unavailable')
      }
    })
    expect(staticFallback.source).toBe('static')
    expect(staticFallback.models.some(({ modelId }) => modelId === 'grok-4.5')).toBe(true)

    const preparedStatic = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir: await tempDirectory(),
      fetcher: async () => {
        throw new Error('offline')
      }
    })
    expect(preparedStatic.configPath).toContain('packages/collector/ccusage.json')
  })

  test('falls back to the usable ccusage config when the dynamic config directory is not writable', async () => {
    const parent = await tempDirectory()
    const stateFile = join(parent, 'state-file')
    await writeFile(stateFile, 'not a directory', 'utf8')
    const explicitPath = join(parent, 'explicit.json')
    await writeFile(
      explicitPath,
      JSON.stringify({ defaults: { pricingOverrides: { 'gpt-6-astra': { inputCostPerToken: 7 } } } }),
      'utf8'
    )
    const diagnostics: string[] = []

    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir: stateFile,
      explicitConfigPath: explicitPath,
      fetcher: async () => jsonResponse({ models: [model('gpt-6-astra')], nextCursor: null }),
      stderr: (line) => diagnostics.push(line)
    })

    expect(result.configPath).toBe(explicitPath)
    expect(result.coveredModelIds.has('gpt-6-astra')).toBe(true)
    expect(result.contextPricingRules.some((rule) => rule.modelIds.includes('gpt-6-astra'))).toBe(false)
    expect(diagnostics.join('\n')).toContain('dynamic ccusage config write failed')
    expect(diagnostics.join('\n')).toContain(`using explicit config ${explicitPath}`)
  })

  test('rejects malformed model rows, prices, and context tiers', () => {
    expect(() => validateModelPricingResponse({ models: [model('\u0000bad')] })).toThrow(
      'Invalid model pricing model id'
    )
    expect(() => validateModelPricingResponse({ models: [model('negative', { inputCostPerMillion: -1 })] })).toThrow(
      'inputCostPerMillion'
    )
    expect(() =>
      validateModelPricingResponse({ models: [model('missing-output', { outputCostPerMillion: undefined })] })
    ).toThrow('outputCostPerMillion')
    expect(() =>
      validateModelPricingResponse({
        models: [
          model('bad-tier', {
            pricing: { tiers: [{ tier: { type: 'context', size: 272_001 }, input: -1, output: 2 }] }
          })
        ]
      })
    ).toThrow('context pricing input')
    expect(() => validateModelPricingResponse({ models: [model('bad-cursor')], nextCursor: '' })).toThrow('nextCursor')
    expect(() =>
      validateModelPricingResponse({ models: [model('bad-multiplier', { pricing: { fast_multiplier: -2 } })] })
    ).toThrow('fast_multiplier')
    expect(validateModelPricingResponse({ models: [model('omitted-cursor')] }).nextCursor).toBeNull()
  })

  test('rejects invalid UTF-8 and ignores a corrupted cache before using static pricing', async () => {
    const stateDir = await tempDirectory()
    await writeFile(join(stateDir, 'model-pricing-cache.json'), '{not-json', 'utf8')
    const diagnostics: string[] = []
    const result = await loadModelPricingCatalogue({
      endpoint: 'https://tokenboard.example',
      stateDir,
      fetcher: async () => new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
      stderr: (line) => diagnostics.push(line)
    })
    expect(result.source).toBe('static')
    expect(diagnostics.join('\n')).toContain('ignoring invalid cache')
    expect(diagnostics.join('\n')).toContain('not valid UTF-8')
  })

  test('keeps a fetched catalogue when its cache cannot be written', async () => {
    const root = await tempDirectory()
    const statePath = join(root, 'state-file')
    await writeFile(statePath, 'state directory path is unavailable', 'utf8')
    const diagnostics: string[] = []

    const result = await loadModelPricingCatalogue({
      endpoint: 'https://tokenboard.example',
      stateDir: statePath,
      now: new Date('2026-09-10T00:00:00.000Z'),
      fetcher: async () => jsonResponse({ models: [model('gpt-6-astra')], nextCursor: null }),
      stderr: (line) => diagnostics.push(line)
    })

    expect(result.source).toBe('network')
    expect(result.models.map(({ modelId }) => modelId)).toEqual(['gpt-6-astra'])
    expect(diagnostics.join('\n')).toContain('cache write failed')
  })

  test('writes cache atomically and creates dynamic ccusage overrides with explicit config precedence', async () => {
    const stateDir = await tempDirectory()
    const explicitPath = join(stateDir, 'explicit.json')
    await writeFile(
      explicitPath,
      JSON.stringify({
        defaults: { pricingOverrides: { 'gpt-6-astra': { inputCostPerToken: 99, outputCostPerToken: 98 } } }
      }),
      'utf8'
    )

    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      explicitConfigPath: explicitPath,
      now: new Date('2026-09-10T00:00:00.000Z'),
      fetcher: async () =>
        jsonResponse({
          models: [
            model('gpt-6-astra', {
              inputCostPerMillion: 1,
              outputCostPerMillion: 2,
              cacheReadCostPerMillion: 0.5,
              cacheWriteCostPerMillion: 1,
              contextWindow: 1_050_000,
              pricing: {
                tiers: [
                  {
                    tier: { type: 'context', size: 272_000 },
                    input: 3,
                    output: 4,
                    cache_read: 0.5,
                    cache_write: 1
                  }
                ],
                priority_multiplier: 3,
                context_over_200k: { input: 99, output: 99 }
              }
            }),
            model('grok-4.6', {
              inputCostPerMillion: 2,
              outputCostPerMillion: 6,
              cacheReadCostPerMillion: 0.6,
              cacheWriteCostPerMillion: 0,
              pricing: {
                tiers: [{ tier: { type: 'context', size: 200_000 }, input: 4, output: 12, cache_read: 0.6 }]
              }
            }),
            model('claude-fable-5-1', { inputCostPerMillion: 5, outputCostPerMillion: 25 })
          ],
          nextCursor: null
        })
    })

    expect(result.configPath).toBe(dynamicCcusageConfigPath(stateDir))
    const config = JSON.parse(await readFile(result.configPath!, 'utf8')) as {
      defaults: { pricingOverrides: Record<string, Record<string, number>> }
    }
    expect(config.defaults.pricingOverrides['gpt-6-astra']).toMatchObject({
      inputCostPerToken: 99,
      outputCostPerToken: 98
    })
    expect(config.defaults.pricingOverrides['grok-4.6']).toMatchObject({
      inputCostPerToken: 2 / 1_000_000,
      outputCostPerToken: 6 / 1_000_000,
      inputCostPerTokenAbove200kTokens: 4 / 1_000_000,
      outputCostPerTokenAbove200kTokens: 12 / 1_000_000
    })
    expect(config.defaults.pricingOverrides['gpt-6-astra']).not.toHaveProperty('inputCostPerTokenAbove200kTokens')
    expect(result.contextPricingRules.some((rule) => rule.modelIds.includes('gpt-6-astra'))).toBe(false)
    expect(result.contextPricingRules.find((rule) => rule.modelIds.includes('grok-4.6'))?.threshold).toBe(200_000)

    const files = await readdir(stateDir)
    expect(files.some((file) => file.startsWith('model-pricing-cache.json.tmp-'))).toBe(false)
    expect(files.some((file) => file.startsWith('ccusage.dynamic.json.tmp-'))).toBe(false)
  })

  test('does not reprice a context model that has an explicit ccusage override', async () => {
    const stateDir = await tempDirectory()
    const explicitPath = join(stateDir, 'explicit.json')
    await writeFile(
      explicitPath,
      JSON.stringify({
        defaults: {
          pricingOverrides: {
            'gpt-6-astra': {
              inputCostPerToken: 77 / 1_000_000,
              outputCostPerToken: 88 / 1_000_000
            }
          }
        }
      }),
      'utf8'
    )

    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      explicitConfigPath: explicitPath,
      fetcher: async () =>
        jsonResponse({
          models: [
            model('gpt-6-astra', {
              cacheReadCostPerMillion: 0.5,
              cacheWriteCostPerMillion: 6,
              pricing: {
                tiers: [
                  { tier: { type: 'context', size: 272_000 }, input: 10, output: 45, cache_read: 1, cache_write: 12 }
                ]
              }
            })
          ],
          nextCursor: null
        })
    })

    expect(result.contextPricingRules.some((rule) => rule.modelIds.includes('gpt-6-astra'))).toBe(false)
  })

  test('does not reprice a dated model alias with an explicit ccusage override', async () => {
    const stateDir = await tempDirectory()
    const explicitPath = join(stateDir, 'explicit.json')
    await writeFile(
      explicitPath,
      JSON.stringify({
        defaults: {
          pricingOverrides: {
            'gpt-5.6-sol-20260901': {
              inputCostPerToken: 77 / 1_000_000,
              outputCostPerToken: 88 / 1_000_000
            }
          }
        }
      }),
      'utf8'
    )

    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      explicitConfigPath: explicitPath,
      fetcher: async () =>
        jsonResponse({
          models: [
            model('gpt-5.6-sol-20260901', {
              cacheReadCostPerMillion: 0.5,
              cacheWriteCostPerMillion: 6,
              pricing: {
                tiers: [
                  { tier: { type: 'context', size: 272_000 }, input: 10, output: 45, cache_read: 1, cache_write: 12 }
                ]
              }
            })
          ],
          nextCursor: null
        })
    })

    expect(result.contextPricingRules.some((rule) => rule.modelIds.includes('gpt-5.6-sol'))).toBe(false)
  })

  test('treats a blank state directory as unset', async () => {
    const stateDir = await tempDirectory()
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)

    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir: '   ',
      fetcher: async () => jsonResponse({ models: [model('gpt-6-astra')], nextCursor: null })
    })

    expect(result.configPath).toBe(dynamicCcusageConfigPath(stateDir))
  })

  test('trims blank state and config directory environment values', async () => {
    const stateDir = await tempDirectory()
    vi.stubEnv('TOKENBOARD_STATE_DIR', '   ')
    vi.stubEnv('TOKENBOARD_CONFIG_DIR', stateDir)

    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      fetcher: async () => jsonResponse({ models: [model('gpt-6-astra')], nextCursor: null })
    })

    expect(result.configPath).toBe(dynamicCcusageConfigPath(stateDir))
  })

  test('anchors a base model to its official price when only a variant key would price it', async () => {
    // ccusage resolves an override key against the observed model name by folding provider
    // prefixes and variant suffixes: with only `xiaomi/mimo-v2.6-flash-uncensored` present,
    // a `mimo-v2.6-flash` day was billed at the uncensored fine-tune's rate — 3.6x the
    // official price. An exact key always wins over a folding one, so emitting the official
    // row as the base model's own key restores the right rate.
    const overrides = createCcusagePricingOverrides([
      model('mimo-v2.6-flash', { provider: 'xiaomi', inputCostPerMillion: 0.14, outputCostPerMillion: 0.28 }),
      model('mimo-v2.6-flash', { provider: 'reseller-a', inputCostPerMillion: 0.12, outputCostPerMillion: 0.25 }),
      model('xiaomi/mimo-v2.6-flash-uncensored', {
        provider: 'xiaomi',
        inputCostPerMillion: 0.5,
        outputCostPerMillion: 1.5
      })
    ])

    // The bare id stays unresolved on its own (the two rows disagree)...
    expect(
      selectUnambiguousDynamicPricingModels([
        model('mimo-v2.6-flash', { provider: 'xiaomi', inputCostPerMillion: 0.14, outputCostPerMillion: 0.28 }),
        model('mimo-v2.6-flash', { provider: 'reseller-a', inputCostPerMillion: 0.12, outputCostPerMillion: 0.25 })
      ])
    ).toHaveLength(0)
    // ...but the official row anchors it so the variant key cannot price it.
    expect(overrides['mimo-v2.6-flash']).toMatchObject({ inputCostPerToken: 0.14 / 1_000_000 })
    expect(overrides['xiaomi/mimo-v2.6-flash-uncensored']).toBeDefined()
  })

  test('leaves a variant-only model alone when no official base row exists', async () => {
    // Without an official row there is nothing to anchor to, and inventing a price from a
    // reseller row would repeat the very ambiguity the unresolved id was protected from.
    const overrides = createCcusagePricingOverrides([
      model('deepseek-v4.1-flash', { provider: 'reseller-a', inputCostPerMillion: 0.03, outputCostPerMillion: 0.12 }),
      model('deepseek-v4.1-flash', { provider: 'reseller-b', inputCostPerMillion: 0.672, outputCostPerMillion: 2.016 }),
      model('deepseek/deepseek-v4.1-flash-uncensored', {
        provider: 'deepseek',
        inputCostPerMillion: 0.33,
        outputCostPerMillion: 1.32
      })
    ])

    expect(overrides['deepseek-v4.1-flash']).toBeUndefined()
  })

  test('does not merge prices from different providers for the same model id', async () => {
    const stateDir = await tempDirectory()
    const sharedModel = (provider: string, inputCostPerMillion: number): CollectorPricingModel =>
      model('provider-collision', {
        provider,
        inputCostPerMillion,
        pricing: {
          tiers: [{ tier: { type: 'context', size: 200_000 }, input: inputCostPerMillion, output: 2 }]
        }
      })
    const overrides = createCcusagePricingOverrides([
      sharedModel('openai', 1),
      sharedModel('azure', 99),
      model('provider-unique', { provider: 'openai', inputCostPerMillion: 7 })
    ])

    expect(overrides).not.toHaveProperty('provider-collision')
    expect(overrides['provider-unique']).toMatchObject({ inputCostPerToken: 7 / 1_000_000 })

    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      fetcher: async () =>
        jsonResponse({
          models: [sharedModel('openai', 1), sharedModel('azure', 99), model('provider-unique')],
          nextCursor: null
        })
    })
    expect(result.coveredModelIds.has('provider-collision')).toBe(false)
    expect(result.contextPricingRules.some((rule) => rule.modelIds.includes('provider-collision'))).toBe(false)
  })

  test('treats the bundled config as a baseline so dynamic prices override it', async () => {
    const stateDir = await tempDirectory()
    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      explicitConfigPath: join(dirname(fileURLToPath(import.meta.url)), '../ccusage.json'),
      fetcher: async () =>
        jsonResponse({
          models: [
            model('gpt-5.6-luna', {
              inputCostPerMillion: 11,
              outputCostPerMillion: 33,
              cacheReadCostPerMillion: 2,
              cacheWriteCostPerMillion: 7
            })
          ],
          nextCursor: null
        })
    })

    const config = JSON.parse(await readFile(result.configPath!, 'utf8')) as {
      defaults: { pricingOverrides: Record<string, Record<string, number>> }
    }
    expect(config.defaults.pricingOverrides['gpt-5.6-luna']).toMatchObject({
      inputCostPerToken: 11 / 1_000_000,
      outputCostPerToken: 33 / 1_000_000,
      cacheReadInputTokenCost: 2 / 1_000_000,
      cacheCreationInputTokenCost: 7 / 1_000_000
    })
  })

  test('retains bundled cache prices when the dynamic row omits them', async () => {
    const stateDir = await tempDirectory()
    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      fetcher: async () =>
        jsonResponse({
          models: [
            model('gpt-5.6-luna', {
              inputCostPerMillion: 11,
              outputCostPerMillion: 33,
              cacheReadCostPerMillion: null,
              cacheWriteCostPerMillion: null
            })
          ],
          nextCursor: null
        })
    })

    const config = JSON.parse(await readFile(result.configPath!, 'utf8')) as {
      defaults: { pricingOverrides: Record<string, Record<string, number>> }
    }
    expect(config.defaults.pricingOverrides['gpt-5.6-luna']).toMatchObject({
      inputCostPerToken: 11 / 1_000_000,
      outputCostPerToken: 33 / 1_000_000,
      cacheReadInputTokenCost: 0.02 / 1_000_000,
      cacheCreationInputTokenCost: 0.25 / 1_000_000
    })
  })

  test('removes bundled 200k fields when the dynamic tier is 272k', async () => {
    const stateDir = await tempDirectory()
    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      fetcher: async () =>
        jsonResponse({
          models: [
            model('grok-4.5', {
              inputCostPerMillion: 7,
              outputCostPerMillion: 21,
              cacheReadCostPerMillion: null,
              cacheWriteCostPerMillion: null,
              pricing: {
                tiers: [{ tier: { type: 'context', size: 272_000 }, input: 14, output: 42 }]
              }
            })
          ],
          nextCursor: null
        })
    })

    const config = JSON.parse(await readFile(result.configPath!, 'utf8')) as {
      defaults: { pricingOverrides: Record<string, Record<string, number>> }
    }
    expect(Object.keys(config.defaults.pricingOverrides['grok-4.5'] ?? {})).not.toEqual(
      expect.arrayContaining(['inputCostPerTokenAbove200kTokens', 'outputCostPerTokenAbove200kTokens'])
    )
  })

  test('does not map a changing later context tier to ccusage 200k pricing', async () => {
    const stateDir = await tempDirectory()
    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      fetcher: async () =>
        jsonResponse({
          models: [
            model('grok-4.5', {
              inputCostPerMillion: 2,
              outputCostPerMillion: 6,
              cacheReadCostPerMillion: 0.3,
              cacheWriteCostPerMillion: null,
              pricing: {
                tiers: [
                  {
                    tier: { type: 'context', size: 200_000 },
                    input: 4,
                    output: 12,
                    cache_read: 0.6
                  },
                  {
                    tier: { type: 'context', size: 1_000_000 },
                    input: 8,
                    output: 24,
                    cache_read: 1.2
                  }
                ]
              }
            })
          ],
          nextCursor: null
        })
    })

    const config = JSON.parse(await readFile(result.configPath!, 'utf8')) as {
      defaults: { pricingOverrides: Record<string, Record<string, number>> }
    }
    expect(config.defaults.pricingOverrides['grok-4.5']).toMatchObject({
      inputCostPerToken: 2 / 1_000_000,
      outputCostPerToken: 6 / 1_000_000
    })
    expect(config.defaults.pricingOverrides['grok-4.5']).not.toEqual(
      expect.objectContaining({
        inputCostPerTokenAbove200kTokens: expect.any(Number),
        outputCostPerTokenAbove200kTokens: expect.any(Number)
      })
    )
  })

  test('preserves bundled long-context fields when static fallback writes a merged config', async () => {
    const stateDir = await tempDirectory()
    const explicitPath = join(stateDir, 'explicit.json')
    await writeFile(explicitPath, JSON.stringify({ defaults: { pricingOverrides: {} } }), 'utf8')

    const result = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      explicitConfigPath: explicitPath,
      fetcher: async () => {
        throw new Error('offline')
      }
    })

    const config = JSON.parse(await readFile(result.configPath!, 'utf8')) as {
      defaults: { pricingOverrides: Record<string, Record<string, number>> }
    }
    expect(config.defaults.pricingOverrides['grok-4.5']).toMatchObject({
      inputCostPerTokenAbove200kTokens: 4 / 1_000_000,
      outputCostPerTokenAbove200kTokens: 12 / 1_000_000,
      cacheReadInputTokenCostAbove200kTokens: 0.6 / 1_000_000
    })
  })
})

function model(modelId: string, overrides: Partial<CollectorPricingModel> = {}): CollectorPricingModel {
  return {
    provider: 'openai',
    modelId,
    inputCostPerMillion: 5,
    outputCostPerMillion: 30,
    cacheReadCostPerMillion: null,
    cacheWriteCostPerMillion: null,
    contextWindow: 1_050_000,
    maxInputTokens: 1_050_000,
    pricing: {},
    ...overrides
  }
}

function jsonResponse(body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'tokenboard-model-pricing-'))
  tempDirectories.push(directory)
  return directory
}

// A `--source all` run collects claude-code and codex in one process, and each
// provider loads the catalogue itself. When the endpoint has no pricing route
// the fetch fails and nothing is cached, so the second provider repeats the
// same doomed request: an all-source run against a route-less server made two
// 404 round trips of ~0.8s each. One process needs one attempt.
describe('per-process pricing catalogue memo', () => {
  afterEach(() => resetModelPricingMemo())

  test('a failed refresh is not retried by the next provider in the same run', async () => {
    const stateDir = await tempDirectory()
    let fetched = 0
    const fetcher: PricingFetcher = async () => {
      fetched += 1
      throw new Error('Model pricing source returned HTTP 404')
    }
    const now = new Date('2026-09-10T00:00:00.000Z')

    const first = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      now,
      fetcher,
      stderr: () => {}
    })
    const second = await prepareDynamicCcusageConfig({
      endpoint: 'https://tokenboard.example',
      stateDir,
      now,
      fetcher,
      stderr: () => {}
    })

    expect(fetched).toBe(1)
    expect(second.configPath).toBe(first.configPath)
  })

  // The memo is per endpoint: a run that touches two servers must ask each.
  test('does not share a catalogue across different endpoints', async () => {
    const stateDir = await tempDirectory()
    let fetched = 0
    const fetcher: PricingFetcher = async () => {
      fetched += 1
      throw new Error('Model pricing source returned HTTP 404')
    }
    const now = new Date('2026-09-10T00:00:00.000Z')

    await prepareDynamicCcusageConfig({ endpoint: 'https://a.example', stateDir, now, fetcher, stderr: () => {} })
    await prepareDynamicCcusageConfig({ endpoint: 'https://b.example', stateDir, now, fetcher, stderr: () => {} })

    expect(fetched).toBe(2)
  })

  // A successful refresh already lands in the shared on-disk cache, so the
  // memo must not change what a provider sees there.
  test('a successful refresh still writes the cache both providers read', async () => {
    const stateDir = await tempDirectory()
    let fetched = 0
    const fetcher: PricingFetcher = async () => {
      fetched += 1
      return jsonResponse({ models: [model('gpt-6-astra')], nextCursor: null })
    }
    const now = new Date('2026-09-10T00:00:00.000Z')

    const first = await prepareDynamicCcusageConfig({ endpoint: 'https://tokenboard.example', stateDir, now, fetcher })
    const second = await prepareDynamicCcusageConfig({ endpoint: 'https://tokenboard.example', stateDir, now, fetcher })

    expect(fetched).toBe(1)
    expect(second.configPath).toBe(first.configPath)
    expect(second.coveredModelIds.has('gpt-6-astra')).toBe(true)
  })
})
