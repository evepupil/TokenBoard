import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { applyCodexSubagentUsageCorrections } from './codex-subagent-usage'
import { createEmptyCodexHome, writeJsonl } from './codex-test-helpers'
import { subagentSessionMeta } from './codex-subagent-usage-test-helpers'

describe('Codex subagent usage correction concurrency', () => {
  test('runs independent child reads up to the configured concurrency limit', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-concurrency-'))
    const names = ['child-a', 'child-b', 'child-c']
    let activeReads = 0
    let maxActiveReads = 0
    let releaseConcurrentReads: (() => void) | undefined
    let rejectConcurrentReads: ((error: Error) => void) | undefined
    const concurrentReadsStarted = new Promise<void>((resolve, reject) => {
      releaseConcurrentReads = resolve
      rejectConcurrentReads = reject
    })
    let concurrentReadTimeout: ReturnType<typeof setTimeout> | undefined

    try {
      await Promise.all(
        names.map((name) =>
          writeJsonl(join(codexHome, 'sessions', '2026', '07', '25', `${name}.jsonl`), [
            subagentSessionMeta(name, 'parent', '2026-07-25T01:00:00.000Z')
          ])
        )
      )

      await applyCodexSubagentUsageCorrections({
        snapshots: [
          {
            source: 'codex',
            usageDate: '2026-07-25',
            timezone: 'UTC',
            model: 'gpt-5.6',
            inputTokens: 300,
            outputTokens: 30,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 330,
            costUsd: 0,
            sessionCount: 3,
            collectedAt: '2026-07-25T02:00:00.000Z'
          }
        ],
        sessions: {
          sessions: names.map((name) => ({
            directory: '2026/07/25',
            sessionFile: name,
            lastActivity: '2026-07-25T01:30:00.000Z',
            models: {
              'gpt-5.6': {
                inputTokens: 100,
                outputTokens: 10,
                totalTokens: 110,
                costUSD: 0
              }
            }
          }))
        },
        codexHomes: [codexHome],
        stateDir,
        timezone: 'UTC',
        maxConcurrentChildReads: 2,
        readChildUsageByDate: async () => {
          activeReads += 1
          maxActiveReads = Math.max(maxActiveReads, activeReads)
          concurrentReadTimeout ??= setTimeout(() => {
            rejectConcurrentReads?.(new Error('Codex child reads did not reach the configured concurrency'))
          }, 5_000)
          if (activeReads === 2) releaseConcurrentReads?.()
          await concurrentReadsStarted
          activeReads -= 1
          return []
        }
      })

      expect(maxActiveReads).toBe(2)
    } finally {
      if (concurrentReadTimeout) clearTimeout(concurrentReadTimeout)
      await Promise.all([
        rm(codexHome, { recursive: true, force: true }),
        rm(stateDir, { recursive: true, force: true })
      ])
    }
  })
})
