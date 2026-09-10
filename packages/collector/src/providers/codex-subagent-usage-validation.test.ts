import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import { readChildLastUsageByDate } from './codex-subagent-usage-child'
import { createEmptyCodexHome, writeJsonl } from './codex-test-helpers'
import { subagentSessionMeta, totalUsageEvent } from './codex-subagent-usage-test-helpers'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Codex subagent usage validation', () => {
  test('retains a high-cache child event with additive counters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-subagent-validation-'))
    const filePath = join(root, 'child.jsonl')
    const diagnostics: string[] = []

    try {
      await writeJsonl(filePath, [
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 50,
          cacheReadTokens: 150,
          outputTokens: 20,
          totalTokens: 220
        })
      ])

      await expect(
        readChildLastUsageByDate(filePath, '2026-05-25T00:00:00.000Z', 'Asia/Shanghai', (line) =>
          diagnostics.push(line)
        )
      ).resolves.toEqual([
        expect.objectContaining({
          usageDate: '2026-05-25',
          inputTokens: 50,
          cacheReadTokens: 150,
          outputTokens: 20,
          totalTokens: 220
        })
      ])
      expect(diagnostics).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('applies a high-cache child correction instead of retaining the inflated aggregate', async () => {
    const codexHome = await createEmptyCodexHome()
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child.jsonl')
    const diagnostics: string[] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(childFile, [
        subagentSessionMeta('child', 'parent', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 50,
          cacheReadTokens: 150,
          outputTokens: 20,
          totalTokens: 220
        })
      ])

      await expect(
        collectCodexUsage({
          codexHome,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-25T01:20:00.000Z',
          stderr: (line) => diagnostics.push(line),
          async runner(_command, args) {
            return args.includes('session') ? childSessionResult() : childDailyResult()
          }
        })
      ).resolves.toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-25',
          model: 'gpt-5',
          inputTokens: 50,
          outputTokens: 20,
          cacheReadTokens: 150,
          totalTokens: 220,
          sessionCount: 1
        })
      ])
      expect(diagnostics).toEqual([])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('preserves additive input when cache read is smaller than input', async () => {
    const codexHome = await createEmptyCodexHome()
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child.jsonl')
    const diagnostics: string[] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(childFile, [
        subagentSessionMeta('child', 'parent', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 200,
          cacheReadTokens: 150,
          outputTokens: 20,
          totalTokens: 370
        })
      ])

      await expect(
        collectCodexUsage({
          codexHome,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-25T01:20:00.000Z',
          stderr: (line) => diagnostics.push(line),
          async runner(_command, args) {
            return args.includes('session') ? childSessionResult() : childDailyResult()
          }
        })
      ).resolves.toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-25',
          model: 'gpt-5',
          inputTokens: 200,
          outputTokens: 20,
          cacheReadTokens: 150,
          totalTokens: 370,
          sessionCount: 1
        })
      ])
      expect(diagnostics).toEqual([])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

function childDailyResult() {
  return {
    daily: [
      {
        date: '2026-05-25',
        models: {
          'gpt-5': {
            inputTokens: 1100,
            cachedInputTokens: 1950,
            outputTokens: 120,
            totalTokens: 3170
          }
        },
        totalTokens: 3170,
        costUSD: 3.17
      }
    ]
  }
}

function childSessionResult() {
  return {
    sessions: [
      {
        sessionId: '2026/05/25/rollout-child',
        lastActivity: '2026-05-25T01:10:00.000Z',
        totalTokens: 3170,
        costUSD: 3.17,
        models: {
          'gpt-5': {
            inputTokens: 1100,
            cachedInputTokens: 1950,
            outputTokens: 120,
            totalTokens: 3170,
            costUSD: 3.17
          }
        }
      }
    ]
  }
}
