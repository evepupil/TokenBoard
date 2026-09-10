import { access, appendFile, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { collectCodexUsage } from './codex'
import { applyCodexSubagentUsageCorrections } from './codex-subagent-usage'
import { createEmptyCodexHome, writeJsonl } from './codex-test-helpers'
import {
  inheritedDailyResult,
  inheritedMultiModelDailyResult,
  inheritedMultiModelSessionResult,
  inheritedSessionResult,
  independentSubagentDailyResult,
  independentSubagentSessionResult,
  sessionMeta,
  skewedMultiModelDailyResult,
  skewedMultiModelSessionResult,
  subagentSessionMeta,
  totalUsageEvent
} from './codex-subagent-usage-test-helpers'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Codex subagent usage correction', () => {
  test('finds valid subagent metadata after an incomplete session metadata row', async () => {
    const codexHome = await createEmptyCodexHome()
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')

    try {
      await writeJsonl(childFile, [
        {
          type: 'session_meta',
          timestamp: '2026-05-25T00:59:00.000Z',
          payload: { id: 'incomplete-child', timestamp: '2026-05-25T00:59:00.000Z' }
        },
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? inheritedSessionResult() : inheritedDailyResult()
        }
      })

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220,
        sessionCount: 1
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('corrects a child session when subagent metadata omits the parent thread id', async () => {
    const codexHome = await createEmptyCodexHome()
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')

    try {
      await writeJsonl(childFile, [
        {
          type: 'session_meta',
          timestamp: '2026-05-25T01:00:00.000Z',
          payload: {
            id: 'child-thread',
            timestamp: '2026-05-25T01:00:00.000Z',
            source: { subagent: { kind: 'worker' } }
          }
        },
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? inheritedSessionResult() : inheritedDailyResult()
        }
      })

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220,
        sessionCount: 1
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('corrects a child session stored in a later configured Codex home', async () => {
    const firstHome = await createEmptyCodexHome()
    const secondHome = await createEmptyCodexHome()
    const childFile = join(secondHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')

    try {
      await writeInheritedChildSession(childFile)

      const snapshots = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? inheritedSessionResult() : inheritedDailyResult()
        }
      })

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220,
        sessionCount: 1
      })
    } finally {
      await rm(firstHome, { recursive: true, force: true })
      await rm(secondHome, { recursive: true, force: true })
    }
  })

  test('corrects a later-profile child session during a full Codex history scan', async () => {
    const firstHome = await createEmptyCodexHome()
    const secondHome = await createEmptyCodexHome()
    const childFile = join(secondHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')

    try {
      await writeInheritedChildSession(childFile)

      const snapshots = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        since: 'all',
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? inheritedSessionResult() : inheritedDailyResult()
        }
      })

      expect(snapshots).toMatchObject([
        {
          inputTokens: 50,
          outputTokens: 20,
          cacheReadTokens: 150,
          totalTokens: 220,
          sessionCount: 1
        }
      ])
    } finally {
      await Promise.all([
        rm(firstHome, { recursive: true, force: true }),
        rm(secondHome, { recursive: true, force: true })
      ])
    }
  })

  test('deduplicates repeated child events while retaining distinct events across matching Codex homes', async () => {
    const firstHome = await createEmptyCodexHome()
    const secondHome = await createEmptyCodexHome()
    const firstChild = join(firstHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')
    const secondChild = join(secondHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')

    try {
      const firstEvent = totalUsageEvent(
        '2026-05-25T01:10:00.000Z',
        {
          inputTokens: 1200,
          cacheReadTokens: 1050,
          outputTokens: 70
        },
        {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        }
      )
      await writeJsonl(firstChild, [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        firstEvent
      ])
      await writeJsonl(secondChild, [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        firstEvent,
        totalUsageEvent(
          '2026-05-25T01:20:00.000Z',
          {
            inputTokens: 1600,
            cacheReadTokens: 1350,
            outputTokens: 110
          },
          {
            lastUsage: {
              inputTokens: 400,
              cacheReadTokens: 300,
              outputTokens: 40
            }
          }
        )
      ])

      const snapshots = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:30:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? mergedProfileSessionResult() : mergedProfileDailyResult()
        }
      })

      expect(snapshots).toMatchObject([
        {
          inputTokens: 150,
          outputTokens: 60,
          cacheReadTokens: 450,
          totalTokens: 660,
          sessionCount: 1
        }
      ])
      expect(snapshots[0].costUsd).toBeCloseTo(0.66)
    } finally {
      await rm(firstHome, { recursive: true, force: true })
      await rm(secondHome, { recursive: true, force: true })
    }
  })

  test('does not persist cross-profile child event identities in the local cache', async () => {
    const firstHome = await createEmptyCodexHome()
    const secondHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-events-'))
    const firstChild = join(firstHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')
    const secondChild = join(secondHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')
    let eventReads = 0
    let activeEventReads = 0
    let maxConcurrentEventReads = 0
    const firstEvent = {
      eventKey: 'first-event',
      usageDate: '2026-05-25',
      inputTokens: 200,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 150,
      totalTokens: 220
    }
    const secondEvent = {
      eventKey: 'second-event',
      usageDate: '2026-05-25',
      inputTokens: 400,
      outputTokens: 40,
      cacheCreationTokens: 0,
      cacheReadTokens: 300,
      totalTokens: 440
    }
    const input = {
      snapshots: [
        {
          ...codexSnapshot(),
          inputTokens: 2200,
          outputTokens: 240,
          cacheReadTokens: 3900,
          totalTokens: 6340,
          costUsd: 6.34
        }
      ],
      sessions: mergedProfileSessionResult(),
      codexHomes: [firstHome, secondHome],
      stateDir,
      timezone: 'Asia/Shanghai',
      readChildUsageByDate: async () => {
        throw new Error('Multi-profile correction must use event-level reads')
      },
      readChildUsageEvents: async (filePath: string) => {
        eventReads += 1
        activeEventReads += 1
        maxConcurrentEventReads = Math.max(maxConcurrentEventReads, activeEventReads)
        await Promise.resolve()
        activeEventReads -= 1
        return filePath === firstChild ? [firstEvent] : [firstEvent, secondEvent]
      }
    }

    try {
      await Promise.all([
        writeJsonl(firstChild, [subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z')]),
        writeJsonl(secondChild, [subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z')])
      ])

      const first = await applyCodexSubagentUsageCorrections(input)
      const second = await applyCodexSubagentUsageCorrections({
        ...input,
        snapshots: [...input.snapshots]
      })

      expect(eventReads).toBe(4)
      expect(maxConcurrentEventReads).toBe(1)
      expect(second).toEqual(first)
      expect(second).toMatchObject([
        {
          inputTokens: 150,
          outputTokens: 60,
          cacheReadTokens: 450,
          totalTokens: 660
        }
      ])
      const cache = await readFile(join(stateDir, 'codex-subagent-usage-cache.json'), 'utf8')
      expect(cache).not.toContain('eventKey')
    } finally {
      await Promise.all([
        rm(firstHome, { recursive: true, force: true }),
        rm(secondHome, { recursive: true, force: true }),
        rm(stateDir, { recursive: true, force: true })
      ])
    }
  })

  test('finds valid subagent metadata after a row without its parent thread id', async () => {
    const codexHome = await createEmptyCodexHome()
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')

    try {
      await writeJsonl(childFile, [
        {
          type: 'session_meta',
          timestamp: '2026-05-25T01:00:00.000Z',
          payload: {
            id: 'incomplete-child',
            timestamp: '2026-05-25T01:00:00.000Z',
            source: { subagent: { thread_spawn: {} } }
          }
        },
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? inheritedSessionResult() : inheritedDailyResult()
        }
      })

      expect(snapshots[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('preserves cache creation tokens while correcting child usage', async () => {
    const codexHome = await createEmptyCodexHome()
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')

    try {
      await writeJsonl(childFile, [subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z')])
      const corrected = await applyCodexSubagentUsageCorrections({
        snapshots: [{ ...codexSnapshot(), cacheCreationTokens: 100, totalTokens: 3270, costUsd: 3.27 }],
        sessions: {
          sessions: [
            {
              sessionId: '2026/05/25/rollout-child-thread',
              lastActivity: '2026-05-25T01:10:00.000Z',
              totalTokens: 3270,
              costUSD: 3.27,
              models: {
                'gpt-5': {
                  inputTokens: 1100,
                  cacheCreationInputTokens: 100,
                  cachedInputTokens: 1950,
                  outputTokens: 120,
                  totalTokens: 3270,
                  costUSD: 3.27
                }
              }
            }
          ]
        },
        codexHomes: [codexHome],
        timezone: 'Asia/Shanghai',
        readChildUsageByDate: async () => [
          {
            usageDate: '2026-05-25',
            inputTokens: 200,
            outputTokens: 20,
            cacheCreationTokens: 30,
            cacheReadTokens: 150,
            totalTokens: 250
          }
        ]
      })

      expect(corrected).toMatchObject([
        {
          inputTokens: 50,
          outputTokens: 20,
          cacheCreationTokens: 30,
          cacheReadTokens: 150,
          totalTokens: 250
        }
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('skips child usage reads for sessions before the earliest snapshot date', async () => {
    const codexHome = await createEmptyCodexHome()
    const oldChildFile = join(codexHome, 'sessions', '2026', '04', '01', 'rollout-old-child-thread.jsonl')
    const currentChildFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')
    const reads: string[] = []

    try {
      await writeInheritedChildSession(oldChildFile)
      await writeInheritedChildSession(currentChildFile)
      const sessions = inheritedSessionResult()
      sessions.sessions.unshift({
        ...sessions.sessions[0],
        sessionId: '2026/04/01/rollout-old-child-thread',
        lastActivity: '2026-04-01T01:10:00.000Z'
      })

      const corrected = await applyCodexSubagentUsageCorrections({
        snapshots: [codexSnapshot()],
        sessions,
        codexHomes: [codexHome],
        timezone: 'Asia/Shanghai',
        readChildUsageByDate: async (filePath) => {
          reads.push(filePath)
          return [
            {
              usageDate: '2026-05-25',
              inputTokens: 200,
              outputTokens: 20,
              cacheCreationTokens: 0,
              cacheReadTokens: 150,
              totalTokens: 220
            }
          ]
        }
      })

      expect(reads).toEqual([await realpath(currentChildFile)])
      expect(corrected).toMatchObject([
        {
          inputTokens: 50,
          outputTokens: 20,
          cacheReadTokens: 150,
          totalTokens: 220
        }
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('keeps a timezone-boundary child session inside the snapshot window', async () => {
    const codexHome = await createEmptyCodexHome()
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')
    let reads = 0

    try {
      await writeInheritedChildSession(childFile)
      const sessions = inheritedSessionResult()
      sessions.sessions[0].lastActivity = '2026-05-25T16:00:00.000Z'

      await applyCodexSubagentUsageCorrections({
        snapshots: [{ ...codexSnapshot(), usageDate: '2026-05-26' }],
        sessions,
        codexHomes: [codexHome],
        timezone: 'Asia/Shanghai',
        readChildUsageByDate: async () => {
          reads += 1
          return []
        }
      })

      expect(reads).toBe(1)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('retains child cache creation tokens in collected Codex snapshots', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-creation-'))
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')

    try {
      await writeJsonl(childFile, [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        {
          type: 'event_msg',
          timestamp: '2026-05-25T01:10:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              total_token_usage: {
                input_tokens: 1200,
                cache_creation_input_tokens: 100,
                cached_input_tokens: 1050,
                output_tokens: 70,
                total_tokens: 1370
              },
              last_token_usage: {
                input_tokens: 200,
                cache_creation_input_tokens: 30,
                cached_input_tokens: 150,
                output_tokens: 20,
                total_tokens: 250
              }
            }
          }
        }
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session')
            ? {
                sessions: [
                  {
                    sessionId: '2026/05/25/rollout-child-thread',
                    lastActivity: '2026-05-25T01:10:00.000Z',
                    totalTokens: 3270,
                    costUSD: 3.27,
                    models: {
                      'gpt-5': {
                        inputTokens: 1100,
                        cacheCreationInputTokens: 100,
                        cachedInputTokens: 1950,
                        outputTokens: 120,
                        totalTokens: 3270,
                        costUSD: 3.27
                      }
                    }
                  }
                ]
              }
            : {
                daily: [
                  {
                    date: '2026-05-25',
                    models: {
                      'gpt-5': {
                        inputTokens: 1100,
                        cacheCreationInputTokens: 100,
                        cachedInputTokens: 1950,
                        outputTokens: 120,
                        totalTokens: 3270
                      }
                    },
                    totalTokens: 3270,
                    costUSD: 3.27
                  }
                ]
              }
        }
      })

      expect(snapshots).toMatchObject([
        {
          inputTokens: 50,
          outputTokens: 20,
          cacheCreationTokens: 30,
          cacheReadTokens: 150,
          totalTokens: 250,
          costUsd: 0.25
        }
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('does not persist a cache entry after its lock ownership changes', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-lock-'))
    const cachePath = join(stateDir, 'codex-subagent-usage-cache.json')
    const lockPath = `${cachePath}.lock`
    const input = {
      snapshots: [codexSnapshot()],
      sessions: inheritedSessionResult(),
      codexHomes: [codexHome],
      stateDir,
      timezone: 'Asia/Shanghai',
      readChildUsageByDate: async () => {
        await rm(lockPath, { force: true })
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }), { mode: 0o600 })
        return [
          {
            usageDate: '2026-05-25',
            inputTokens: 200,
            cacheCreationTokens: 0,
            cacheReadTokens: 150,
            outputTokens: 20,
            totalTokens: 220
          }
        ]
      }
    }

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])

      await expect(applyCodexSubagentUsageCorrections(input)).rejects.toThrow('Cursor lock ownership changed')
      await expect(access(cachePath)).rejects.toThrow()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('reuses stable child usage data from the local cache', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-'))
    let reads = 0
    const snapshots = [codexSnapshot()]
    const sessions = inheritedSessionResult()
    const input = {
      snapshots,
      sessions,
      codexHomes: [codexHome],
      stateDir,
      timezone: 'Asia/Shanghai',
      readChildUsageByDate: async () => {
        reads += 1
        return [
          {
            usageDate: '2026-05-25',
            inputTokens: 200,
            cacheCreationTokens: 0,
            cacheReadTokens: 150,
            outputTokens: 20,
            totalTokens: 220
          }
        ]
      }
    }

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])

      const first = await applyCodexSubagentUsageCorrections(input)
      const second = await applyCodexSubagentUsageCorrections({ ...input, snapshots: [codexSnapshot()] })

      expect(reads).toBe(1)
      expect(second).toEqual(first)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('retains stable cached child usage across narrower session windows', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-windows-'))
    let reads = 0
    const baseInput = {
      snapshots: [codexSnapshot()],
      codexHomes: [codexHome],
      stateDir,
      timezone: 'Asia/Shanghai',
      readChildUsageByDate: async () => {
        reads += 1
        return [
          {
            usageDate: '2026-05-25',
            inputTokens: 200,
            cacheCreationTokens: 0,
            cacheReadTokens: 150,
            outputTokens: 20,
            totalTokens: 220
          }
        ]
      }
    }

    try {
      await writeCachedChildSession(codexHome, 'child-a')
      await writeCachedChildSession(codexHome, 'child-b')

      await applyCodexSubagentUsageCorrections({
        ...baseInput,
        sessions: inheritedSessionResultFor('child-a')
      })
      await applyCodexSubagentUsageCorrections({
        ...baseInput,
        snapshots: [codexSnapshot()],
        sessions: inheritedSessionResultFor('child-b')
      })
      await applyCodexSubagentUsageCorrections({
        ...baseInput,
        snapshots: [codexSnapshot()],
        sessions: inheritedSessionResultFor('child-a')
      })

      expect(reads).toBe(2)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('invalidates cached child usage when ctime changes despite stable mtime and tail', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-ctime-'))
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')
    let reads = 0
    const input = {
      snapshots: [codexSnapshot()],
      sessions: inheritedSessionResult(),
      codexHomes: [codexHome],
      stateDir,
      timezone: 'Asia/Shanghai',
      readChildUsageByDate: async () => {
        reads += 1
        return [
          {
            usageDate: '2026-05-25',
            inputTokens: 200,
            cacheCreationTokens: 0,
            cacheReadTokens: 150,
            outputTokens: 20,
            totalTokens: 220
          }
        ]
      }
    }

    try {
      await writeJsonl(childFile, [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])
      await appendFile(childFile, `${JSON.stringify({ padding: 'x'.repeat(70 * 1024) })}\n`)
      const fixedTime = new Date('2026-05-25T01:20:00.000Z')
      await utimes(childFile, fixedTime, fixedTime)
      const before = await stat(childFile)

      await applyCodexSubagentUsageCorrections(input)
      const content = await readFile(childFile, 'utf8')
      await writeFile(childFile, content.replace('child-thread', 'child-renewd'))
      await utimes(childFile, fixedTime, fixedTime)
      const after = await stat(childFile)

      expect(after.size).toBe(before.size)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      await applyCodexSubagentUsageCorrections({ ...input, snapshots: [codexSnapshot()] })
      expect(reads).toBe(2)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('stops reading a normal session after its session metadata', async () => {
    const codexHome = await createEmptyCodexHome()
    const normalFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-parent-thread.jsonl')
    const stderr: string[] = []

    try {
      await writeJsonl(normalFile, [sessionMeta('parent-thread', '2026-05-25T01:00:00.000Z')])
      await appendFile(normalFile, '{malformed-json}\n')

      await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        stderr: (line) => stderr.push(line),
        async runner(_command, args) {
          return args.includes('session')
            ? { sessions: [{ sessionId: '2026/05/25/rollout-parent-thread' }] }
            : { daily: [] }
        }
      })

      expect(stderr).toEqual([])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('keeps charged subagent delta while removing duplicated parent history', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '15', 'rollout-parent-thread.jsonl'), [
        sessionMeta('parent-thread', '2026-05-15T13:00:00.000Z'),
        totalUsageEvent('2026-05-25T00:50:00.000Z', {
          inputTokens: 1000,
          cacheReadTokens: 900,
          outputTokens: 50
        })
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:00:00.000Z',
          {
            inputTokens: 1000,
            cacheReadTokens: 900,
            outputTokens: 50
          },
          { lastUsage: null }
        ),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? inheritedSessionResult() : inheritedDailyResult()
        }
      })

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        source: 'codex',
        usageDate: '2026-05-25',
        model: 'gpt-5',
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220,
        sessionCount: 1
      })
      expect(snapshots[0].costUsd).toBeCloseTo(0.22)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('splits subagent corrections by child usage date', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '26', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T23:50:00.000Z'),
        totalUsageEvent(
          '2026-05-25T23:55:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        ),
        totalUsageEvent(
          '2026-05-26T00:10:00.000Z',
          {
            inputTokens: 1400,
            cacheReadTokens: 1200,
            outputTokens: 90
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'UTC',
        collectedAt: '2026-05-26T00:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? multiDayInheritedSessionResult() : multiDayInheritedDailyResult()
        }
      })

      expect(snapshots).toHaveLength(2)
      expect(snapshots.map((snapshot) => snapshot.usageDate)).toEqual(['2026-05-25', '2026-05-26'])
      for (const snapshot of snapshots) {
        expect(snapshot).toMatchObject({
          model: 'gpt-5',
          inputTokens: 50,
          outputTokens: 20,
          cacheReadTokens: 150,
          totalTokens: 220
        })
        expect(snapshot.costUsd).toBeCloseTo(0.22)
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('buckets subagent corrections by report timezone', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T16:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T16:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T16:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? timezoneBoundarySessionResult() : timezoneBoundaryDailyResult()
        }
      })

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        usageDate: '2026-05-26',
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220
      })
      expect(snapshots[0].costUsd).toBeCloseTo(0.22)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('keeps independent subagent totals when child counters do not include parent history', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '15', 'rollout-parent-thread.jsonl'), [
        sessionMeta('parent-thread', '2026-05-15T13:00:00.000Z'),
        totalUsageEvent('2026-05-25T00:50:00.000Z', {
          inputTokens: 1000,
          cacheReadTokens: 900,
          outputTokens: 50
        })
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 200,
          cacheReadTokens: 150,
          outputTokens: 20
        })
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? independentSubagentSessionResult() : independentSubagentDailyResult()
        }
      })

      expect(snapshots[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220
      })
      expect(snapshots[0].costUsd).toBeCloseTo(0.22)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('does not subtract session-only inflation when daily totals already match child usage', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '15', 'rollout-parent-thread.jsonl'), [
        sessionMeta('parent-thread', '2026-05-15T13:00:00.000Z'),
        totalUsageEvent('2026-05-25T00:50:00.000Z', {
          inputTokens: 1000,
          cacheReadTokens: 900,
          outputTokens: 50
        })
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:00:00.000Z',
          {
            inputTokens: 1000,
            cacheReadTokens: 900,
            outputTokens: 50
          },
          { lastUsage: null }
        ),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? inheritedSessionResult() : independentSubagentDailyResult()
        }
      })

      expect(snapshots[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220
      })
      expect(snapshots[0].costUsd).toBeCloseTo(0.22)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('normalizes display session dates without local timezone drift', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TZ', 'Asia/Shanghai')
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '04', '28', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-04-28T01:00:00.000Z'),
        totalUsageEvent(
          '2026-04-28T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-04-28T01:20:00.000Z',
        async runner(_command, args) {
          if (args.includes('session')) {
            const result = inheritedSessionResult()
            const session = result.sessions[0]
            session.sessionId = '2026/04/28/rollout-child-thread'
            session.lastActivity = 'Apr 28, 2026'
            return result
          }
          const result = inheritedDailyResult()
          result.daily[0].date = '2026-04-28'
          return result
        }
      })

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        usageDate: '2026-04-28',
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('includes cached tokens when total fields are omitted', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          if (args.includes('session')) {
            const result = inheritedSessionResult()
            const session = result.sessions[0]
            Reflect.deleteProperty(session.models['gpt-5'], 'totalTokens')
            Reflect.deleteProperty(session, 'totalTokens')
            return result
          }
          return inheritedDailyResult()
        }
      })

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220
      })
      expect(snapshots[0].costUsd).toBeCloseTo(0.22)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('corrects bounded subagent usage without requiring parent session lookup', async () => {
    const codexHome = await createEmptyCodexHome()
    const parentFile = join(codexHome, 'sessions', '2026', '05', '24', 'rollout-parent-thread.jsonl')
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '20260525')

    try {
      await writeJsonl(parentFile, [
        sessionMeta('parent-thread', '2026-05-24T13:00:00.000Z'),
        totalUsageEvent('2026-05-24T23:50:00.000Z', {
          inputTokens: 1000,
          cacheReadTokens: 900,
          outputTokens: 50
        })
      ])
      await utimes(parentFile, new Date('2026-05-24T23:50:00.000Z'), new Date('2026-05-24T23:50:00.000Z'))
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? inheritedSessionResult() : inheritedDailyResult()
        }
      })

      expect(snapshots[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('does not reject a bounded scan when an unrelated session changes', async () => {
    const codexHome = await createEmptyCodexHome()
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')
    const unrelatedFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-unrelated-thread.jsonl')
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '20260525')

    try {
      await writeInheritedChildSession(childFile)
      await writeJsonl(unrelatedFile, [sessionMeta('unrelated-thread', '2026-05-25T01:00:00.000Z')])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          if (args.includes('daily')) {
            await appendFile(unrelatedFile, '{"type":"event_msg"}\n')
          }
          return args.includes('session') ? inheritedSessionResult() : inheritedDailyResult()
        }
      })

      expect(snapshots[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('ignores subagent sessionId paths that escape the sessions directory', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeInheritedChildSession(join(codexHome, 'outside-child-thread.jsonl'))

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          if (!args.includes('session')) return inheritedDailyResult()
          const result = inheritedSessionResult()
          result.sessions[0].sessionId = '../outside-child-thread'
          return result
        }
      })

      expect(snapshots[0]).toMatchObject({
        inputTokens: 1100,
        outputTokens: 120,
        cacheReadTokens: 1950,
        totalTokens: 3170
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('ignores subagent directory and sessionFile paths that escape the sessions directory', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeInheritedChildSession(join(codexHome, 'outside-child-thread.jsonl'))

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          if (!args.includes('session')) return inheritedDailyResult()
          const result = inheritedSessionResult()
          const session = result.sessions[0] as Record<string, unknown>
          Reflect.deleteProperty(session, 'sessionId')
          session.directory = '..'
          session.sessionFile = 'outside-child-thread'
          return result
        }
      })

      expect(snapshots[0]).toMatchObject({
        inputTokens: 1100,
        outputTokens: 120,
        cacheReadTokens: 1950,
        totalTokens: 3170
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('distributes corrected subagent usage across multi-model session rows', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '15', 'rollout-parent-thread.jsonl'), [
        sessionMeta('parent-thread', '2026-05-15T13:00:00.000Z'),
        totalUsageEvent('2026-05-25T00:50:00.000Z', {
          inputTokens: 1000,
          cacheReadTokens: 900,
          outputTokens: 50
        })
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])
      await writeContextPricingFixture(codexHome)

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? inheritedMultiModelSessionResult() : inheritedMultiModelDailyResult()
        }
      })

      expect(snapshots.map((snapshot) => snapshot.model)).toEqual(['gpt-5.4', 'gpt-5.5'])
      expect(snapshots.reduce((total, snapshot) => total + snapshot.totalTokens, 0)).toBe(220)
      expect(snapshots.reduce((total, snapshot) => total + snapshot.cacheReadTokens, 0)).toBe(150)
      expect(snapshots.reduce((total, snapshot) => total + snapshot.inputTokens, 0)).toBe(50)
      expect(snapshots.reduce((total, snapshot) => total + snapshot.outputTokens, 0)).toBe(20)
      expect(snapshots.reduce((total, snapshot) => total + snapshot.costUsd, 0)).toBeCloseTo(0.22)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('keeps raw multi-model usage when corrected distribution cannot be subtracted', async () => {
    const codexHome = await createEmptyCodexHome()
    const errors: string[] = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl'), [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 1000,
          cacheReadTokens: 1000,
          outputTokens: 10
        })
      ])
      await writeContextPricingFixture(codexHome)

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        stderr: (line) => errors.push(line),
        async runner(_command, args) {
          return args.includes('session') ? skewedMultiModelSessionResult() : skewedMultiModelDailyResult()
        }
      })

      expect(snapshots.map((snapshot) => snapshot.model)).toEqual(['gpt-5.4', 'gpt-5.5'])
      expect(snapshots.reduce((total, snapshot) => total + snapshot.totalTokens, 0)).toBe(2112)
      expect(snapshots.find((snapshot) => snapshot.model === 'gpt-5.4')).toMatchObject({
        cacheReadTokens: 1,
        totalTokens: 12
      })
      expect(errors).toContain(
        'Skipping Codex subagent usage correction for 2026-05-25/gpt-5.4: corrected usage exceeds session row'
      )
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('ignores malformed subagent JSONL rows without aborting Codex collection', async () => {
    const codexHome = await createEmptyCodexHome()
    const errors: string[] = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '15', 'rollout-parent-thread.jsonl'), [
        sessionMeta('parent-thread', '2026-05-15T13:00:00.000Z'),
        totalUsageEvent('2026-05-25T00:50:00.000Z', {
          inputTokens: 1000,
          cacheReadTokens: 900,
          outputTokens: 50
        })
      ])
      const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')
      await writeJsonl(childFile, [
        subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent(
          '2026-05-25T01:10:00.000Z',
          {
            inputTokens: 1200,
            cacheReadTokens: 1050,
            outputTokens: 70
          },
          {
            lastUsage: {
              inputTokens: 200,
              cacheReadTokens: 150,
              outputTokens: 20
            }
          }
        )
      ])
      await appendFile(childFile, '{"type":"event_msg",\n')

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        stderr: (line) => errors.push(line),
        async runner(_command, args) {
          return args.includes('session') ? inheritedSessionResult() : inheritedDailyResult()
        }
      })

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 150,
        totalTokens: 220
      })
      expect(errors).toContain('Skipping malformed Codex subagent JSONL row at line 3')
      expect(errors.join('\n')).not.toContain(childFile)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

function codexSnapshot(): UsageSnapshot {
  return {
    source: 'codex',
    usageDate: '2026-05-25',
    timezone: 'Asia/Shanghai',
    model: 'gpt-5',
    inputTokens: 1100,
    outputTokens: 120,
    cacheCreationTokens: 0,
    cacheReadTokens: 1950,
    totalTokens: 3170,
    costUsd: 3.17,
    sessionCount: 1,
    collectedAt: '2026-05-25T01:20:00.000Z'
  }
}

async function writeContextPricingFixture(codexHome: string) {
  await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', 'context-pricing.jsonl'), [
    totalUsageEvent(
      '2026-05-25T04:00:00.000Z',
      {
        inputTokens: 44_000,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 44_000
      },
      { model: 'gpt-5.4' }
    ),
    totalUsageEvent(
      '2026-05-25T04:01:00.000Z',
      {
        inputTokens: 22_000,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 22_000
      },
      { model: 'gpt-5.5' }
    )
  ])
}

function inheritedSessionResultFor(id: string) {
  const result = inheritedSessionResult()
  result.sessions[0].sessionId = `2026/05/25/rollout-${id}`
  return result
}

function mergedProfileSessionResult() {
  return {
    sessions: [
      {
        sessionId: '2026/05/25/rollout-child-thread',
        lastActivity: '2026-05-25T01:20:00.000Z',
        totalTokens: 6340,
        costUSD: 6.34,
        models: {
          'gpt-5': {
            inputTokens: 2200,
            cachedInputTokens: 3900,
            outputTokens: 240,
            totalTokens: 6340,
            costUSD: 6.34
          }
        }
      }
    ]
  }
}

function mergedProfileDailyResult() {
  return {
    daily: [
      {
        date: '2026-05-25',
        models: {
          'gpt-5': {
            inputTokens: 2200,
            cachedInputTokens: 3900,
            outputTokens: 240,
            totalTokens: 6340
          }
        },
        totalTokens: 6340,
        costUSD: 6.34
      }
    ]
  }
}

async function writeCachedChildSession(codexHome: string, id: string) {
  await writeJsonl(join(codexHome, 'sessions', '2026', '05', '25', `rollout-${id}.jsonl`), [
    subagentSessionMeta(id, 'parent-thread', '2026-05-25T01:00:00.000Z'),
    totalUsageEvent(
      '2026-05-25T01:10:00.000Z',
      {
        inputTokens: 1200,
        cacheReadTokens: 1050,
        outputTokens: 70
      },
      {
        lastUsage: {
          inputTokens: 200,
          cacheReadTokens: 150,
          outputTokens: 20
        }
      }
    )
  ])
}

async function writeInheritedChildSession(file: string) {
  await writeJsonl(file, [
    subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
    totalUsageEvent(
      '2026-05-25T01:00:00.000Z',
      {
        inputTokens: 1000,
        cacheReadTokens: 900,
        outputTokens: 50
      },
      { lastUsage: null }
    ),
    totalUsageEvent(
      '2026-05-25T01:10:00.000Z',
      {
        inputTokens: 1200,
        cacheReadTokens: 1050,
        outputTokens: 70
      },
      {
        lastUsage: {
          inputTokens: 200,
          cacheReadTokens: 150,
          outputTokens: 20
        }
      }
    )
  ])
}

function multiDayInheritedSessionResult() {
  return {
    sessions: [
      {
        sessionId: '2026/05/26/rollout-child-thread',
        lastActivity: '2026-05-26T00:10:00.000Z',
        totalTokens: 6340,
        costUSD: 6.34,
        models: {
          'gpt-5': {
            inputTokens: 2200,
            cachedInputTokens: 3900,
            outputTokens: 240,
            totalTokens: 6340,
            costUSD: 6.34
          }
        }
      }
    ]
  }
}

function multiDayInheritedDailyResult() {
  return {
    daily: ['2026-05-25', '2026-05-26'].map((date) => ({
      date,
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
    }))
  }
}

function timezoneBoundarySessionResult() {
  const result = inheritedSessionResult()
  const session = result.sessions[0]
  session.sessionId = '2026/05/25/rollout-child-thread'
  session.lastActivity = '2026-05-26'
  return result
}

function timezoneBoundaryDailyResult() {
  const result = inheritedDailyResult()
  result.daily[0].date = '2026-05-26'
  return result
}
