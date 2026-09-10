import { describe, expect, test } from 'vitest'
import {
  fetchModelPricingSource,
  maxModelPricingSourceBytes,
  maxModelPricingValueDepth,
  maxModelPricingValueNodes,
  normalizeModelsDevPayload
} from './source'

describe('model pricing source', () => {
  test('normalizes supported providers and preserves long-context tiers', () => {
    const result = normalizeModelsDevPayload(fixturePayload(), {
      fetchedAt: '2026-08-07T00:00:00.000Z'
    })

    expect(result.models.map((model) => `${model.provider}/${model.modelId}`)).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.6-sol',
      'xai/grok-4.5'
    ])
    expect(result.models[1]).toMatchObject({
      inputCostPerMillion: 5,
      outputCostPerMillion: 30,
      cacheReadCostPerMillion: 0.5,
      contextWindow: 1_050_000,
      maxInputTokens: 922_000,
      sourceUpdatedAt: '2026-07-09'
    })
    expect(result.models[1]?.pricingJson).toContain('272000')
    expect(result.latestSourceUpdatedAt).toBe('2026-07-09')
  })

  test('normalizes all priced providers and source model ids without inventing context', () => {
    const payload = {
      deepseek: {
        doc: 'https://api-docs.deepseek.com/',
        models: {
          'deepseek/deepseek-chat': {
            id: 'deepseek/deepseek-chat',
            name: 'DeepSeek Chat',
            cost: { input: 0.14, output: 0.28 }
          }
        }
      },
      zhipuai: {
        doc: 'https://open.bigmodel.cn/dev/api',
        models: {
          'glm-4.5': {
            id: 'glm-4.5',
            name: 'GLM-4.5',
            limit: { context: 0 },
            cost: { input: 0.4, output: 0.4 }
          }
        }
      }
    }

    expect(normalizeModelsDevPayload(payload).models).toEqual([
      expect.objectContaining({ provider: 'deepseek', modelId: 'deepseek/deepseek-chat', contextWindow: 0 }),
      expect.objectContaining({ provider: 'zhipuai', modelId: 'glm-4.5', contextWindow: 0 })
    ])
  })

  test('skips models without numeric token prices', () => {
    const payload = fixturePayload()
    ;(payload.openai.models as Record<string, unknown>)['gpt-image-1'] = {
      id: 'gpt-image-1',
      family: 'gpt-image',
      limit: { context: 128000 }
    }
    ;(payload.openai.models as Record<string, unknown>)['gpt-6'] = {
      id: 'gpt-6',
      family: 'gpt',
      limit: { context: 128000 }
    }

    expect(normalizeModelsDevPayload(payload).models.some((model) => model.modelId === 'gpt-image-1')).toBe(false)
  })

  test('accepts provider snapshots with no currently priced entries', () => {
    const payload = fixturePayload()
    delete (payload.xai.models as Record<string, unknown>)['grok-4.5']

    expect(normalizeModelsDevPayload(payload).models.some((model) => model.provider === 'xai')).toBe(false)
  })

  test('rejects impossible calendar dates in source metadata', () => {
    const payload = fixturePayload()
    ;(payload.openai.models as Record<string, { last_updated: string }>)['gpt-5.6-sol'].last_updated = '2026-02-30'

    expect(() => normalizeModelsDevPayload(payload)).toThrow('invalid date')
  })

  test('preserves valid month-level source dates', () => {
    const payload = fixturePayload()
    ;(payload.openai.models as Record<string, { last_updated: string }>)['gpt-5.6-sol'].last_updated = '2026-01'
    const model = normalizeModelsDevPayload(payload).models.find((entry) => entry.modelId === 'gpt-5.6-sol')
    expect(model?.sourceUpdatedAt).toBe('2026-01')
  })

  test('orders month-level source dates chronologically', () => {
    const payload = fixturePayload()
    ;(payload.openai.models as Record<string, { last_updated: string }>)['gpt-5.6-sol'].last_updated = '2026-01'
    ;(payload.anthropic.models as Record<string, { last_updated: string }>)['claude-sonnet-5'].last_updated =
      '2025-12-31'
    expect(normalizeModelsDevPayload(payload).latestSourceUpdatedAt).toBe('2026-07-08')
  })

  test('rejects invisible and bidirectional model id controls', () => {
    for (const suffix of ['\u200b', '\u202e', '\u2066']) {
      const payload = fixturePayload()
      const modelId = `gpt-5.6-sol${suffix}`
      const models = payload.openai.models as Record<string, unknown>
      models[modelId] = models['gpt-5.6-sol']
      delete models['gpt-5.6-sol']

      expect(() => normalizeModelsDevPayload(payload)).toThrow('invalid model id')
    }
  })

  test('rejects invisible and bidirectional display name controls', () => {
    for (const displayName of ['Model\u200bName', 'Model\u202eName', 'Model\u2066Name']) {
      const payload = fixturePayload()
      ;(payload.openai.models as Record<string, { name: string }>)['gpt-5.6-sol'].name = displayName

      expect(() => normalizeModelsDevPayload(payload)).toThrow('invalid model name')
    }
  })

  test('trims source display name whitespace but rejects embedded control characters', () => {
    const payload = fixturePayload()
    ;(payload.openai.models as Record<string, { name: string }>)['gpt-5.6-sol'].name = '  GPT-5.6 Sol\t '
    expect(
      normalizeModelsDevPayload(payload).models.find((model) => model.modelId === 'gpt-5.6-sol')?.displayName
    ).toBe('GPT-5.6 Sol')

    ;(payload.openai.models as Record<string, { name: string }>)['gpt-5.6-sol'].name = 'GPT-5.6\tSol'
    expect(() => normalizeModelsDevPayload(payload)).toThrow('invalid model name')
  })

  test('bounds nested pricing depth and node count before serializing', () => {
    const deepPayload = fixturePayload()
    let nested: Record<string, unknown> = { value: 1 }
    for (let index = 0; index < maxModelPricingValueDepth + 1; index += 1) {
      nested = { level: nested }
    }
    ;(deepPayload.openai.models as Record<string, Record<string, unknown>>)['gpt-5.6-sol'].cost = {
      input: 1,
      output: 2,
      tiers: nested
    }
    expect(() => normalizeModelsDevPayload(deepPayload)).toThrow('too deeply nested')

    const widePayload = fixturePayload()
    const wide: Record<string, number> = {}
    for (let index = 0; index < maxModelPricingValueNodes + 1; index += 1) {
      wide[`tier_${index}`] = index
    }
    ;(widePayload.openai.models as Record<string, Record<string, unknown>>)['gpt-5.6-sol'].cost = {
      input: 1,
      output: 2,
      tiers: wide
    }
    expect(() => normalizeModelsDevPayload(widePayload)).toThrow('too many values')
  })

  test('rejects malformed source structure and unapproved source URLs', () => {
    expect(() => normalizeModelsDevPayload({})).toThrow('any models')
    for (const sourceUrl of [
      'https://example.com/api.json',
      'https://user:pass@models.dev/api.json',
      'https://models.dev:8443/api.json',
      'https://models.dev:443/api.json',
      'https://models.dev:0443/api.json'
    ]) {
      expect(() => normalizeModelsDevPayload(fixturePayload(), { sourceUrl })).toThrow('https://models.dev/api.json')
    }
  })

  test('rejects non-routable and shared IPv4 official documentation targets', () => {
    for (const officialDocsUrl of [
      'https://0.0.0.1/docs',
      'https://0.255.255.255/docs',
      'https://100.64.0.1/docs',
      'https://100.127.255.254/docs'
    ]) {
      const payload = fixturePayload()
      payload.openai.doc = officialDocsUrl
      expect(() => normalizeModelsDevPayload(payload)).toThrow('unsafe official docs URL')
    }
  })

  test('rejects bracketed IPv6 loopback and unspecified documentation targets', () => {
    for (const officialDocsUrl of [
      'https://[::1]/docs',
      'https://[::]/docs',
      'https://[::ffff:10.0.0.1]/docs',
      'https://[::ffff:c0a8:101]/docs',
      'https://[::ffff:127.0.0.1]/docs',
      'https://[::192.168.1.1]/docs'
    ]) {
      const payload = fixturePayload()
      payload.openai.doc = officialDocsUrl
      expect(() => normalizeModelsDevPayload(payload)).toThrow('unsafe official docs URL')
    }
  })

  test('rejects 6to4 documentation targets that encode private IPv4 addresses', () => {
    for (const officialDocsUrl of ['https://[2002:7f00:1::]/docs', 'https://[2002:c0a8:101::]/docs']) {
      const payload = fixturePayload()
      payload.openai.doc = officialDocsUrl
      expect(() => normalizeModelsDevPayload(payload)).toThrow('unsafe official docs URL')
    }
  })

  test('rejects alternate private IPv4 spellings and zoned IPv6 targets', () => {
    for (const officialDocsUrl of [
      'https://10.0.0.1./docs',
      'https://10.0.0.1../docs',
      'https://10.0.0.1.../docs',
      'https://2130706433/docs',
      'https://0177.0.0.1/docs'
    ]) {
      const payload = fixturePayload()
      payload.openai.doc = officialDocsUrl
      expect(() => normalizeModelsDevPayload(payload)).toThrow('unsafe official docs URL')
    }

    const payload = fixturePayload()
    payload.openai.doc = 'https://[fe80::1%25en0]/docs'
    expect(() => normalizeModelsDevPayload(payload)).toThrow('invalid official docs URL')
  })

  test('bounds the response body before parsing JSON', async () => {
    const response = new Response('x'.repeat(maxModelPricingSourceBytes + 1), { status: 200 })
    await expect(fetchModelPricingSource({ fetcher: async () => response })).rejects.toThrow('exceeds')
  })

  test('rejects an oversized declared body before buffering a response without a stream', async () => {
    const response = new Response(null, {
      status: 200,
      headers: { 'content-length': String(maxModelPricingSourceBytes + 1) }
    })
    await expect(fetchModelPricingSource({ fetcher: async () => response })).rejects.toThrow('exceeds')
  })

  test('keeps the size-limit diagnostic when cancelling an oversized response fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(maxModelPricingSourceBytes + 1)))
      },
      cancel() {
        throw new Error('cancel failed')
      }
    })
    await expect(
      fetchModelPricingSource({
        fetcher: async () => new Response(body, { status: 200 })
      })
    ).rejects.toThrow('Model pricing source response exceeds')
  })

  test('rejects redirects instead of following an unvalidated pricing source', async () => {
    let requestInit: RequestInit | undefined
    await expect(
      fetchModelPricingSource({
        fetcher: async (_input, init) => {
          requestInit = init
          return new Response('', { status: 302, headers: { location: 'https://attacker.example/' } })
        }
      })
    ).rejects.toThrow('unexpected redirect HTTP 302')
    expect(requestInit?.redirect).toBe('manual')
  })

  test('reports upstream HTTP failures explicitly', async () => {
    await expect(
      fetchModelPricingSource({
        fetcher: async () => new Response('upstream failed', { status: 503 })
      })
    ).rejects.toThrow('HTTP 503')
  })

  test('rejects invalid UTF-8 instead of replacing bytes before JSON parsing', async () => {
    const invalidUtf8 = new Uint8Array([0x7b, 0x22, 0x6f, 0x70, 0x65, 0x6e, 0x61, 0x69, 0x22, 0x3a, 0xff, 0x7d])
    await expect(
      fetchModelPricingSource({
        fetcher: async () => new Response(invalidUtf8, { status: 200 })
      })
    ).rejects.toThrow('invalid UTF-8')
  })

  test('normalizes AbortError and TimeoutError as explicit source timeouts', async () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      await expect(
        fetchModelPricingSource({
          fetcher: async () => {
            throw Object.assign(new Error(name), { name })
          }
        })
      ).rejects.toThrow('Model pricing source request timed out')
    }
  })

  test('normalizes AbortError and TimeoutError while reading the response body', async () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(Object.assign(new Error(name), { name }))
        }
      })
      await expect(
        fetchModelPricingSource({
          fetcher: async () => new Response(body, { status: 200 })
        })
      ).rejects.toThrow('Model pricing source request timed out')
    }
  })
})

function fixturePayload() {
  return {
    openai: {
      doc: 'https://developers.openai.com/api/docs/pricing',
      models: {
        'gpt-5.6-sol': {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          family: 'gpt-sol',
          last_updated: '2026-07-09',
          limit: { context: 1_050_000, input: 922_000, output: 128_000 },
          cost: {
            input: 5,
            output: 30,
            cache_read: 0.5,
            tiers: [{ input: 10, output: 45, tier: { type: 'context', size: 272000 } }]
          }
        }
      }
    },
    anthropic: {
      doc: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
      models: {
        'claude-sonnet-5': {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5',
          family: 'claude-sonnet',
          last_updated: '2026-06-30',
          limit: { context: 1_000_000, output: 128_000 },
          cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }
        }
      }
    },
    xai: {
      doc: 'https://docs.x.ai/docs/models',
      models: {
        'grok-4.5': {
          id: 'grok-4.5',
          name: 'Grok 4.5',
          family: 'grok',
          last_updated: '2026-07-08',
          limit: { context: 500_000, output: 500_000 },
          cost: { input: 2, output: 6, cache_read: 0.3 }
        }
      }
    }
  }
}
