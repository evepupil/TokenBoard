import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { maxCodexChildSessionLineBytes } from './codex-subagent-usage-child'
import {
  applyCodexContextPricingCosts,
  applyCodexContextPricingUsageModelHints,
  collectCodexContextPricingCostsFromFiles,
  collectCodexContextPricingCostsFromHomes,
  isUnresolvedCodexContextPricingSnapshot,
  maxCodexContextPricingFiles,
  normalizeModelId,
  priceCodexRequest,
  priceCodexContextPricingUsages
} from './codex-context-pricing'

describe('Codex context pricing', () => {
  test('rejects an unbounded full-history scan before opening files', async () => {
    const filePaths = Array.from(
      { length: maxCodexContextPricingFiles + 1 },
      (_, index) => `/unreadable/codex-session-${index}.jsonl`
    )

    await expect(
      collectCodexContextPricingCostsFromFiles({
        filePaths,
        timezone: 'UTC'
      })
    ).rejects.toThrow(`exceeds ${maxCodexContextPricingFiles}`)
  })

  test.each([
    [271_999, 5 / 1_000_000],
    [272_000, 5 / 1_000_000],
    [272_001, 10 / 1_000_000]
  ])('uses the GPT-5.6 request tier at %d input tokens', (inputTokens, inputRate) => {
    expect(
      priceCodexRequest({
        model: 'gpt-5.6-sol',
        inputTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
    ).toBeCloseTo(inputTokens * inputRate, 12)
  })

  test('uses the long-context tier when cache creation crosses the 272k request boundary', () => {
    const cost = priceCodexRequest({
      model: 'gpt-5.6-sol',
      inputTokens: 272_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 1
    })

    expect(cost).toBeCloseTo((272_000 * 10 + 12.5) / 1_000_000, 12)
  })

  test.each([
    [199_999, 2 / 1_000_000],
    [200_000, 2 / 1_000_000],
    [200_001, 4 / 1_000_000]
  ])('uses the Grok request tier at %d input tokens', (inputTokens, inputRate) => {
    expect(
      priceCodexRequest({
        model: 'grok-4.5',
        inputTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
    ).toBeCloseTo(inputTokens * inputRate, 12)
  })

  test.each([
    ['gpt-5.6-terra', 4 / 1_000_000],
    ['gpt-5.6-luna', 0.4 / 1_000_000],
    ['gpt-5.5', 10 / 1_000_000],
    ['gpt-5.5-pro', 60 / 1_000_000],
    ['gpt-5.4', 5 / 1_000_000],
    ['gpt-5.4-pro', 60 / 1_000_000]
  ])('uses the published 272k tier for %s', (model, inputRate) => {
    expect(
      priceCodexRequest({
        model,
        inputTokens: 272_001,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
    ).toBeCloseTo(272_001 * inputRate, 12)
  })

  test('prices every component with the long-context tier, not only input tokens', () => {
    const cost = priceCodexRequest({
      model: 'gpt-5.6-sol',
      inputTokens: 272_001,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheCreationTokens: 1
    })

    expect(cost).toBeCloseTo((272_000 * 10 + 1 + 12.5 + 45) / 1_000_000, 12)
  })

  test('prices additive cached input separately from uncached input', () => {
    const cost = priceCodexRequest({
      model: 'gpt-5.6-sol',
      inputTokens: 200,
      uncachedInputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 150,
      cacheCreationTokens: 0
    })

    expect(cost).toBeCloseTo((50 * 5 + 150 * 0.5 + 20 * 30) / 1_000_000, 12)
  })

  test('applies the fast and priority multiplier and normalizes dated model ids', () => {
    const standard = priceCodexRequest({
      model: 'gpt-5.6-sol-20260807',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheCreationTokens: 1,
      serviceTier: 'standard'
    })
    const fast = priceCodexRequest({
      model: 'gpt-5.6-sol-20260807',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheCreationTokens: 1,
      serviceTier: 'fast'
    })
    const priority = priceCodexRequest({
      model: 'gpt-5.6-sol',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheCreationTokens: 1,
      serviceTier: 'priority'
    })

    for (const result of [standard, fast, priority]) {
      expect(typeof result).toBe('number')
      expect(Number.isFinite(result)).toBe(true)
    }
    expect(fast).toBeCloseTo((standard as number) * 2, 12)
    expect(priority).toBeCloseTo(fast as number, 12)
  })

  test.each([
    ['gpt-5.6-sol-20260807', 'gpt-5.6-sol'],
    ['gpt-5.6-sol-20240229', 'gpt-5.6-sol'],
    ['gpt-5.6-sol-20260230', 'gpt-5.6-sol-20260230'],
    ['gpt-5.6-sol-20250229', 'gpt-5.6-sol-20250229'],
    ['gpt-5.6-sol-20251301', 'gpt-5.6-sol-20251301'],
    ['gpt-5.6-sol-20250132', 'gpt-5.6-sol-20250132'],
    ['gpt-5.6-sol-12345678', 'gpt-5.6-sol-12345678'],
    ['-20260807', '-20260807'],
    ['', ''],
    ['  ', ''],
    ['GPT-4', 'gpt-4'],
    ['gpt-5-20241201', 'gpt-5-20241201'],
    ['model-2026-0807', 'model-2026-0807']
  ])('only strips valid calendar dates from model ids: %s', (value, expected) => {
    expect(normalizeModelId(value)).toBe(expected)
  })

  test('reconstructs cumulative token rows and deduplicates only identical events across files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-pricing-'))
    const first = join(root, 'sessions', 'first.jsonl')
    const duplicate = join(root, 'sessions', 'duplicate.jsonl')
    const distinct = join(root, 'sessions', 'distinct.jsonl')
    const rows = [
      tokenCount('2026-05-01T00:00:00.000Z', {
        last_token_usage: { input_tokens: 271_999, output_tokens: 1, total_tokens: 272_000 }
      }),
      tokenCount('2026-05-01T00:01:00.000Z', {
        last_token_usage: { input_tokens: 272_001, output_tokens: 1, total_tokens: 272_002 }
      })
    ]

    try {
      await Promise.all([
        writeJsonl(first, [sessionMeta('same-session'), ...rows]),
        writeJsonl(duplicate, [sessionMeta('same-session'), ...rows]),
        writeJsonl(distinct, [
          sessionMeta('different-session'),
          tokenCount('2026-05-01T00:02:00.000Z', {
            last_token_usage: { input_tokens: 272_001, output_tokens: 1, total_tokens: 272_002 }
          })
        ])
      ])

      const costs = await collectCodexContextPricingCostsFromFiles({
        filePaths: [first, duplicate, distinct],
        timezone: 'UTC'
      })

      expect(costs).toEqual([
        {
          usageDate: '2026-05-01',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((271_999 * 5 + 30) / 1_000_000 + 2 * ((272_001 * 10 + 45) / 1_000_000), 12)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not deduplicate equal usage from different sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-session-identity-'))
    const first = join(root, 'sessions', 'first.jsonl')
    const second = join(root, 'sessions', 'second.jsonl')
    try {
      const row = tokenCount('2026-05-01T00:00:00.000Z', { last_token_usage: usage(10) })
      await Promise.all([
        writeJsonl(first, [sessionMeta('first-session'), row]),
        writeJsonl(second, [sessionMeta('second-session'), row])
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [first, second],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (20 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips context pricing models outside the ccusage daily model scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-scope-'))
    const file = join(root, 'sessions', 'excluded.jsonl')
    try {
      await writeJsonl(file, [
        sessionMeta('excluded-session'),
        tokenCount('2026-05-01T00:00:00.000Z', { last_token_usage: usage(10) }, 'gpt-5.4')
      ])

      const diagnostics: string[] = []
      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByDate: new Map([['2026-05-01', new Set(['gpt-5.5', 'gpt-5.6-sol'])]]),
          timezone: 'UTC',
          stderr: (line) => diagnostics.push(line)
        })
      ).resolves.toEqual([])
      expect(diagnostics).toEqual([
        'Codex context pricing skipped gpt-5.4 usage outside the ccusage daily model scope for 2026-05-01'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('deduplicates an archived copy when session metadata has no identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-anonymous-copy-'))
    const active = join(root, 'sessions', '2026', '05', '20', 'same-file.jsonl')
    const archived = join(root, 'archived_sessions', '2026', '05', '20', 'same-file.jsonl')
    try {
      const row = tokenCount('2026-05-01T00:00:00.000Z', { last_token_usage: usage(10) })
      await Promise.all([writeJsonl(active, [row]), writeJsonl(archived, [row])])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [active, archived],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('prefers the active copy when active and archived contents differ', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-active-copy-'))
    const active = join(root, 'sessions', '2026', '05', '20', 'same-file.jsonl')
    const archived = join(root, 'archived_sessions', '2026', '05', '20', 'same-file.jsonl')
    try {
      await Promise.all([
        writeJsonl(active, [tokenCount('2026-05-01T00:00:00.000Z', { last_token_usage: usage(10) })]),
        writeJsonl(archived, [tokenCount('2026-05-01T00:01:00.000Z', { last_token_usage: usage(20) })])
      ])

      await expect(
        collectCodexContextPricingCostsFromHomes({
          codexHomes: [root],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('deduplicates an archived copy when only the active session has an identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-identified-copy-'))
    const active = join(root, 'sessions', '2026', '05', '20', 'same-file.jsonl')
    const archived = join(root, 'archived_sessions', '2026', '05', '20', 'same-file.jsonl')
    try {
      const row = tokenCount('2026-05-01T00:00:00.000Z', { last_token_usage: usage(10) })
      await Promise.all([writeJsonl(active, [sessionMeta('same-session'), row]), writeJsonl(archived, [row])])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [active, archived],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('deduplicates an active copy when only the archived session has an identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-archived-identity-'))
    const active = join(root, 'sessions', '2026', '05', '20', 'same-file.jsonl')
    const archived = join(root, 'archived_sessions', '2026', '05', '20', 'same-file.jsonl')
    try {
      const row = tokenCount('2026-05-01T00:00:00.000Z', { last_token_usage: usage(10) })
      await Promise.all([writeJsonl(active, [row]), writeJsonl(archived, [sessionMeta('same-session'), row])])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [archived, active],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not double count when only one archive copy exposes identity after the other was scanned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-identity-order-'))
    const active = join(root, 'sessions', '2026', '05', '20', 'same-file.jsonl')
    const archived = join(root, 'archived_sessions', '2026', '05', '20', 'same-file.jsonl')
    try {
      const row = tokenCount('2026-05-01T00:00:00.000Z', { last_token_usage: usage(10) })
      await Promise.all([writeJsonl(active, [row]), writeJsonl(archived, [sessionMeta('same-session'), row])])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [active, archived],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps anonymous sessions with the same filename separate across profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-profile-identity-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const relativePath = join('2026', '05', '20', 'same-file.jsonl')
    try {
      const row = tokenCount('2026-05-01T00:00:00.000Z', { last_token_usage: usage(10) })
      await Promise.all([
        writeJsonl(join(firstHome, 'sessions', relativePath), [row]),
        writeJsonl(join(secondHome, 'sessions', relativePath), [row])
      ])

      await expect(
        collectCodexContextPricingCostsFromHomes({
          codexHomes: [firstHome, secondHome],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (20 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps sessions with the same metadata id separate across profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-profile-session-id-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const relativePath = join('2026', '05', '20', 'same-session.jsonl')
    try {
      const rows = [
        sessionMeta('same-session-id'),
        tokenCount('2026-05-01T00:00:00.000Z', { last_token_usage: usage(10) })
      ]
      await Promise.all([
        writeJsonl(join(firstHome, 'sessions', relativePath), rows),
        writeJsonl(join(secondHome, 'sessions', relativePath), rows)
      ])

      await expect(
        collectCodexContextPricingCostsFromHomes({
          codexHomes: [firstHome, secondHome],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (20 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('deduplicates a session copied into a symlinked archive root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-symlink-archive-'))
    const home = join(root, 'codex-home')
    const archive = join(root, 'archive-target')
    const relativePath = join('2026', '05', '20', 'same-file.jsonl')
    try {
      const row = tokenCount('2026-05-01T00:00:00.000Z', { last_token_usage: usage(10) })
      await Promise.all([
        writeJsonl(join(home, 'sessions', relativePath), [row]),
        writeJsonl(join(archive, relativePath), [row])
      ])
      await mkdir(home, { recursive: true })
      await symlink(archive, join(home, 'archived_sessions'), process.platform === 'win32' ? 'junction' : 'dir')

      await expect(
        collectCodexContextPricingCostsFromHomes({
          codexHomes: [home],
          timezone: 'UTC',
          codexSymlinkRoots: [archive]
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps cumulative baselines separate when one session changes models', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-model-switch-'))
    const file = join(root, 'sessions', 'switch.jsonl')
    try {
      await writeJsonl(file, [
        sessionMeta('switching-session'),
        turnContext('gpt-5.6-sol'),
        tokenCount('2026-05-01T00:00:00.000Z', { total_token_usage: usage(10) }, 'gpt-5.6-sol'),
        turnContext('gpt-5.6-terra'),
        tokenCount('2026-05-01T00:01:00.000Z', { total_token_usage: usage(5) }, 'gpt-5.6-terra'),
        turnContext('gpt-5.6-sol'),
        tokenCount('2026-05-01T00:02:00.000Z', { total_token_usage: usage(15) }, 'gpt-5.6-sol')
      ])

      const costs = await collectCodexContextPricingCostsFromFiles({
        filePaths: [file],
        timezone: 'UTC'
      })
      expect(costs).toHaveLength(2)
      expect(costs[0]).toMatchObject({ usageDate: '2026-05-01', model: 'gpt-5.6-sol' })
      expect(costs[0]?.costUsd).toBeCloseTo((15 * 5) / 1_000_000, 14)
      expect(costs[1]).toMatchObject({ usageDate: '2026-05-01', model: 'gpt-5.6-terra' })
      expect(costs[1]?.costUsd).toBeCloseTo((5 * 2) / 1_000_000, 14)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps cumulative baselines continuous across aliases in one model family', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-alias-switch-'))
    const file = join(root, 'sessions', 'switch.jsonl')
    try {
      await writeJsonl(file, [
        sessionMeta('alias-switch-session'),
        turnContext('gpt-5.6'),
        tokenCount('2026-05-01T00:00:00.000Z', { total_token_usage: usage(10) }, 'gpt-5.6'),
        turnContext('gpt-5.6-sol'),
        tokenCount('2026-05-01T00:01:00.000Z', { total_token_usage: usage(15) }, 'gpt-5.6-sol')
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        { usageDate: '2026-05-01', model: 'gpt-5.6', costUsd: (10 * 5) / 1_000_000 },
        { usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (5 * 5) / 1_000_000 }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('maps Codex auto-review usage to the release-date fallback model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-auto-review-'))
    const file = join(root, 'sessions', 'auto-review.jsonl')
    try {
      await writeJsonl(file, [
        turnContext('codex-auto-review'),
        tokenCount('2026-04-23T00:00:00.000Z', { last_token_usage: usage(10) }, null),
        tokenCount('2026-03-05T00:00:00.000Z', { last_token_usage: usage(20) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        { usageDate: '2026-04-23', model: 'gpt-5.5', costUsd: (10 * 5) / 1_000_000 },
        { usageDate: '2026-03-05', model: 'gpt-5.4', costUsd: (20 * 2.5) / 1_000_000 }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retains the model from an oversized turn_context for following token rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-oversized-turn-context-'))
    const file = join(root, 'sessions', 'oversized-turn-context.jsonl')
    const diagnostics: string[] = []
    try {
      await writeJsonl(file, [
        {
          type: 'turn_context',
          payload: {
            model: 'codex-auto-review',
            context: 'x'.repeat(maxCodexChildSessionLineBytes + 1)
          }
        },
        tokenCount('2026-08-12T00:00:00.000Z', { last_token_usage: usage(10) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC',
          stderr: (line) => diagnostics.push(line)
        })
      ).resolves.toEqual([{ usageDate: '2026-08-12', model: 'gpt-5.5', costUsd: (10 * 5) / 1_000_000 }])
      expect(diagnostics).toEqual([
        expect.stringContaining(
          'Retained bounded turn_context metadata from 1 oversized Codex context pricing JSONL row'
        )
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retains model_name from nested oversized turn_context metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-oversized-turn-context-metadata-'))
    const file = join(root, 'sessions', 'oversized-turn-context-metadata.jsonl')
    try {
      await writeJsonl(file, [
        {
          type: 'turn_context',
          payload: {
            metadata: { model_name: 'codex-auto-review' },
            context: 'x'.repeat(maxCodexChildSessionLineBytes + 1)
          }
        },
        tokenCount('2026-08-12T00:00:00.000Z', { last_token_usage: usage(10) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-08-12', model: 'gpt-5.5', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the primary oversized turn_context model when metadata has a conflicting fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-oversized-turn-context-conflict-'))
    const file = join(root, 'sessions', 'oversized-turn-context-conflict.jsonl')
    try {
      await writeJsonl(file, [
        {
          type: 'turn_context',
          payload: {
            model: 'gpt-5.6-sol',
            metadata: { model_name: 'codex-auto-review' },
            context: 'x'.repeat(maxCodexChildSessionLineBytes + 1)
          }
        },
        tokenCount('2026-08-12T00:00:00.000Z', { last_token_usage: usage(10) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-08-12', model: 'gpt-5.6-sol', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the configured timezone when auto-review crosses a UTC date boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-auto-review-timezone-'))
    const file = join(root, 'sessions', 'auto-review.jsonl')
    try {
      await writeJsonl(file, [
        turnContext('codex-auto-review'),
        tokenCount('2026-04-22T16:30:00.000Z', { last_token_usage: usage(10) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'Asia/Shanghai'
        })
      ).resolves.toEqual([{ usageDate: '2026-04-23', model: 'gpt-5.5', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('maps a raw fallback model to the only canonical model for that date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-canonical-hint-'))
    const file = join(root, 'sessions', 'fallback.jsonl')
    try {
      await writeJsonl(file, [
        turnContext('gpt-5.4'),
        tokenCount('2026-07-03T00:00:00.000Z', { last_token_usage: usage(10) }, 'gpt-5.4')
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByDate: new Map([['2026-07-03', new Set(['gpt-5.5'])]]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-07-03', model: 'gpt-5.5', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('maps a historical model to the canonical model for its session file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-file-model-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        sessionMeta('historical-model-session'),
        turnContext('gpt-5.5'),
        tokenCount('2026-07-18T00:00:00.000Z', { last_token_usage: usage(10) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'gpt-5.6-terra']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-07-18',
          model: 'gpt-5.6-terra',
          costUsd: expect.closeTo((10 * 2) / 1_000_000, 14)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('normalizes a dated canonical model hint before pricing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-dated-canonical-hint-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        turnContext('gpt-5.6-sol'),
        tokenCount('2026-07-18T00:00:00.000Z', { last_token_usage: usage(10) }, 'gpt-5.6-sol')
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'gpt-5.6-sol-20260807']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-07-18',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((10 * 5) / 1_000_000, 14)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('prices context events after a mixed-model session was attributed to a non-context model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-file-mixed-model-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        sessionMeta('mixed-model-session'),
        turnContext('deepseek-v4-flash'),
        tokenCount('2026-07-18T00:00:00.000Z', { last_token_usage: usage(10) }, null),
        turnContext('gpt-5.6-sol'),
        tokenCount('2026-07-18T00:01:00.000Z', { last_token_usage: usage(20) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'deepseek-v4-flash']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-07-18',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((20 * 5) / 1_000_000, 14)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('prices only the cumulative increment after a non-context model switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-file-mixed-cumulative-'))
    const file = join(root, 'sessions', 'mixed-cumulative.jsonl')
    try {
      await writeJsonl(file, [
        sessionMeta('mixed-cumulative-session'),
        turnContext('deepseek-v4-flash'),
        tokenCount('2026-07-18T00:00:00.000Z', { total_token_usage: usage(100) }, null),
        turnContext('gpt-5.6-sol'),
        tokenCount('2026-07-18T00:01:00.000Z', { total_token_usage: usage(120) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'deepseek-v4-flash']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-07-18',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((20 * 5) / 1_000_000, 14)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('shares the cumulative baseline when a mixed session switches to auto-review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-file-mixed-auto-review-cumulative-'))
    const file = join(root, 'sessions', 'mixed-auto-review-cumulative.jsonl')
    try {
      await writeJsonl(file, [
        sessionMeta('mixed-auto-review-cumulative-session'),
        turnContext('deepseek-v4-flash'),
        tokenCount('2026-08-12T00:00:00.000Z', { total_token_usage: usage(100) }, null),
        turnContext('codex-auto-review'),
        tokenCount('2026-08-12T00:01:00.000Z', { total_token_usage: usage(120) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'deepseek-v4-flash']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-08-12',
          model: 'gpt-5.5',
          costUsd: expect.closeTo((20 * 5) / 1_000_000, 14)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps a context event after an initial non-context model has no token row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-file-context-only-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        sessionMeta('context-only-after-attribution'),
        turnContext('deepseek-v4-flash'),
        turnContext('gpt-5.6-sol'),
        tokenCount('2026-07-18T00:01:00.000Z', { last_token_usage: usage(20) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'deepseek-v4-flash']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-07-18',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((20 * 5) / 1_000_000, 14)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps context token rows when the canonical non-context file has no turn_context row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-file-context-row-only-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        sessionMeta('context-row-only-after-attribution'),
        tokenCount('2026-07-18T00:01:00.000Z', { last_token_usage: usage(20) }, 'gpt-5.6-sol')
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'deepseek-v4-flash']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-07-18',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((20 * 5) / 1_000_000, 14)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps context token rows when the explicit model is nested in the payload usage fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-file-payload-model-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        {
          timestamp: '2026-07-18T00:01:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            total_token_usage: { model: 'gpt-5.6-sol', ...usage(20) },
            usage: usage(20)
          }
        }
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'deepseek-v4-flash']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-07-18',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((20 * 5) / 1_000_000, 14)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not crash while classifying auto-review in a mixed-model session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-auto-review-mixed-model-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        turnContext('deepseek-v4-flash'),
        turnContext('codex-auto-review'),
        tokenCount('2026-08-12T00:00:00.000Z', { last_token_usage: usage(10) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'deepseek-v4-flash']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-08-12', model: 'gpt-5.5', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps an auto-review-only session attributed to a non-context model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-auto-review-only-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        turnContext('codex-auto-review'),
        tokenCount('2026-08-12T00:00:00.000Z', { last_token_usage: usage(10) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'deepseek-v4-flash']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-08-12', model: 'gpt-5.5', costUsd: (10 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not price a historical context model against a non-context canonical session model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-file-non-context-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        sessionMeta('non-context-session'),
        turnContext('gpt-5.5'),
        tokenCount('2026-07-18T00:00:00.000Z', { last_token_usage: usage(10) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'deepseek-v4-flash']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips malformed non-context files after ccusage attribution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-file-skip-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeFile(file, '{not-json\n')

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByFile: new Map([[file, 'deepseek-v4-flash']]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps a raw model distinct when the date has multiple canonical models', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-canonical-multi-'))
    const file = join(root, 'sessions', 'fallback.jsonl')
    try {
      await writeJsonl(file, [
        turnContext('gpt-5.4'),
        tokenCount('2026-07-08T00:00:00.000Z', { last_token_usage: usage(10) }, 'gpt-5.4')
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          canonicalModelsByDate: new Map([['2026-07-08', new Set(['gpt-5.4', 'gpt-5.5'])]]),
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-07-08', model: 'gpt-5.4', costUsd: (10 * 2.5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps request context tiers when canonical model hints remap a day', () => {
    const usages = [
      {
        usageDate: '2026-07-03',
        model: 'gpt-5.4',
        inputTokens: 10,
        uncachedInputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        serviceTier: null,
        contextTier: 'standard' as const
      },
      {
        usageDate: '2026-07-03',
        model: 'gpt-5.4',
        inputTokens: 272_001,
        uncachedInputTokens: 272_001,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        serviceTier: null,
        contextTier: 'long' as const
      }
    ]
    const mapped = applyCodexContextPricingUsageModelHints(usages, new Map([['2026-07-03', new Set(['gpt-5.5'])]]))
    expect(priceCodexContextPricingUsages(mapped)[0]?.costUsd).toBeCloseTo((10 * 5 + 272_001 * 10) / 1_000_000, 12)
  })

  test('derives optional total tokens from components while applying model hints', () => {
    const mapped = applyCodexContextPricingUsageModelHints([
      {
        usageDate: '2026-07-03',
        model: 'gpt-5.4',
        inputTokens: 10,
        uncachedInputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheCreationTokens: 3,
        serviceTier: null,
        contextTier: 'standard'
      },
      {
        usageDate: '2026-07-03',
        model: 'gpt-5.4',
        inputTokens: 20,
        uncachedInputTokens: 20,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheCreationTokens: 6,
        serviceTier: null,
        contextTier: 'standard'
      }
    ])

    expect(mapped).toHaveLength(1)
    expect(mapped[0]?.totalTokens).toBe(45)
  })

  test('uses ccusage legacy gpt-5 fallback before the first auto-review release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-auto-review-legacy-'))
    const file = join(root, 'sessions', 'auto-review.jsonl')
    try {
      await writeJsonl(file, [
        turnContext('codex-auto-review'),
        tokenCount('2025-08-06T00:00:00.000Z', { last_token_usage: usage(10) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps auto-review cumulative usage continuous across fallback model releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-auto-review-cumulative-'))
    const file = join(root, 'sessions', 'auto-review.jsonl')
    try {
      await writeJsonl(file, [
        turnContext('codex-auto-review'),
        tokenCount('2026-03-05T00:00:00.000Z', { total_token_usage: usage(100) }, null),
        tokenCount('2026-04-23T00:00:00.000Z', { total_token_usage: usage(150) }, null)
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        { usageDate: '2026-03-05', model: 'gpt-5.4', costUsd: (100 * 2.5) / 1_000_000 },
        { usageDate: '2026-04-23', model: 'gpt-5.5', costUsd: (50 * 5) / 1_000_000 }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the first cumulative-only child row as a baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-child-baseline-'))
    const file = join(root, 'sessions', 'child.jsonl')
    try {
      await writeJsonl(file, [
        {
          type: 'session_meta',
          id: 'child-session',
          payload: {
            source: {
              subagent: {
                thread_spawn: { parent_thread_id: 'parent-session' }
              }
            }
          }
        },
        tokenCount('2026-05-01T00:00:00.000Z', { total_token_usage: usage(100) }),
        tokenCount('2026-05-01T00:01:00.000Z', { total_token_usage: usage(150) })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (50 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the first cumulative-only row as a baseline when child metadata omits the parent id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-child-metadata-'))
    const file = join(root, 'sessions', 'child.jsonl')
    try {
      await writeJsonl(file, [
        {
          type: 'session_meta',
          id: 'child-session-without-parent-id',
          payload: { source: { subagent: { thread_spawn: {} } } }
        },
        tokenCount('2026-05-01T00:00:00.000Z', { total_token_usage: usage(100) }),
        tokenCount('2026-05-01T00:01:00.000Z', { total_token_usage: usage(150) })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: (50 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('filters raw events by the configured timezone and inclusive date bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-bounds-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        tokenCount('2026-05-01T15:30:00.000Z', { last_token_usage: usage(10) }),
        tokenCount('2026-05-02T00:30:00.000Z', { last_token_usage: usage(20) }),
        tokenCount('2026-05-03T00:30:00.000Z', { last_token_usage: usage(30) })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'Asia/Shanghai',
          since: '20260502',
          until: '20260502'
        })
      ).resolves.toEqual([{ usageDate: '2026-05-02', model: 'gpt-5.6-sol', costUsd: (20 * 5) / 1_000_000 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails when a collected raw cost has no matching daily snapshot', () => {
    expect(() =>
      applyCodexContextPricingCosts(
        [{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 0, totalTokens: 10 }],
        [{ usageDate: '2026-05-02', model: 'gpt-5.6-sol', costUsd: 1 }]
      )
    ).toThrow('Codex context pricing cannot match daily snapshot')
  })

  test('fails when raw context pricing attributes a date to a different model', () => {
    expect(() =>
      applyCodexContextPricingCosts(
        [{ usageDate: '2026-05-01', model: 'gpt-5.6-terra', costUsd: 0, totalTokens: 10 }],
        [{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 1 }]
      )
    ).toThrow('Codex context pricing cannot match daily snapshot')
  })

  test('matches ccusage aliases to the canonical context-pricing model', () => {
    expect(() =>
      applyCodexContextPricingCosts(
        [{ usageDate: '2026-05-01', model: 'gpt-5.6', costUsd: 0, totalTokens: 10 }],
        [{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 1 }]
      )
    ).not.toThrow()
    expect(
      applyCodexContextPricingCosts(
        [{ usageDate: '2026-05-01', model: 'gpt-5.6', costUsd: 0, totalTokens: 10 }],
        [{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 1 }]
      )[0]?.costUsd
    ).toBe(1)
  })

  test('keeps same-day GPT-5.6 aliases as independent cost matches', () => {
    const result = applyCodexContextPricingCosts(
      [
        { usageDate: '2026-05-01', model: 'gpt-5.6', costUsd: 0, totalTokens: 10 },
        { usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 0, totalTokens: 20 }
      ],
      [
        { usageDate: '2026-05-01', model: 'gpt-5.6', costUsd: 1 },
        { usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 2 }
      ]
    )

    expect(result.map((snapshot) => snapshot.costUsd)).toEqual([1, 2])
  })

  test('fails instead of assigning one alias raw cost to multiple same-day snapshots', () => {
    expect(() =>
      applyCodexContextPricingCosts(
        [
          { usageDate: '2026-05-01', model: 'gpt-5.6', costUsd: 0, totalTokens: 10 },
          { usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 0, totalTokens: 20 }
        ],
        [{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 2 }]
      )
    ).toThrow('Codex context pricing cannot match raw cost')
  })

  test('fails instead of assigning one exact raw cost to duplicate snapshots', () => {
    expect(() =>
      applyCodexContextPricingCosts(
        [
          { usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 0, totalTokens: 10 },
          { usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 0, totalTokens: 20 }
        ],
        [{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 2 }]
      )
    ).toThrow('Codex context pricing cannot match duplicate daily snapshots')
  })

  test('fails when a priced daily snapshot has no raw context-pricing cost', () => {
    const diagnostics: string[] = []
    expect(() =>
      applyCodexContextPricingCosts(
        [{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 7, totalTokens: 10 }],
        [],
        (line) => diagnostics.push(line)
      )
    ).toThrow('Codex context pricing cannot match raw cost')
    expect(diagnostics).toEqual([
      'Codex context pricing found gpt-5.6-sol daily usage without an unambiguous raw cost for 2026-05-01'
    ])
  })

  test('does not require raw context-pricing cost for a zero-token snapshot', () => {
    expect(
      applyCodexContextPricingCosts([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 7, totalTokens: 0 }], [])
    ).toEqual([{ usageDate: '2026-05-01', model: 'gpt-5.6-sol', costUsd: 7, totalTokens: 0 }])
  })

  test('does not require raw context-pricing cost for metadata-only token totals', () => {
    const snapshot = {
      usageDate: '2026-05-01',
      model: 'gpt-5.6-sol',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      totalTokens: 42
    }

    expect(applyCodexContextPricingCosts([snapshot], [])).toEqual([snapshot])
    expect(isUnresolvedCodexContextPricingSnapshot({ source: 'codex', ...snapshot })).toBe(false)
  })

  test('keeps a billable snapshot unresolved even when its cached cost is non-zero', () => {
    expect(
      isUnresolvedCodexContextPricingSnapshot({
        source: 'codex',
        model: 'gpt-5.6-sol',
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 10,
        costUsd: 0.01
      })
    ).toBe(true)
  })

  test('rejects malformed recognized token fields instead of pricing them as zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-invalid-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        tokenCount('2026-05-01T00:00:00.000Z', {
          last_token_usage: { input_tokens: '10', output_tokens: 1 }
        })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).rejects.toThrow('Invalid Codex token usage field input_tokens')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('ignores total-only bookkeeping rows without failing the file scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-total-only-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        tokenCount('2026-05-01T00:00:00.000Z', {
          last_token_usage: { total_tokens: 42, output_tokens: 0 }
        })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.each([
    ['fractional', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1]
  ])('rejects %s token fields', async (_label, value) => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-invalid-number-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        tokenCount('2026-05-01T00:00:00.000Z', {
          last_token_usage: { input_tokens: value, output_tokens: 1 }
        })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).rejects.toThrow('Invalid Codex token usage field input_tokens')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('accepts additive cached input and applies the long tier to full context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-additive-cache-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        tokenCount('2026-05-01T00:00:00.000Z', {
          last_token_usage: {
            input_tokens: 200_000,
            cached_input_tokens: 100_000,
            output_tokens: 1,
            total_tokens: 300_001
          }
        })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-05-01',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((200_000 * 10 + 100_000 * 1 + 1 * 45) / 1_000_000, 12)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('applies the long tier when cache creation crosses the request boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-cache-boundary-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        tokenCount('2026-05-01T00:00:00.000Z', {
          last_token_usage: {
            input_tokens: 272_000,
            cache_write_input_tokens: 1,
            output_tokens: 0,
            total_tokens: 272_001
          }
        })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-05-01',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((272_000 * 10 + 12.5) / 1_000_000, 12)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('accepts the current cache-write field as cache creation input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-cache-write-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        tokenCount('2026-05-01T00:00:00.000Z', {
          last_token_usage: {
            input_tokens: 10,
            cache_read_input_tokens: 4,
            cache_write_input_tokens: 3,
            output_tokens: 2,
            total_tokens: 19
          }
        })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-05-01',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((10 * 5 + 4 * 0.5 + 3 * 6.25 + 2 * 30) / 1_000_000, 12)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('ignores metadata rows with positive total but no billable token components', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-metadata-row-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        tokenCount('2026-05-01T00:00:00.000Z', {
          last_token_usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 21_391,
            total_tokens: 21_391
          }
        })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('treats a zero total as legacy-compatible instead of adding cached input twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-zero-total-'))
    const file = join(root, 'session.jsonl')
    try {
      await writeJsonl(file, [
        tokenCount('2026-05-01T00:00:00.000Z', {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 1,
            total_tokens: 0
          }
        })
      ])

      await expect(
        collectCodexContextPricingCostsFromFiles({
          filePaths: [file],
          timezone: 'UTC'
        })
      ).resolves.toEqual([
        {
          usageDate: '2026-05-01',
          model: 'gpt-5.6-sol',
          costUsd: expect.closeTo((60 * 5 + 40 * 0.5 + 1 * 30) / 1_000_000, 12)
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function usage(inputTokens: number) {
  return { input_tokens: inputTokens, output_tokens: 0, total_tokens: inputTokens }
}

function tokenCount(timestamp: string, usagePayload: Record<string, unknown>, model: string | null = 'gpt-5.6-sol') {
  const info = model === null ? usagePayload : { model, ...usagePayload }
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info
    }
  }
}

function sessionMeta(id: string) {
  return { type: 'session_meta', id }
}

function turnContext(model: string) {
  return { type: 'turn_context', payload: { model } }
}

async function writeJsonl(filePath: string, rows: unknown[]) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}
