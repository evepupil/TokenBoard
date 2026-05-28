import { appendFile, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
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
        totalUsageEvent('2026-05-25T01:00:00.000Z', {
          inputTokens: 1000,
          cacheReadTokens: 900,
          outputTokens: 50
        }, { lastUsage: null }),
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 1200,
          cacheReadTokens: 1050,
          outputTokens: 70
        }, {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        })
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
        totalUsageEvent('2026-05-25T23:55:00.000Z', {
          inputTokens: 1200,
          cacheReadTokens: 1050,
          outputTokens: 70
        }, {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        }),
        totalUsageEvent('2026-05-26T00:10:00.000Z', {
          inputTokens: 1400,
          cacheReadTokens: 1200,
          outputTokens: 90
        }, {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        })
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
        totalUsageEvent('2026-05-25T16:10:00.000Z', {
          inputTokens: 1200,
          cacheReadTokens: 1050,
          outputTokens: 70
        }, {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        })
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
        totalUsageEvent('2026-05-25T01:00:00.000Z', {
          inputTokens: 1000,
          cacheReadTokens: 900,
          outputTokens: 50
        }, { lastUsage: null }),
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 1200,
          cacheReadTokens: 1050,
          outputTokens: 70
        }, {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        })
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
        totalUsageEvent('2026-04-28T01:10:00.000Z', {
          inputTokens: 1200,
          cacheReadTokens: 1050,
          outputTokens: 70
        }, {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        })
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
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 1200,
          cacheReadTokens: 1050,
          outputTokens: 70
        }, {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        })
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

  test('corrects scoped subagent usage without requiring parent session lookup', async () => {
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
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 1200,
          cacheReadTokens: 1050,
          outputTokens: 70
        }, {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        })
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

  test('uses the scoped Codex home when correcting scoped subagent usage', async () => {
    const codexHome = await createEmptyCodexHome()
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '20260525')

    try {
      await writeInheritedChildSession(childFile)

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        async runner(_command, args) {
          if (args.includes('daily')) {
            await writeJsonl(childFile, [
              sessionMeta('different-original-thread', '2026-05-25T01:00:00.000Z')
            ])
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
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 1200,
          cacheReadTokens: 1050,
          outputTokens: 70
        }, {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        })
      ])

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
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 1200,
          cacheReadTokens: 1050,
          outputTokens: 70
        }, {
          lastUsage: {
            inputTokens: 200,
            cacheReadTokens: 150,
            outputTokens: 20
          }
        })
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

async function writeInheritedChildSession(file: string) {
  await writeJsonl(file, [
    subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z'),
    totalUsageEvent('2026-05-25T01:00:00.000Z', {
      inputTokens: 1000,
      cacheReadTokens: 900,
      outputTokens: 50
    }, { lastUsage: null }),
    totalUsageEvent('2026-05-25T01:10:00.000Z', {
      inputTokens: 1200,
      cacheReadTokens: 1050,
      outputTokens: 70
    }, {
      lastUsage: {
        inputTokens: 200,
        cacheReadTokens: 150,
        outputTokens: 20
      }
    })
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
