import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import { createEmptyCodexHome, fileExists, platformCommand, tokenCountEvent, writeJsonl } from './codex-test-helpers'
import { subagentSessionMeta, totalUsageEvent } from './codex-subagent-usage-test-helpers'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('collectCodexUsage scoped scans', () => {
  test('splits context-priced usage from a non-context canonical model in full scans', async () => {
    const codexHome = await createEmptyCodexHome()
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '09', 'mixed.jsonl')
    vi.stubEnv('TOKENBOARD_SINCE', 'all')

    try {
      await writeJsonl(sessionPath, [
        { type: 'turn_context', payload: { model: 'deepseek-v4-flash' } },
        tokenCountEvent('2026-05-09T04:24:07.234Z', 20, 'gpt-5.6-sol')
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'UTC',
        collectedAt: '2026-05-09T10:00:00.000Z',
        runner: async (_command, args) =>
          args.includes('session') ? mixedModelSessionResult() : mixedModelDailyResult()
      })

      expect(snapshots).toEqual([
        expect.objectContaining({ model: 'deepseek-v4-flash', totalTokens: 0, costUsd: 0 }),
        expect.objectContaining({
          model: 'gpt-5.6-sol',
          totalTokens: 20,
          costUsd: expect.closeTo((20 * 5) / 1_000_000, 14)
        })
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('allows explicit full codex scan in batches', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', 'all')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '20260501')
    vi.stubEnv('TOKENBOARD_CODEX_BATCH_SIZE', '2')

    try {
      await seedFullScanSessions(codexHome)

      const scopedHomes = new Set<string>()
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-09T10:00:00.000Z',
        runner: createFullScanRunner(calls, scopedHomes)
      })

      expect(calls).toEqual(twoBatchCodexCalls())
      expect(scopedHomes.size).toBe(2)
      expect(snapshots).toEqual([
        expect.objectContaining({
          usageDate: '2026-05-09',
          model: 'gpt-5',
          inputTokens: 20,
          outputTokens: 0,
          totalTokens: 20,
          costUsd: 0.02,
          sessionCount: 2
        })
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('collects a comma-containing Codex home from the JSON environment value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-json-home-'))
    const codexHome = join(root, 'profile,primary')
    const scopedHomes = new Set<string>()
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('CODEX_HOME', codexHome)
    vi.stubEnv('TOKENBOARD_CODEX_HOMES_JSON', JSON.stringify([codexHome]))

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '09', 'session.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z', 10)
      ])

      const snapshots = await collectCodexUsage({
        since: '20260509',
        timezone: 'Asia/Shanghai',
        async runner(_command, args, options) {
          scopedHomes.add(String(options?.env?.CODEX_HOME))
          return args.includes('session') ? sessionResult('session') : dailyResult()
        }
      })

      expect(scopedHomes.size).toBe(1)
      expect([...scopedHomes][0]).not.toContain('profile,primary')
      expect(snapshots).toEqual([expect.objectContaining({ totalTokens: 10, sessionCount: 1 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('persists frozen child usage under the original source identity', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-state-'))
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '09', 'session.jsonl')
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', 'all')

    try {
      await writeJsonl(sessionPath, [
        subagentSessionMeta('session', 'parent', '2026-05-09T04:20:00.000Z'),
        totalUsageEvent('2026-05-09T04:24:07.234Z', {
          inputTokens: 1,
          cacheReadTokens: 0,
          outputTokens: 0
        })
      ])

      await collectCodexUsage({
        codexHome,
        stateDir,
        async runner(_command, args) {
          return args.includes('session') ? sessionResult('session') : dailyResult()
        }
      })

      const cache = JSON.parse(await readFile(join(stateDir, 'codex-subagent-usage-cache.json'), 'utf8')) as {
        entries: Record<string, unknown>
      }
      const sourceKey = createHash('sha256').update(sessionPath).digest('hex')
      expect(Object.keys(cache.entries)).toEqual([sourceKey])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('warms canonical attribution cache when ccusage reports a session filename with its extension', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-state-'))
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '09', 'session.jsonl')
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', 'all')

    try {
      await writeJsonl(sessionPath, [tokenCountEvent('2026-05-09T04:24:07.234Z', 10)])

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        async runner(_command, args) {
          return args.includes('session') ? sessionResult('session.jsonl') : dailyResult()
        }
      })

      const cache = JSON.parse(await readFile(join(stateDir, 'codex-session-attribution-cache.json'), 'utf8'))
      expect(Object.keys(cache.entries)).toHaveLength(1)
      expect(Object.values(cache.entries)[0]).toMatchObject({
        usageDate: '2026-05-09',
        model: 'gpt-5'
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('warms canonical attribution cache for a directory-qualified session ID with its extension', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-state-'))
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '09', 'session.jsonl')
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', 'all')

    try {
      await writeJsonl(sessionPath, [tokenCountEvent('2026-05-09T04:24:07.234Z', 10)])

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        async runner(_command, args) {
          return args.includes('session') ? sessionResult('session.jsonl', 'sessionId') : dailyResult()
        }
      })

      const cache = JSON.parse(await readFile(join(stateDir, 'codex-session-attribution-cache.json'), 'utf8'))
      expect(Object.keys(cache.entries)).toHaveLength(1)
      expect(Object.values(cache.entries)[0]).toMatchObject({
        usageDate: '2026-05-09',
        model: 'gpt-5'
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('scans all configured Codex homes together during a full history collection', async () => {
    const firstHome = await createEmptyCodexHome()
    const secondHome = await createEmptyCodexHome()
    const scopedHomes = new Set<string>()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(firstHome, 'sessions', '2026', '04', '20', 'first.jsonl'), [
        tokenCountEvent('2026-04-20T04:24:07.234Z', 10)
      ])
      await writeJsonl(join(secondHome, 'sessions', '2026', '05', '09', 'second.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z', 20)
      ])

      const snapshots = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        since: 'all',
        async runner(_command, args, options) {
          const homes = String(options?.env?.CODEX_HOME).split(',')
          scopedHomes.add(homes.join(','))
          expect(homes).toHaveLength(2)
          await expect(
            readFile(join(homes[0], 'sessions', '2026', '04', '20', 'first.jsonl'), 'utf8')
          ).resolves.toContain('2026-04-20')
          await expect(
            readFile(join(homes[1], 'sessions', '2026', '05', '09', 'second.jsonl'), 'utf8')
          ).resolves.toContain('2026-05-09')
          return args.includes('session') ? sessionResult('first') : dailyResult()
        }
      })

      expect(scopedHomes.size).toBe(1)
    } finally {
      await Promise.all([
        rm(firstHome, { recursive: true, force: true }),
        rm(secondHome, { recursive: true, force: true })
      ])
    }
  })
})

describe('collectCodexUsage scoped since scans', () => {
  test('maps historical subagent model names to ccusage canonical session models', async () => {
    const codexHome = await createEmptyCodexHome()
    const sessionPath = join(codexHome, 'sessions', '2026', '07', '18', 'session.jsonl')

    try {
      await writeJsonl(sessionPath, [
        { type: 'session_meta', id: 'session' },
        { type: 'turn_context', payload: { model: 'gpt-5.5' } },
        tokenCountEvent('2026-07-18T00:00:00.000Z', 10, 'gpt-5.5')
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        since: '20260718',
        timezone: 'UTC',
        runner: async (_command, args) =>
          args.includes('daily')
            ? {
                daily: [
                  {
                    date: '2026-07-18',
                    modelBreakdowns: [
                      {
                        modelName: 'gpt-5.6-terra',
                        inputTokens: 10,
                        outputTokens: 0,
                        totalTokens: 10
                      }
                    ],
                    totalTokens: 10
                  }
                ]
              }
            : {
                sessions: [
                  {
                    directory: '2026/07/18',
                    sessionFile: 'session',
                    lastActivity: '2026-07-18T00:00:00.000Z',
                    modelBreakdowns: [
                      {
                        modelName: 'gpt-5.6-terra',
                        inputTokens: 10,
                        outputTokens: 0,
                        totalTokens: 10
                      }
                    ]
                  }
                ]
              }
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          usageDate: '2026-07-18',
          model: 'gpt-5.6-terra',
          inputTokens: 10,
          totalTokens: 10,
          costUsd: expect.closeTo((10 * 2) / 1_000_000, 14)
        })
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('uses since and the selected package manager for frozen bounded reports', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', 'bun')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_BUNX_BIN', '/opt/bin/bunx')
    vi.stubEnv('TOKENBOARD_SINCE', '20260509')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '09', 'active.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z', 10)
      ])
      await collectCodexUsage({
        codexHome,
        async runner(command, args) {
          calls.push({ command, args })
          return { data: [] }
        }
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }

    expect(calls).toEqual([
      {
        command: '/opt/bin/bunx',
        args: ['ccusage@20.0.20', 'codex', 'daily', '--json', '--offline', '--single-thread', '--since', '20260509']
      },
      {
        command: '/opt/bin/bunx',
        args: ['ccusage@20.0.20', 'codex', 'session', '--json', '--offline', '--single-thread', '--since', '20260509']
      },
      {
        command: '/opt/bin/bunx',
        args: ['ccusage@20.0.20', 'codex', 'session', '--json', '--offline', '--single-thread']
      }
    ])
  })
})

describe('collectCodexUsage scoped batch sizing', () => {
  test('caps the configured Codex batch size', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
    const calls: Array<{ command: string; args: string[] }> = []
    const scopedHomes = new Set<string>()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_SINCE', 'all')
    vi.stubEnv('TOKENBOARD_CODEX_BATCH_SIZE', '2')

    try {
      for (let index = 0; index < 3; index += 1) {
        await writeJsonl(join(codexHome, 'sessions', '2026', '05', '09', `session-${index}.jsonl`), [
          tokenCountEvent('2026-05-09T04:24:07.234Z', 1)
        ])
      }

      await collectCodexUsage({
        codexHome,
        async runner(command, args, options) {
          calls.push({ command, args })
          scopedHomes.add(String(options?.env?.CODEX_HOME))
          return { data: [] }
        }
      })

      expect(scopedHomes.size).toBe(2)
      expect(calls).toHaveLength(4)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

describe('collectCodexUsage bounded date scans', () => {
  test('collects a frozen daily report when bounded session discovery is empty', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
    const activeOldSession = join(codexHome, 'sessions', '2026', '03', '25', 'active-old-session.jsonl')
    const inactiveOldSession = join(codexHome, 'sessions', '2026', '03', '20', 'inactive-old-session.jsonl')
    const activeCurrentSession = join(codexHome, 'sessions', '2026', '05', '09', 'active-current-session.jsonl')

    try {
      await writeJsonl(activeOldSession, [tokenCountEvent('2026-05-09T04:24:07.234Z', 10)])
      await writeJsonl(inactiveOldSession, [tokenCountEvent('2026-03-20T04:24:07.234Z', 10)])
      await writeJsonl(activeCurrentSession, [tokenCountEvent('2026-05-09T04:25:07.234Z', 10)])

      const homes = new Set<string>()
      const calls: string[][] = []
      vi.stubEnv('TOKENBOARD_SINCE', '20260508')

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-09T10:00:00.000Z',
        async runner(_command, args, options) {
          homes.add(String(options?.env?.CODEX_HOME))
          calls.push(args)
          if (args.includes('daily')) return dailyResult()
          return { sessions: [] }
        }
      })

      expect(homes.size).toBe(1)
      expect(homes.has(codexHome)).toBe(false)
      expect(calls).toEqual([
        expect.arrayContaining(['codex', 'daily', '--since', '20260508']),
        expect.arrayContaining(['codex', 'session', '--since', '20260508']),
        expect.not.arrayContaining(['--since'])
      ])
      expect(snapshots).toEqual([
        expect.objectContaining({
          usageDate: '2026-05-09',
          model: 'gpt-5',
          totalTokens: 10,
          sessionCount: 0
        })
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('returns an empty bounded report when the configured Codex home has no session files', async () => {
    const codexHome = await createEmptyCodexHome()
    const calls: string[][] = []
    vi.stubEnv('TOKENBOARD_SINCE', '20260508')

    try {
      const snapshots = await collectCodexUsage({
        codexHome,
        async runner(_command, args) {
          calls.push(args)
          return { sessions: [] }
        }
      })

      expect(snapshots).toEqual([])
      expect(calls).toEqual([])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

describe('collectCodexUsage scoped cleanup', () => {
  test('keeps scoped Codex files available until reconciliation completes', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
    const activeSession = join(codexHome, 'sessions', '2026', '05', '09', 'active-session.jsonl')

    try {
      await writeJsonl(activeSession, [tokenCountEvent('2026-05-09T04:24:07.234Z', 10)])
      vi.stubEnv('TOKENBOARD_SINCE', '20260509')

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-09T10:00:00.000Z',
        runner: createDelayedScopedRunner()
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          usageDate: '2026-05-09',
          model: 'gpt-5',
          totalTokens: 10,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

async function seedFullScanSessions(codexHome: string) {
  await writeJsonl(join(codexHome, 'sessions', '2026', '03', '20', 'first.jsonl'), [
    tokenCountEvent('2026-03-20T04:24:07.234Z', 10)
  ])
  await writeJsonl(join(codexHome, 'sessions', '2026', '04', '20', 'second.jsonl'), [
    tokenCountEvent('2026-04-20T04:24:07.234Z', 10)
  ])
  await writeJsonl(join(codexHome, 'sessions', '2026', '05', '09', 'third.jsonl'), [
    tokenCountEvent('2026-05-09T04:24:07.234Z', 10)
  ])
}

function createFullScanRunner(calls: Array<{ command: string; args: string[] }>, scopedHomes: Set<string>) {
  return async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args })
    scopedHomes.add(String(options?.env?.CODEX_HOME))
    return args.includes('session') ? sessionResult(scopedHomes.size) : dailyResult()
  }
}

function twoBatchCodexCalls() {
  return [codexCall('daily'), codexCall('session'), codexCall('daily'), codexCall('session')]
}

function codexCall(report: 'daily' | 'session') {
  return {
    command: platformCommand('npx'),
    args: ['ccusage@20.0.20', 'codex', report, '--json', '--offline', '--single-thread', '--timezone', 'Asia/Shanghai']
  }
}

function createDelayedScopedRunner() {
  return async (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    await assertScopedSessionStillExists(String(options?.env?.CODEX_HOME))
    return args.includes('session') ? sessionResult('active-session') : dailyResult()
  }
}

async function assertScopedSessionStillExists(codexHome: string) {
  const scopedSession = join(codexHome, 'sessions', '2026', '05', '09', 'active-session.jsonl')
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(await fileExists(scopedSession)).toBe(true)
}

function sessionResult(sessionId: string | number, identifier: 'sessionFile' | 'sessionId' = 'sessionFile') {
  return {
    sessions: [
      {
        directory: '2026/05/09',
        [identifier]: String(sessionId),
        lastActivity: '2026-05-09T04:24:07.234Z',
        models: {
          'gpt-5': {
            inputTokens: 10,
            outputTokens: 0
          }
        }
      }
    ]
  }
}

function dailyResult() {
  return {
    daily: [
      {
        date: '2026-05-09',
        models: {
          'gpt-5': {
            inputTokens: 10,
            outputTokens: 0,
            totalTokens: 10
          }
        },
        totalTokens: 10,
        costUSD: 0.01
      }
    ]
  }
}

function mixedModelSessionResult() {
  return {
    sessions: [
      {
        directory: '2026/05/09',
        sessionFile: 'mixed',
        lastActivity: '2026-05-09T04:24:07.234Z',
        models: {
          'deepseek-v4-flash': { inputTokens: 20, outputTokens: 0, totalTokens: 20 }
        }
      }
    ]
  }
}

function mixedModelDailyResult() {
  return {
    daily: [
      {
        date: '2026-05-09',
        models: {
          'deepseek-v4-flash': { inputTokens: 20, outputTokens: 0, totalTokens: 20 }
        },
        totalTokens: 20,
        costUSD: (20 * 5) / 1_000_000
      }
    ]
  }
}
