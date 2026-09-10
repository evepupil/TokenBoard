import { describe, expect, test, vi } from 'vitest'
import {
  defaultModelPricingSyncIntervalHours,
  getModelPricing,
  modelPricingSyncEnabled,
  modelPricingSyncIntervalHours,
  normalizeModelPricingLimit,
  parsePricingSyncToken,
  parseModelPricingLimit,
  runModelPricingSync,
  verifyPricingSyncToken
} from './service'

describe('model pricing service', () => {
  test('uses a single successful source snapshot and records the sync state', async () => {
    const db = createDb({ claimChanges: 1 })
    const fetcher = vi.fn(async () => new Response(JSON.stringify(sourceFixture()), { status: 200 }))

    const result = await runModelPricingSync({
      env: {
        DB: db,
        TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24',
        TOKENBOARD_MODEL_PRICING_SOURCE_URL: undefined
      },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher
    })

    expect(result).toMatchObject({ status: 'success', modelCount: 3 })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(db.batch).toHaveBeenCalledTimes(2)
    expect(db.sql.join('\n')).toContain('UPDATE model_pricing_sync_state')
    expect(db.sql.join('\n')).toContain("status = 'success'")
  })

  test('does not fetch when another worker owns the sync lock', async () => {
    const db = createDb({ claimChanges: 0, lockedUntil: '2026-08-07T00:05:00.000Z' })
    const fetcher = vi.fn()

    await expect(
      runModelPricingSync({
        env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: undefined },
        now: new Date('2026-08-07T00:00:00.000Z'),
        fetcher
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'locked' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(db.batch).not.toHaveBeenCalled()
  })

  test('reports not-due when a failed claim has no active lock', async () => {
    const db = createDb({ claimChanges: 0 })

    await expect(
      runModelPricingSync({
        env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: undefined },
        now: new Date('2026-08-07T00:00:00.000Z'),
        fetcher: vi.fn()
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'not-due' })
  })

  test('preserves the old rows when the source fails and records the failure', async () => {
    const db = createDb({ claimChanges: 1 })

    await expect(
      runModelPricingSync({
        env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: undefined },
        now: new Date('2026-08-07T00:00:00.000Z'),
        fetcher: async () => new Response('bad upstream', { status: 503 })
      })
    ).rejects.toThrow('Model pricing sync failed: Model pricing source returned HTTP 503')
    expect(db.batch).not.toHaveBeenCalled()
    expect(db.sql.join('\n')).toContain("status = 'failed'")
  })

  test('validates deployment settings instead of silently accepting invalid values', () => {
    expect(modelPricingSyncEnabled({ TOKENBOARD_MODEL_PRICING_SYNC_ENABLED: undefined })).toBe(false)
    expect(modelPricingSyncEnabled({ TOKENBOARD_MODEL_PRICING_SYNC_ENABLED: 'true' })).toBe(true)
    expect(modelPricingSyncIntervalHours({ TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: undefined })).toBe(
      defaultModelPricingSyncIntervalHours
    )
    expect(() => modelPricingSyncIntervalHours({ TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '0' })).toThrow()
    expect(() => modelPricingSyncIntervalHours({ TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '169' })).toThrow()
  })

  test('validates model pricing page sizes', () => {
    expect(parseModelPricingLimit(undefined)).toBeUndefined()
    expect(parseModelPricingLimit('25')).toBe(25)
    expect(() => parseModelPricingLimit('0')).toThrow('from 1 to')
    expect(() => parseModelPricingLimit('10001')).toThrow('from 1 to')
    expect(() => parseModelPricingLimit('1.5')).toThrow('from 1 to')
    expect(normalizeModelPricingLimit(25)).toBe(25)
    expect(() => normalizeModelPricingLimit(0)).toThrow('from 1 to')
    expect(() => normalizeModelPricingLimit(1.5)).toThrow('from 1 to')
    expect(() => normalizeModelPricingLimit(Number.NaN)).toThrow('from 1 to')
  })

  test('checks the manual sync token without exposing the secret', async () => {
    const env = { TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret-token' }
    await expect(verifyPricingSyncToken(env, 'Bearer secret-token')).resolves.toBe(true)
    await expect(verifyPricingSyncToken(env, 'Bearer wrong-token')).resolves.toBe(false)
    await expect(
      verifyPricingSyncToken({ TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: undefined }, 'Bearer secret-token')
    ).resolves.toBe(false)
  })

  test('parses bearer token whitespace into a canonical rate-limit value', () => {
    expect(parsePricingSyncToken('Bearer secret-token')).toBe('secret-token')
    expect(parsePricingSyncToken('Bearer   secret-token')).toBe('secret-token')
    expect(parsePricingSyncToken('Bearer secret-token   ')).toBeNull()
  })

  test('retries a catalogue read when the active generation changes mid-request', async () => {
    const states = [
      storedState('generation-one', '2026-08-07T00:00:00.000Z'),
      storedState('generation-two', '2026-08-07T00:01:00.000Z'),
      storedState('generation-two', '2026-08-07T00:01:00.000Z'),
      storedState('generation-two', '2026-08-07T00:01:00.000Z')
    ]
    const queries: string[] = []
    let catalogueReads = 0
    const db = {
      prepare(query: string) {
        queries.push(query)
        return {
          bind(..._values: unknown[]) {
            return {
              async first() {
                return query.includes('FROM model_pricing_sync_state') ? (states.shift() ?? null) : null
              },
              async all() {
                catalogueReads += 1
                const generation = catalogueReads === 1 ? 'generation-one' : 'generation-two'
                return {
                  results: [
                    {
                      provider: 'openai',
                      modelId: generation,
                      displayName: generation,
                      inputCostPerMillion: 1,
                      outputCostPerMillion: 2,
                      cacheReadCostPerMillion: null,
                      cacheWriteCostPerMillion: null,
                      contextWindow: 128_000,
                      maxInputTokens: null,
                      maxOutputTokens: null,
                      releaseDate: null,
                      sourceUpdatedAt: '2026-08-07',
                      officialDocsUrl: 'https://example.com/docs',
                      sourceUrl: 'https://models.dev/api.json',
                      pricingJson: '{}',
                      isDeprecated: 0,
                      isActive: 1,
                      fetchedAt: '2026-08-07T00:00:00.000Z'
                    }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await getModelPricing({ db })

    expect(result.state?.activeGeneration).toBe('generation-two')
    expect(result.models.map((model) => model.modelId)).toEqual(['generation-two'])
    expect(catalogueReads).toBe(2)
    expect(queries.filter((query) => query.includes('sync_generation = ?'))).toHaveLength(2)
  })

  test('does not retry a catalogue read when only the sync lease timestamp changes', async () => {
    const states = [
      storedState('generation-one', '2026-08-07T00:00:00.000Z'),
      storedState('generation-one', '2026-08-07T00:00:01.000Z')
    ]
    const db = {
      prepare(query: string) {
        return {
          bind(..._values: unknown[]) {
            return {
              async first() {
                return query.includes('FROM model_pricing_sync_state') ? (states.shift() ?? null) : null
              },
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(getModelPricing({ db })).resolves.toMatchObject({
      state: { activeGeneration: 'generation-one' }
    })
  })

  test('does not retry when a sync starts without changing the active catalogue', async () => {
    const states = [
      storedState('generation-one', '2026-08-07T00:00:00.000Z'),
      storedState('generation-one', '2026-08-07T00:01:00.000Z', 'running')
    ]
    let stateReads = 0
    const db = {
      prepare(query: string) {
        return {
          bind(..._values: unknown[]) {
            return {
              async first() {
                if (!query.includes('FROM model_pricing_sync_state')) return null
                stateReads += 1
                return states.shift() ?? null
              },
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(getModelPricing({ db })).resolves.toMatchObject({
      state: { activeGeneration: 'generation-one' }
    })
    expect(stateReads).toBe(2)
  })

  test('returns a retryable service error when the catalogue never stabilizes', async () => {
    const states = [
      storedState('generation-one', '2026-08-07T00:00:00.000Z'),
      storedState('generation-two', '2026-08-07T00:00:01.000Z'),
      storedState('generation-two', '2026-08-07T00:00:02.000Z'),
      storedState('generation-three', '2026-08-07T00:00:03.000Z'),
      storedState('generation-three', '2026-08-07T00:00:04.000Z'),
      storedState('generation-four', '2026-08-07T00:00:05.000Z')
    ]
    const db = {
      prepare(query: string) {
        return {
          bind(..._values: unknown[]) {
            return {
              async first() {
                return query.includes('FROM model_pricing_sync_state') ? (states.shift() ?? null) : null
              },
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(getModelPricing({ db })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503
    })
  })
})

function storedState(
  activeGeneration: string,
  updatedAt: string,
  status: 'running' | 'success' | 'failed' = 'success'
) {
  return {
    status,
    sourceUrl: 'https://models.dev/api.json',
    lastStartedAt: updatedAt,
    lastSuccessAt: updatedAt,
    lastFailureAt: null,
    lastSourceUpdatedAt: updatedAt,
    modelCount: 1,
    activeGeneration,
    lastError: null,
    updatedAt
  }
}

function createDb(options: { claimChanges: number; lockedUntil?: string }) {
  const sql: string[] = []
  const batch = vi.fn(async (statements: unknown[]) => statements.map(() => ({ success: true, meta: { changes: 1 } })))
  const db = {
    sql,
    prepare(query: string) {
      return {
        bind(..._values: unknown[]) {
          sql.push(query)
          return {
            async run() {
              return {
                success: true,
                meta: { changes: query.includes('INSERT INTO model_pricing_sync_state') ? options.claimChanges : 1 }
              }
            },
            async first() {
              if (query.includes('locked_until')) return { lockedUntil: options.lockedUntil ?? null }
              return null
            },
            async all() {
              return { results: [] }
            }
          }
        }
      }
    },
    batch
  }
  return db as unknown as D1Database & { sql: string[]; batch: ReturnType<typeof vi.fn> }
}

function sourceFixture() {
  return {
    openai: {
      doc: 'https://developers.openai.com/api/docs/pricing',
      models: { 'gpt-5.6-sol': pricedModel('gpt-5.6-sol', 'gpt-sol', 1_050_000, 5, 30) }
    },
    anthropic: {
      doc: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
      models: { 'claude-sonnet-5': pricedModel('claude-sonnet-5', 'claude-sonnet', 1_000_000, 2, 10) }
    },
    xai: {
      doc: 'https://docs.x.ai/docs/models',
      models: { 'grok-4.5': pricedModel('grok-4.5', 'grok', 500_000, 2, 6) }
    }
  }
}

function pricedModel(id: string, family: string, context: number, input: number, output: number) {
  return {
    id,
    name: id,
    family,
    last_updated: '2026-08-01',
    limit: { context, output: 128_000 },
    cost: { input, output, cache_read: 0.1 }
  }
}
