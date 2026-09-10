import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { getModelPricing, runModelPricingSync } from './service'
import {
  claimModelPricingSync,
  listModelPricing,
  markModelPricingSyncFailure,
  markModelPricingSyncSuccess,
  modelPricingFailureRetryDelayMs,
  replaceModelPricing
} from './repository'
import { normalizeModelsDevPayload } from './source'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('model pricing SQLite contract', () => {
  test('backs off repeated source failures without blocking an explicit retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const startedAt = new Date('2026-08-07T00:00:00.000Z')
    let fetchCount = 0

    await expect(
      runModelPricingSync({
        env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
        now: startedAt,
        fetcher: async () => {
          fetchCount += 1
          return new Response('bad upstream', { status: 503 })
        }
      })
    ).rejects.toThrow('HTTP 503')

    await expect(
      runModelPricingSync({
        env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
        now: new Date(startedAt.getTime() + 15 * 60 * 1000),
        fetcher: async () => {
          fetchCount += 1
          return new Response(JSON.stringify(sourceFixture()))
        }
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'not-due' })
    expect(fetchCount).toBe(1)

    const recovered = await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date(startedAt.getTime() + modelPricingFailureRetryDelayMs + 60 * 1000),
      fetcher: async () => {
        fetchCount += 1
        return new Response(JSON.stringify(sourceFixture()))
      }
    })
    expect(recovered).toMatchObject({ status: 'success', modelCount: 4 })
    expect(fetchCount).toBe(2)
  })

  test('atomically persists source rows and supports the next due check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)

    const first = await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })
    const second = await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T01:00:00.000Z'),
      fetcher: async () => {
        throw new Error('should not fetch while interval is current')
      }
    })
    const catalogue = await getModelPricing({ db })

    expect(first).toMatchObject({ status: 'success', modelCount: 4 })
    expect(second).toEqual({ status: 'skipped', reason: 'not-due' })
    expect(catalogue.state).toMatchObject({ status: 'success', modelCount: 4 })
    expect(catalogue.models.map((model) => model.modelId)).toEqual([
      'claude-sonnet-5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'grok-4.5'
    ])
  })

  test('keeps source-removed models as inactive history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)

    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })
    const next = sourceFixture()
    delete (next.openai.models as Record<string, unknown>)['gpt-5.6-terra']
    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-08T00:00:00.000Z'),
      force: true,
      fetcher: async () => new Response(JSON.stringify(next))
    })

    const active = await getModelPricing({ db })
    const all = await getModelPricing({ db, includeInactive: true })
    expect(active.models.some((model) => model.modelId === 'gpt-5.6-terra')).toBe(false)
    expect(all.models).toContainEqual(
      expect.objectContaining({
        modelId: 'gpt-5.6-terra',
        isActive: false
      })
    )
  })

  test('fails visibly when a stored pricing object is corrupted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)

    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })
    runSql(dbPath, "UPDATE model_pricing SET pricing_json = 'not-json'")

    await expect(getModelPricing({ db })).rejects.toThrow('pricing_json')
  })

  test('fails visibly when a stored required numeric field is corrupted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)

    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })
    runSql(dbPath, "UPDATE model_pricing SET input_cost_per_million = 'not-a-number'")

    await expect(getModelPricing({ db })).rejects.toThrow('inputCostPerMillion')
  })

  test('fails visibly when stored optional prices or token limits are invalid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)

    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })

    runSql(dbPath, 'UPDATE model_pricing SET cache_read_cost_per_million = -1')
    await expect(getModelPricing({ db })).rejects.toThrow('cacheReadCostPerMillion')
    runSql(dbPath, 'UPDATE model_pricing SET cache_read_cost_per_million = NULL, max_input_tokens = 1.5')
    await expect(getModelPricing({ db })).rejects.toThrow('maxInputTokens')
    runSql(dbPath, 'UPDATE model_pricing SET max_input_tokens = 9007199254740992')
    await expect(getModelPricing({ db })).rejects.toThrow('maxInputTokens')
  })

  test('writes large snapshots in multiple D1 batches before activation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const fixture = sourceFixture()
    const models = fixture.openai.models as Record<string, unknown>
    for (let index = 0; index < 205; index += 1) {
      models[`gpt-large/${index}`] = pricedModel(`gpt-large/${index}`, 'gpt-large', 128_000, 1, 2)
    }

    const result = await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(fixture))
    })

    expect(result).toMatchObject({ status: 'success', modelCount: 209 })
    const defaultPage = await getModelPricing({ db })
    expect(defaultPage.models).toHaveLength(100)
    expect(defaultPage.nextCursor).toBeTruthy()
    expect((await getModelPricing({ db, limit: 1_000 })).models).toHaveLength(209)
  })

  test('rejects an empty replacement before touching the existing catalogue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const now = new Date('2026-08-07T00:00:00.000Z')
    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now,
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })
    const before = await getModelPricing({ db })
    const lockToken = 'empty-replacement-lock'
    expect(
      await claimModelPricingSync({
        db,
        sourceUrl: 'https://models.dev/api.json',
        now: new Date('2026-08-08T00:00:00.000Z'),
        intervalHours: 24,
        force: true,
        lockToken
      })
    ).toBe(true)

    await expect(
      replaceModelPricing({
        db,
        models: [],
        sourceUrl: 'https://models.dev/api.json',
        fetchedAt: now.toISOString(),
        syncGeneration: 'empty-generation',
        lockToken,
        now
      })
    ).rejects.toThrow('empty catalogue')
    expect((await getModelPricing({ db })).models).toEqual(before.models)
  })

  test('renews the pricing lease before a staging batch writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const now = new Date('2026-08-07T00:00:00.000Z')
    const lockToken = 'lease-renewal-lock'
    expect(
      await claimModelPricingSync({
        db,
        sourceUrl: 'https://models.dev/api.json',
        now,
        intervalHours: 24,
        force: true,
        lockToken
      })
    ).toBe(true)
    runSql(
      dbPath,
      `
      UPDATE model_pricing_sync_state
      SET locked_until = '2026-08-07T00:05:00.000Z'
      WHERE id = 'global';
    `
    )
    const snapshot = normalizeModelsDevPayload(sourceFixture(), { fetchedAt: now.toISOString() })
    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(4 * 60 * 1000)
    try {
      await replaceModelPricing({
        db,
        models: snapshot.models,
        sourceUrl: snapshot.sourceUrl,
        fetchedAt: snapshot.fetchedAt,
        syncGeneration: 'lease-renewal-generation',
        lockToken,
        now
      })
    } finally {
      dateNow.mockRestore()
    }

    const renewedUntil = runSql(dbPath, "SELECT locked_until FROM model_pricing_sync_state WHERE id = 'global'").trim()
    expect(Date.parse(renewedUntil)).toBeGreaterThan(Date.parse('2026-08-07T00:13:00.000Z'))
    expect(
      Number.parseInt(
        runSql(
          dbPath,
          "SELECT COUNT(*) FROM model_pricing_staging WHERE generation_id = 'lease-renewal-generation'"
        ).trim(),
        10
      )
    ).toBe(snapshot.models.length)
  })

  test('records sync success at completion so a slow run is not immediately due', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const now = new Date('2026-08-07T00:00:00.000Z')
    let clock = 0
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 1_000
      return clock
    })
    try {
      const first = await runModelPricingSync({
        env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
        now,
        fetcher: async () => new Response(JSON.stringify(sourceFixture()))
      })
      expect(first.status).toBe('success')

      const state = await getModelPricing({ db })
      expect(state.state?.lastSuccessAt).toBeTruthy()
      expect(Date.parse(state.state?.lastSuccessAt ?? '')).toBeGreaterThan(Date.parse(now.toISOString()))

      const second = await runModelPricingSync({
        env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
        now: new Date('2026-08-07T00:00:10.000Z'),
        fetcher: async () => {
          throw new Error('should not fetch while completion interval is current')
        }
      })
      expect(second).toEqual({ status: 'skipped', reason: 'not-due' })
    } finally {
      dateNow.mockRestore()
    }
  })

  test('keeps the previous active generation when a staging batch fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const first = await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })
    expect(first.status).toBe('success')

    runSql(
      dbPath,
      `
      CREATE TRIGGER fail_model_pricing_staging_batch
      BEFORE INSERT ON model_pricing_staging
      WHEN NEW.model_id = 'gpt-5.6-sol'
      BEGIN
        SELECT RAISE(ABORT, 'injected staging batch failure');
      END;
    `
    )
    const next = sourceFixture()

    await expect(
      runModelPricingSync({
        env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
        now: new Date('2026-08-08T00:00:00.000Z'),
        force: true,
        fetcher: async () => new Response(JSON.stringify(next))
      })
    ).rejects.toThrow('injected staging batch failure')

    const catalogue = await getModelPricing({ db })
    expect(catalogue.state).toMatchObject({ status: 'failed', modelCount: 4 })
    expect(catalogue.models.map((model) => model.modelId)).toEqual([
      'claude-sonnet-5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'grok-4.5'
    ])
  })

  test('fails activation when the pricing lock is lost before commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })

    runSql(
      dbPath,
      `
      CREATE TRIGGER replace_lock_during_staging
      AFTER INSERT ON model_pricing_staging
      WHEN NEW.model_id = 'gpt-5.6-sol'
      BEGIN
        UPDATE model_pricing_sync_state SET lock_token = 'other-owner' WHERE id = 'global';
      END;
    `
    )
    await expect(
      runModelPricingSync({
        env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
        now: new Date('2026-08-08T00:00:00.000Z'),
        force: true,
        fetcher: async () => new Response(JSON.stringify(sourceFixture()))
      })
    ).rejects.toThrow('lock ownership was lost while writing staging rows')

    const catalogue = await getModelPricing({ db })
    expect(catalogue.models).toHaveLength(4)
    expect(catalogue.state?.status).toBe('running')
    expect(Date.parse(catalogue.state?.lastSuccessAt ?? '')).toBeGreaterThan(Date.parse('2026-08-07T00:00:00.000Z'))
    expect(runSql(dbPath, "SELECT lock_token FROM model_pricing_sync_state WHERE id = 'global'")).toContain(
      'other-owner'
    )
  })

  test('does not let a slow fetch write after the pricing lease expires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })

    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    try {
      await expect(
        runModelPricingSync({
          env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
          now: new Date('2026-08-08T00:00:00.000Z'),
          force: true,
          fetcher: async () => {
            clock.mockReturnValue(11 * 60 * 1000)
            return new Response(JSON.stringify(sourceFixture()))
          }
        })
      ).rejects.toThrow('lock ownership was lost before writing staging rows')
    } finally {
      clock.mockRestore()
    }

    const catalogue = await getModelPricing({ db })
    expect(catalogue.models).toHaveLength(4)
    expect(catalogue.state).toMatchObject({ status: 'running' })
    expect(runSql(dbPath, 'SELECT COUNT(*) FROM model_pricing_staging').trim()).toBe('0')
  })

  test('does not let an expired owner overwrite the sync failure state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const startedAt = new Date('2026-08-07T00:00:00.000Z')
    const lockToken = 'expired-failure-owner'

    expect(
      await claimModelPricingSync({
        db,
        sourceUrl: 'https://models.dev/api.json',
        now: startedAt,
        intervalHours: 24,
        force: true,
        lockToken
      })
    ).toBe(true)

    await expect(
      markModelPricingSyncFailure({
        db,
        lockToken,
        sourceUrl: 'https://models.dev/api.json',
        now: new Date('2026-08-07T00:11:00.000Z'),
        error: 'stale owner failure'
      })
    ).rejects.toThrow('lock ownership was lost while recording failure')

    expect(runSql(dbPath, "SELECT status, lock_token FROM model_pricing_sync_state WHERE id = 'global'").trim()).toBe(
      'running|expired-failure-owner'
    )
  })

  test('does not activate a generation when its staging count does not match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })
    const previousCatalogue = await getModelPricing({ db })
    const previousActiveGeneration = previousCatalogue.state?.activeGeneration
    expect(previousActiveGeneration).toBeTruthy()

    const now = new Date('2026-08-08T00:00:00.000Z')
    const lockToken = 'count-mismatch-lock'
    expect(
      await claimModelPricingSync({
        db,
        sourceUrl: 'https://models.dev/api.json',
        now,
        intervalHours: 24,
        force: true,
        lockToken
      })
    ).toBe(true)
    const snapshot = normalizeModelsDevPayload(sourceFixture(), {
      fetchedAt: now.toISOString()
    })
    const generation = 'count-mismatch-generation'
    await replaceModelPricing({
      db,
      models: snapshot.models,
      sourceUrl: snapshot.sourceUrl,
      fetchedAt: snapshot.fetchedAt,
      syncGeneration: generation,
      lockToken,
      now
    })

    await expect(
      markModelPricingSyncSuccess({
        db,
        lockToken,
        sourceUrl: snapshot.sourceUrl,
        now,
        sourceUpdatedAt: snapshot.latestSourceUpdatedAt,
        modelCount: snapshot.models.length + 1,
        syncGeneration: generation
      })
    ).rejects.toThrow('generation staging count 4 does not match expected model count 5')

    const catalogue = await getModelPricing({ db })
    expect(catalogue.models).toHaveLength(snapshot.models.length)
    expect(catalogue.models.map((model) => model.modelId)).toEqual(
      previousCatalogue.models.map((model) => model.modelId)
    )
    expect(catalogue.state).toMatchObject({
      status: 'running',
      activeGeneration: previousActiveGeneration
    })
    const stagingCount = Number.parseInt(
      runSql(dbPath, `SELECT COUNT(*) FROM model_pricing_staging WHERE generation_id = '${generation}'`).trim(),
      10
    )
    expect(stagingCount).toBe(snapshot.models.length)
  })

  test('does not let an expired sync delete a newer owner staging generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })

    const firstNow = new Date('2026-08-08T00:00:00.000Z')
    const firstLock = 'expired-owner-lock'
    expect(
      await claimModelPricingSync({
        db,
        sourceUrl: 'https://models.dev/api.json',
        now: firstNow,
        intervalHours: 24,
        force: true,
        lockToken: firstLock
      })
    ).toBe(true)
    const snapshot = normalizeModelsDevPayload(sourceFixture(), { fetchedAt: firstNow.toISOString() })
    await replaceModelPricing({
      db,
      models: snapshot.models,
      sourceUrl: snapshot.sourceUrl,
      fetchedAt: snapshot.fetchedAt,
      syncGeneration: 'expired-owner-generation',
      lockToken: firstLock,
      now: firstNow
    })

    const secondLock = 'current-owner-lock'
    expect(
      await claimModelPricingSync({
        db,
        sourceUrl: 'https://models.dev/api.json',
        now: new Date('2026-08-08T00:11:00.000Z'),
        intervalHours: 24,
        force: true,
        lockToken: secondLock
      })
    ).toBe(true)
    await replaceModelPricing({
      db,
      models: snapshot.models,
      sourceUrl: snapshot.sourceUrl,
      fetchedAt: snapshot.fetchedAt,
      syncGeneration: 'current-owner-generation',
      lockToken: secondLock,
      now: new Date('2026-08-08T00:11:00.000Z')
    })

    await expect(
      replaceModelPricing({
        db,
        models: snapshot.models,
        sourceUrl: snapshot.sourceUrl,
        fetchedAt: snapshot.fetchedAt,
        syncGeneration: 'expired-owner-generation',
        lockToken: firstLock,
        now: firstNow
      })
    ).rejects.toThrow('lock ownership was lost before writing staging rows')

    const currentCount = Number.parseInt(
      runSql(
        dbPath,
        "SELECT COUNT(*) FROM model_pricing_staging WHERE generation_id = 'current-owner-generation'"
      ).trim(),
      10
    )
    expect(currentCount).toBe(snapshot.models.length)
    const expiredCount = Number.parseInt(
      runSql(
        dbPath,
        "SELECT COUNT(*) FROM model_pricing_staging WHERE generation_id = 'expired-owner-generation'"
      ).trim(),
      10
    )
    expect(expiredCount).toBe(0)
  })

  test('paginates inactive history instead of silently truncating it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })
    runSql(
      dbPath,
      `
      WITH RECURSIVE numbers(value) AS (
        SELECT 0
        UNION ALL
        SELECT value + 1 FROM numbers WHERE value < 10005
      )
      INSERT INTO model_pricing (
        provider, model_id, display_name, input_cost_per_million, output_cost_per_million,
        context_window, official_docs_url, source_url, pricing_json, is_deprecated,
        is_active, sync_generation, fetched_at
      )
      SELECT
        'history', printf('model-%05d', value), printf('History %05d', value), 1, 2,
        128000, 'https://example.com/docs', 'https://models.dev/api.json', '{}', 0,
        0, 'old-generation', '2026-08-07T00:00:00.000Z'
      FROM numbers;
    `
    )

    const first = await getModelPricing({ db, includeInactive: true, limit: 1_000 })
    expect(first.models).toHaveLength(1_000)
    expect(first.nextCursor).toBeTruthy()

    // The all/inactive view includes every retained generation, so a swap of
    // the active generation must not invalidate a cursor issued for it.
    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-08T00:00:00.000Z'),
      force: true,
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })

    const pages = [first]
    while (pages.at(-1)?.nextCursor) {
      const page = await getModelPricing({
        db,
        includeInactive: true,
        limit: 1_000,
        cursor: pages.at(-1)?.nextCursor ?? undefined
      })
      pages.push(page)
    }
    const allModels = pages.flatMap((page) => page.models)
    expect(allModels).toHaveLength(10_010)
    expect(new Set(allModels.map((model) => `${model.provider}/${model.modelId}`)).size).toBe(10_010)
  }, 15_000)

  test('rejects cursors containing invalid UTF-8 instead of returning an empty page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)

    await expect(getModelPricing({ db, cursor: 'c0af' })).rejects.toThrow('Model pricing cursor is invalid')
  })

  test('rejects a pagination cursor after a new pricing generation becomes active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const fixture = sourceFixture()
    for (let index = 0; index < 105; index += 1) {
      const models = fixture.openai.models as Record<string, unknown>
      models[`gpt-page/${index}`] = pricedModel(`gpt-page/${index}`, 'gpt-page', 128_000, 1, 2)
    }

    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(fixture))
    })
    const first = await getModelPricing({ db, limit: 100 })
    expect(first.nextCursor).toBeTruthy()

    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-08T00:00:00.000Z'),
      force: true,
      fetcher: async () => new Response(JSON.stringify(fixture))
    })

    await expect(getModelPricing({ db, limit: 100, cursor: first.nextCursor ?? undefined })).rejects.toThrow(
      'Model pricing cursor has expired'
    )
  })

  test('binds pagination cursors to the provider filter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const fixture = sourceFixtureWithDeepseek()
    const models = fixture.deepseek.models as Record<string, unknown>
    models['deepseek-page-one'] = pricedModel('deepseek-page-one', 'deepseek-page', 128_000, 1, 2)
    models['deepseek-page-two'] = pricedModel('deepseek-page-two', 'deepseek-page', 128_000, 1, 2)

    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(fixture))
    })

    const filtered = await getModelPricing({ db, provider: 'deepseek', limit: 1 })
    expect(filtered.nextCursor).toBeTruthy()
    await expect(getModelPricing({ db, cursor: filtered.nextCursor ?? undefined, limit: 1 })).rejects.toThrow(
      'Model pricing cursor does not match provider filter'
    )
    await expect(
      getModelPricing({ db, provider: 'openai', cursor: filtered.nextCursor ?? undefined, limit: 1 })
    ).rejects.toThrow('Model pricing cursor does not match provider filter')

    const nextFiltered = await getModelPricing({
      db,
      provider: 'deepseek',
      cursor: filtered.nextCursor ?? undefined,
      limit: 1
    })
    expect(nextFiltered.models).toHaveLength(1)
    expect(nextFiltered.models[0]?.provider).toBe('deepseek')

    const unfiltered = await getModelPricing({ db, limit: 1 })
    expect(unfiltered.nextCursor).toBeTruthy()
    await expect(
      getModelPricing({
        db,
        provider: 'deepseek',
        cursor: unfiltered.nextCursor ?? undefined,
        limit: 1
      })
    ).rejects.toThrow('Model pricing cursor does not match provider filter')
  })

  test('binds repository cursors to the resolved active generation when omitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const fixture = sourceFixture()
    for (let index = 0; index < 105; index += 1) {
      const models = fixture.openai.models as Record<string, unknown>
      models[`gpt-repository-page/${index}`] = pricedModel(`gpt-repository-page/${index}`, 'gpt-page', 128_000, 1, 2)
    }

    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(fixture))
    })
    const first = await listModelPricing(db, { limit: 100 })
    expect(first.nextCursor).toBeTruthy()

    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-08T00:00:00.000Z'),
      force: true,
      fetcher: async () => new Response(JSON.stringify(fixture))
    })

    await expect(
      listModelPricing(db, {
        limit: 100,
        cursor: first.nextCursor ?? undefined
      })
    ).rejects.toThrow('Model pricing cursor has expired')
  })

  test('continues pagination for safe legacy provider and model ids stored in D1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    await runModelPricingSync({
      env: { DB: db, TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '24' },
      now: new Date('2026-08-07T00:00:00.000Z'),
      fetcher: async () => new Response(JSON.stringify(sourceFixture()))
    })
    const generation = runSql(
      dbPath,
      "SELECT active_generation FROM model_pricing_sync_state WHERE id = 'global'"
    ).trim()
    runSql(
      dbPath,
      `
      INSERT INTO model_pricing (
        provider, model_id, display_name, input_cost_per_million, output_cost_per_million,
        context_window, official_docs_url, source_url, pricing_json, is_deprecated,
        is_active, sync_generation, fetched_at
      ) VALUES
        ('a/legacy', 'Model With Spaces', 'Legacy one', 1, 2, 128000, 'https://example.com/docs',
          'https://models.dev/api.json', '{}', 0, 1, '${generation}', '2026-08-07T00:00:00.000Z'),
        ('a/legacy', 'Model/Two', 'Legacy two', 1, 2, 128000, 'https://example.com/docs',
          'https://models.dev/api.json', '{}', 0, 1, '${generation}', '2026-08-07T00:00:00.000Z');
    `
    )

    const first = await getModelPricing({ db, includeInactive: true, limit: 1 })
    expect(first.models[0]).toMatchObject({ provider: 'a/legacy', modelId: 'Model With Spaces' })
    const second = await getModelPricing({
      db,
      includeInactive: true,
      limit: 1,
      cursor: first.nextCursor ?? undefined
    })
    expect(second.models[0]).toMatchObject({ provider: 'a/legacy', modelId: 'Model/Two' })
  })

  test('keeps cursors decodable for long unicode legacy model ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-cursor-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'pricing.db')
    runSql(dbPath, migrationSql())
    const db = createSqliteD1(dbPath)
    const longModelId = '😀'.repeat(512)

    for (const modelId of [longModelId, '😄', 'zzzz']) {
      await db
        .prepare(
          `
        INSERT INTO model_pricing (
          provider, model_id, display_name, input_cost_per_million, output_cost_per_million,
          context_window, official_docs_url, source_url, pricing_json, is_deprecated,
          is_active, sync_generation, fetched_at
        ) VALUES (?, ?, ?, 1, 2, 128000, 'https://example.com/docs',
          'https://models.dev/api.json', '{}', 0, 1, 'legacy-generation', '2026-08-07T00:00:00.000Z')
      `
        )
        .bind('legacy', modelId, modelId)
        .run()
    }

    const pages: Array<{ modelId: string }> = []
    let cursor: string | undefined
    do {
      const page = await getModelPricing({
        db,
        includeInactive: true,
        limit: 1,
        cursor
      })
      pages.push(...page.models)
      cursor = page.nextCursor ?? undefined
    } while (cursor)

    expect(pages.map((model) => model.modelId)).toEqual(['zzzz', longModelId, '😄'])
  })
})

function sourceFixture() {
  return {
    openai: {
      doc: 'https://developers.openai.com/api/docs/pricing',
      models: {
        'gpt-5.6-sol': pricedModel('gpt-5.6-sol', 'gpt-sol', 1_050_000, 5, 30),
        'gpt-5.6-terra': pricedModel('gpt-5.6-terra', 'gpt-terra', 1_050_000, 2, 12)
      }
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

function sourceFixtureWithDeepseek() {
  return {
    ...sourceFixture(),
    deepseek: {
      doc: 'https://api-docs.deepseek.com/quick_start/pricing',
      models: {
        'deepseek-chat': pricedModel('deepseek-chat', 'deepseek-chat', 128_000, 1, 2)
      }
    }
  }
}

function migrationSql() {
  return [
    readFileSync(new URL('../../../db/migrations/0030_model_pricing.sql', import.meta.url), 'utf8'),
    readFileSync(new URL('../../../db/migrations/0031_model_pricing_staging.sql', import.meta.url), 'utf8')
  ].join('\n')
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
