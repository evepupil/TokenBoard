import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import {
  createEmptyCodexHome,
  fileContainsTokenCount,
  fileExists,
  platformCommand,
  tokenCountEvent,
  writeJsonl
} from './codex-test-helpers'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('collectCodexUsage scoped scans', () => {
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
})

describe('collectCodexUsage scoped since scans', () => {
  test('uses since and selected package manager when configured', async () => {
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
        args: ['ccusage@latest', 'codex', 'daily', '--json', '--since', '20260509']
      },
      {
        command: '/opt/bin/bunx',
        args: ['ccusage@latest', 'codex', 'session', '--json', '--since', '20260509']
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

describe('collectCodexUsage scoped active files', () => {
  test('scopes since scans by active Codex session files instead of session directory dates', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
    const activeOldSession = join(codexHome, 'sessions', '2026', '03', '25', 'active-old-session.jsonl')
    const inactiveOldSession = join(codexHome, 'sessions', '2026', '03', '20', 'inactive-old-session.jsonl')
    const activeCurrentSession = join(codexHome, 'sessions', '2026', '05', '09', 'active-current-session.jsonl')

    try {
      await writeJsonl(activeOldSession, [tokenCountEvent('2026-05-09T04:24:07.234Z', 10)])
      await writeJsonl(inactiveOldSession, [tokenCountEvent('2026-03-20T04:24:07.234Z', 10)])
      await utimes(inactiveOldSession, new Date('2026-03-20T04:24:07.234Z'), new Date('2026-03-20T04:24:07.234Z'))
      await writeJsonl(activeCurrentSession, [tokenCountEvent('2026-05-09T04:25:07.234Z', 10)])

      const scopedHomes: string[] = []
      const scopedFiles = {
        activeOld: false,
        activeCurrent: false,
        inactiveOld: false
      }
      vi.stubEnv('TOKENBOARD_SINCE', '20260508')

      await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        async runner(_command, args, options) {
          if (args.includes('daily')) {
            const scopedHome = String(options?.env?.CODEX_HOME)
            scopedHomes.push(scopedHome)
            scopedFiles.activeOld = await fileContainsTokenCount(
              join(scopedHome, 'sessions', '2026', '03', '25', 'active-old-session.jsonl')
            )
            scopedFiles.activeCurrent = await fileContainsTokenCount(
              join(scopedHome, 'sessions', '2026', '05', '09', 'active-current-session.jsonl')
            )
            scopedFiles.inactiveOld = await fileExists(
              join(scopedHome, 'sessions', '2026', '03', '20', 'inactive-old-session.jsonl')
            )
          }
          return { data: [] }
        }
      })

      expect(scopedHomes).toHaveLength(1)
      expect(scopedFiles).toEqual({
        activeOld: true,
        activeCurrent: true,
        inactiveOld: false
      })
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

function createFullScanRunner(
  calls: Array<{ command: string; args: string[] }>,
  scopedHomes: Set<string>
) {
  return async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args })
    scopedHomes.add(String(options?.env?.CODEX_HOME))
    return args.includes('session') ? sessionResult(scopedHomes.size) : dailyResult()
  }
}

function twoBatchCodexCalls() {
  return [
    codexCall('daily'),
    codexCall('session'),
    codexCall('daily'),
    codexCall('session')
  ]
}

function codexCall(report: 'daily' | 'session') {
  return {
    command: platformCommand('npx'),
    args: ['ccusage@latest', 'codex', report, '--json']
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

function sessionResult(sessionId: string | number) {
  return {
    sessions: [
      {
        sessionId: String(sessionId),
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
