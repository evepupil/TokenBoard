import { describe, expect, test, vi } from 'vitest'
import {
  costUnavailableSources,
  isCostUnavailableSource,
  isValidTimezone,
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
