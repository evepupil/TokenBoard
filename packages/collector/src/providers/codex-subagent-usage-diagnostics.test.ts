import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { applyCodexSubagentUsageCorrections } from './codex-subagent-usage'
import { maxCodexChildSessionLineBytes } from './codex-subagent-usage-child'
import { createEmptyCodexHome, writeJsonl } from './codex-test-helpers'
import { subagentSessionMeta, totalUsageEvent } from './codex-subagent-usage-test-helpers'

describe('Codex subagent usage diagnostics', () => {
  test('coalesces repeated safe oversized-row warnings without changing corrections', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-diagnostics-'))
    const warnings: string[] = []
    const childNames = ['child-a', 'child-b']
    const oversized = JSON.stringify({
      type: 'compacted',
      payload: { summary: 'x'.repeat(maxCodexChildSessionLineBytes + 1) }
    })

    try {
      await Promise.all(
        childNames.map(async (name) => {
          const filePath = join(codexHome, 'sessions', '2026', '05', '25', `${name}.jsonl`)
          await writeJsonl(filePath, [
            subagentSessionMeta(name, 'parent-thread', '2026-05-25T01:00:00.000Z'),
            totalUsageEvent('2026-05-25T01:10:00.000Z', {
              inputTokens: 100,
              cacheReadTokens: 0,
              outputTokens: 10,
              totalTokens: 110
            })
          ])
          await appendFile(filePath, `${oversized}\n`)
        })
      )

      const corrected = await applyCodexSubagentUsageCorrections({
        snapshots: [
          {
            source: 'codex',
            usageDate: '2026-05-25',
            timezone: 'UTC',
            model: 'gpt-5',
            inputTokens: 400,
            outputTokens: 40,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 440,
            costUsd: 0,
            sessionCount: 2,
            collectedAt: '2026-05-25T02:00:00.000Z'
          }
        ],
        sessions: {
          sessions: childNames.map((name) => ({
            directory: '2026/05/25',
            sessionFile: name,
            lastActivity: '2026-05-25T01:30:00.000Z',
            models: {
              'gpt-5': {
                inputTokens: 200,
                cachedInputTokens: 0,
                outputTokens: 20,
                totalTokens: 220,
                costUSD: 0
              }
            }
          }))
        },
        codexHomes: [codexHome],
        stateDir,
        timezone: 'UTC',
        maxConcurrentChildReads: 2,
        stderr: (line) => warnings.push(line)
      })

      expect(corrected).toEqual([
        expect.objectContaining({
          inputTokens: 200,
          outputTokens: 20,
          totalTokens: 220
        })
      ])
      expect(warnings).toEqual([
        `Skipped 2 oversized Codex child session JSONL rows without usage or subagent metadata across 2 scans (largest ${Buffer.byteLength(oversized)} bytes)`
      ])
    } finally {
      await Promise.all([
        rm(codexHome, { recursive: true, force: true }),
        rm(stateDir, { recursive: true, force: true })
      ])
    }
  })
})
