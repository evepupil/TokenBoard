import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotHashPayload, type UsageSnapshot } from '@tokenboard/usage-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import { projectCodexDailyCosts } from './codex-cost-projection'
import { createEmptyCodexHome, fileExists, tokenCountEvent, writeJsonl } from './codex-test-helpers'

const scopedCollectionTestTimeoutMs = 30_000

describe('Codex daily cost projection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('uses fixed decimal precision when allocating a daily total across models', () => {
    const projected = projectCodexDailyCosts([
      snapshot({ model: 'gpt-b', totalTokens: 1, costUsd: 0.16666666666666666 }),
      snapshot({ model: 'gpt-a', totalTokens: 2, costUsd: 0.8333333333333334 })
    ])

    expect(projected).toEqual([
      expect.objectContaining({ model: 'gpt-b', costUsd: 0.333333 }),
      expect.objectContaining({ model: 'gpt-a', costUsd: 0.666667 })
    ])
    expect(projected.reduce((total, value) => total + value.costUsd, 0)).toBe(1)
  })

  test('rounds only after accumulating the complete daily cost', () => {
    const projected = projectCodexDailyCosts([
      snapshot({ model: 'gpt-b', totalTokens: 1, costUsd: 0.0000004 }),
      snapshot({ model: 'gpt-a', totalTokens: 1, costUsd: 0.0000004 })
    ])

    expect(projected).toEqual([
      expect.objectContaining({ model: 'gpt-b', costUsd: 0 }),
      expect.objectContaining({ model: 'gpt-a', costUsd: 0.000001 })
    ])
  })

  test(
    'keeps shared historical snapshot costs and hashes stable across since-driven batch boundaries',
    async () => {
      const codexHome = await createEmptyCodexHome()
      const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-cost-projection-state-'))
      const commandArgs: string[][] = []
      vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
      vi.stubEnv('TOKENBOARD_CODEX_BATCH_SIZE', '2')

      try {
        await Promise.all([
          writeJsonl(join(codexHome, 'sessions', '2026', '07', '01', 'legacy.jsonl'), [
            tokenCountEvent('2026-07-01T01:00:00.000Z', 10)
          ]),
          writeJsonl(join(codexHome, 'sessions', '2026', '07', '08', 'first.jsonl'), [
            tokenCountEvent('2026-07-08T01:00:00.000Z', 100)
          ]),
          writeJsonl(join(codexHome, 'sessions', '2026', '07', '08', 'second.jsonl'), [
            tokenCountEvent('2026-07-08T02:00:00.000Z', 100)
          ])
        ])

        const runner = createBatchSensitiveRunner(commandArgs)
        const broad = await collectCodexUsage({
          codexHome,
          since: '20260701',
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-07-28T00:00:00.000Z',
          stateDir,
          runner
        })
        const narrow = await collectCodexUsage({
          codexHome,
          since: '20260708',
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-07-28T00:00:00.000Z',
          stateDir,
          runner
        })
        const targetDay = (snapshots: UsageSnapshot[]) =>
          snapshots.filter((snapshot) => snapshot.usageDate === '2026-07-08')

        expect(targetDay(broad)).toEqual([
          expect.objectContaining({ model: 'gpt-a', totalTokens: 100, sessionCount: 1, costUsd: 6 }),
          expect.objectContaining({ model: 'gpt-b', totalTokens: 100, sessionCount: 1, costUsd: 6 })
        ])
        expect(targetDay(narrow)).toEqual(targetDay(broad))
        expect(targetDay(narrow).map(snapshotHashPayload)).toEqual(targetDay(broad).map(snapshotHashPayload))
        expect(commandArgs).not.toHaveLength(0)
        expect(commandArgs.every((args) => args.includes('--offline'))).toBe(true)
        expect(await fileExists(join(stateDir, 'codex-session-attribution-cache.json'))).toBe(true)
      } finally {
        await rm(codexHome, { recursive: true, force: true })
        await rm(stateDir, { recursive: true, force: true })
      }
    },
    scopedCollectionTestTimeoutMs
  )
})

function snapshot(input: Pick<UsageSnapshot, 'model' | 'totalTokens' | 'costUsd'>): UsageSnapshot {
  return {
    source: 'codex',
    usageDate: '2026-07-08',
    timezone: 'Asia/Shanghai',
    model: input.model,
    inputTokens: input.totalTokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: input.totalTokens,
    costUsd: input.costUsd,
    sessionCount: 1,
    collectedAt: '2026-07-28T00:00:00.000Z'
  }
}

function createBatchSensitiveRunner(commandArgs: string[][]) {
  return async (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    commandArgs.push(args)
    const scopedHome = String(options?.env?.CODEX_HOME)
    const batch = await batchFiles(scopedHome)
    if (args.includes('daily')) return dailyResult(batch)
    return sessionResult(batch)
  }
}

async function batchFiles(codexHome: string) {
  return {
    legacy: await fileExists(join(codexHome, 'sessions', '2026', '07', '01', 'legacy.jsonl')),
    first: await fileExists(join(codexHome, 'sessions', '2026', '07', '08', 'first.jsonl')),
    second: await fileExists(join(codexHome, 'sessions', '2026', '07', '08', 'second.jsonl'))
  }
}

function dailyResult(batch: { legacy: boolean; first: boolean; second: boolean }) {
  const data: unknown[] = []
  if (batch.legacy) data.push(dailyRow('2026-07-01', { 'gpt-legacy': 10 }, 1))
  if (batch.first && batch.second) {
    data.push(dailyRow('2026-07-08', { 'gpt-a': 100, 'gpt-b': 100 }, 12))
  } else if (batch.first) {
    data.push(dailyRow('2026-07-08', { 'gpt-a': 100 }, 2))
  } else if (batch.second) {
    data.push(dailyRow('2026-07-08', { 'gpt-b': 100 }, 10))
  }
  return { data }
}

function dailyRow(date: string, models: Record<string, number>, costUSD: number) {
  return {
    date,
    costUSD,
    totalTokens: Object.values(models).reduce((total, value) => total + value, 0),
    models: Object.fromEntries(
      Object.entries(models).map(([model, totalTokens]) => [model, { inputTokens: totalTokens, totalTokens }])
    )
  }
}

function sessionResult(batch: { legacy: boolean; first: boolean; second: boolean }) {
  const sessions: unknown[] = []
  if (batch.legacy)
    sessions.push(sessionRow('2026/07/01', 'legacy.jsonl', '2026-07-01T01:00:00.000Z', 'gpt-legacy', 10))
  if (batch.first) sessions.push(sessionRow('2026/07/08', 'first.jsonl', '2026-07-08T01:00:00.000Z', 'gpt-a', 100))
  if (batch.second) sessions.push(sessionRow('2026/07/08', 'second.jsonl', '2026-07-08T02:00:00.000Z', 'gpt-b', 100))
  return { sessions }
}

function sessionRow(directory: string, sessionFile: string, lastActivity: string, model: string, totalTokens: number) {
  return {
    directory,
    sessionFile,
    lastActivity,
    models: { [model]: { inputTokens: totalTokens, totalTokens } }
  }
}
