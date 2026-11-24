import { describe, expect, test, vi } from 'vitest'
import {
  costUnavailableSources,
  isCostUnavailableSource,
  isValidTimezone,
  maxSnapshotCostUsd,
  maxSnapshotTokens,
  timezoneValidationCacheSize,
  usageSnapshotSchema,
  usageSourceSchema,
  type UsageSnapshot
} from './schema'

const baseSnapshot: UsageSnapshot = {
  source: 'codex',
  usageDate: '2026-05-09',
  timezone: 'Asia/Shanghai',
  model: 'gpt-5',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 5,
  totalTokens: 17,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: '2026-05-09T10:00:00.000Z'
}

describe('usage snapshot schema', () => {
  test('accepts Antigravity sources', () => {
    for (const source of ['antigravity-cli', 'antigravity', 'antigravity-ide'] as const) {
      expect(usageSourceSchema.parse(source)).toBe(source)
      expect(
        usageSnapshotSchema.parse({
          ...baseSnapshot,
          source,
          costUsd: 0
        }).source
      ).toBe(source)
    }
  })

  test('rejects Antigravity source costs', () => {
    for (const source of ['antigravity-cli', 'antigravity', 'antigravity-ide'] as const) {
      expect(() =>
        usageSnapshotSchema.parse({
          ...baseSnapshot,
          source,
          costUsd: 0.01
        })
      ).toThrow('Antigravity source costs are unavailable')
    }
  })

  test('accepts the sources that report cost', () => {
    for (const source of ['opencode', 'pi'] as const) {
      expect(usageSourceSchema.parse(source)).toBe(source)
      expect(usageSnapshotSchema.parse({ ...baseSnapshot, source }).costUsd).toBe(0.01)
    }
  })

  // The ccusage-backed tool sources price usage locally the same way Claude Code and
  // Codex do, so their snapshots carry a real costUsd and are never cost-unavailable.
  test('accepts the ccusage tool sources with cost', () => {
    for (const source of [
      'amp',
      'droid',
      'codebuff',
      'hermes',
      'goose',
      'kilo',
      'copilot',
      'gemini-cli',
      'kimi',
      'qwen',
      'openclaw',
      'zcode'
    ] as const) {
      expect(usageSourceSchema.parse(source)).toBe(source)
      expect(usageSnapshotSchema.parse({ ...baseSnapshot, source }).costUsd).toBe(0.01)
      expect(isCostUnavailableSource(source)).toBe(false)
    }
  })

  // Cost is the only snapshot field the aggregation layer sums across rows. An unbounded
  // value makes that sum overflow to Infinity, which persists into the summary tables and
  // then serialises to `null` in the public JSON — where readers treat it as zero.
  test('bounds cost so the aggregate sum cannot overflow to Infinity', () => {
    expect(usageSnapshotSchema.parse({ ...baseSnapshot, costUsd: maxSnapshotCostUsd }).costUsd).toBe(maxSnapshotCostUsd)
    expect(() => usageSnapshotSchema.parse({ ...baseSnapshot, costUsd: maxSnapshotCostUsd + 1 })).toThrow()
    expect(() => usageSnapshotSchema.parse({ ...baseSnapshot, costUsd: Number.MAX_VALUE })).toThrow()
  })

  // The token fields are summed by the aggregation layer exactly like cost is, and they were
  // the fields left unbounded. `SUM()` over int64 raises `integer overflow` and aborts the
  // whole statement — which, in the leaderboard query, takes down the endpoint for every
  // tenant, not just the one whose rows overflowed.
  test('bounds token counts so an aggregate sum cannot overflow int64', () => {
    // `cacheReadTokens` may not exceed `totalTokens`, so the pair moves together; the other
    // four are independent.
    for (const field of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'sessionCount'] as const) {
      expect(usageSnapshotSchema.parse({ ...baseSnapshot, [field]: maxSnapshotTokens })[field]).toBe(maxSnapshotTokens)
      expect(() => usageSnapshotSchema.parse({ ...baseSnapshot, [field]: maxSnapshotTokens + 1 })).toThrow()
      expect(() => usageSnapshotSchema.parse({ ...baseSnapshot, [field]: Number.MAX_SAFE_INTEGER })).toThrow()
    }

    const capped = { totalTokens: maxSnapshotTokens, cacheReadTokens: maxSnapshotTokens }
    expect(usageSnapshotSchema.parse({ ...baseSnapshot, ...capped }).totalTokens).toBe(maxSnapshotTokens)
    for (const field of ['totalTokens', 'cacheReadTokens'] as const) {
      expect(() => usageSnapshotSchema.parse({ ...baseSnapshot, ...capped, [field]: maxSnapshotTokens + 1 })).toThrow()
      expect(() => usageSnapshotSchema.parse({ ...baseSnapshot, [field]: Number.MAX_SAFE_INTEGER })).toThrow()
    }
  })

  // `cacheReadTokens <= totalTokens` is the schema's only cross-field token invariant, and it
  // had no rejection case: a cache-read count exceeding the total would inflate the
  // cache-read-rate metric past 100% in every reporting surface.
  test('rejects cache reads that exceed the snapshot total', () => {
    expect(() => usageSnapshotSchema.parse({ ...baseSnapshot, cacheReadTokens: baseSnapshot.totalTokens + 1 })).toThrow(
      'cacheReadTokens must not exceed totalTokens'
    )
  })

  // The schema deliberately does *not* enforce `totalTokens === input + output + cacheWrite +
  // cacheRead`: codex legacy rows report a total that predates the cache-read split, so the
  // four components legitimately sum past it (see `resolveCodexRawUsage`). This pins that
  // acceptance so a future "tidy-up" tightening the invariant fails here, not in production.
  test('accepts a total that does not equal the four components summed', () => {
    const legacyCodexRow = {
      ...baseSnapshot,
      inputTokens: 100,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 41,
      totalTokens: 101
    }

    expect(usageSnapshotSchema.parse(legacyCodexRow).totalTokens).toBe(101)
  })

  test('rejects costs from sources that cannot report one', () => {
    expect(() => usageSnapshotSchema.parse({ ...baseSnapshot, source: 'grok-build', costUsd: 0.01 })).toThrow(
      'Grok Build source costs are unavailable'
    )
    expect(() => usageSnapshotSchema.parse({ ...baseSnapshot, source: 'deepseek-harness', costUsd: 0.01 })).toThrow(
      'DeepSeek Harness source costs are unavailable'
    )

    for (const source of ['grok-build', 'deepseek-harness'] as const) {
      expect(usageSnapshotSchema.parse({ ...baseSnapshot, source, costUsd: 0 }).source).toBe(source)
    }
  })

  test('reports which sources cannot carry a cost', () => {
    for (const source of costUnavailableSources) {
      expect(isCostUnavailableSource(source)).toBe(true)
    }
    for (const source of ['claude-code', 'codex', 'opencode', 'pi'] as const) {
      expect(isCostUnavailableSource(source)).toBe(false)
    }
  })

  test('rejects unknown sources', () => {
    expect(() => usageSourceSchema.parse('agy')).toThrow()
  })

  test('rejects invalid IANA timezones', () => {
    expect(() =>
      usageSnapshotSchema.parse({
        ...baseSnapshot,
        timezone: 'Mars/Base'
      })
    ).toThrow()
  })

  test.each(['2026-02-30', '2023-02-29', '2026-13-01'])('rejects impossible usage dates: %s', (usageDate) => {
    expect(() => usageSnapshotSchema.parse({ ...baseSnapshot, usageDate })).toThrow('Invalid ISO date')
  })

  test('accepts leap-day usage dates', () => {
    expect(usageSnapshotSchema.parse({ ...baseSnapshot, usageDate: '2024-02-29' }).usageDate).toBe('2024-02-29')
  })

  test('does not retain attacker-controlled invalid timezone keys', () => {
    const formatter = Intl.DateTimeFormat
    const constructor = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args) {
      return new formatter(...args)
    })

    expect(isValidTimezone('Invalid/NegativeCacheProbe')).toBe(false)
    expect(isValidTimezone('Invalid/NegativeCacheProbe')).toBe(false)
    expect(constructor).toHaveBeenCalledTimes(2)

    constructor.mockRestore()
  })

  test('caches case-insensitive and canonical timezone aliases after validation', () => {
    const before = timezoneValidationCacheSize()
    const formatter = Intl.DateTimeFormat
    const constructor = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args) {
      return new formatter(...args)
    })

    expect(isValidTimezone('US/Eastern')).toBe(true)
    expect(isValidTimezone('us/eastern')).toBe(true)
    expect(isValidTimezone('US/EASTERN')).toBe(true)
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(constructor).toHaveBeenCalledTimes(1)
    expect(timezoneValidationCacheSize() - before).toBe(2)

    constructor.mockRestore()
  })

  test('rejects oversized timezone and model fields', () => {
    expect(() =>
      usageSnapshotSchema.parse({
        ...baseSnapshot,
        timezone: 'A'.repeat(81)
      })
    ).toThrow()

    expect(() =>
      usageSnapshotSchema.parse({
        ...baseSnapshot,
        model: 'g'.repeat(161)
      })
    ).toThrow()
  })

  test('retains the Codex context-pricing correction marker', () => {
    expect(
      usageSnapshotSchema.parse({
        ...baseSnapshot,
        correction: 'codex-context-pricing'
      }).correction
    ).toBe('codex-context-pricing')
  })
})
