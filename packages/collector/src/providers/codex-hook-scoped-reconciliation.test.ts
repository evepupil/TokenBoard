import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import { clearPendingUploadCursors } from './session-cursor'
import { tokenCountEvent, writeJsonl } from './codex-test-helpers'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Codex hook scoped reconciliation', () => {
  test('keeps complete changed-date aggregation while excluding unrelated history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-hook-scope-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const stableSession = join(codexHome, 'sessions', '2026', '05', '22', 'stable.jsonl')
    const activeOldSession = join(codexHome, 'sessions', '2026', '04', '02', 'active-old.jsonl')
    const unrelatedHistory = join(codexHome, 'sessions', '2025', '01', '01', 'history.jsonl')
    const scopedHomes: string[] = []
    const commandArgs: string[][] = []
    let activeTokens = 15
    let verifyFrozenScope = false

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await Promise.all([
        writeJsonl(stableSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 10)]),
        writeJsonl(activeOldSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', activeTokens)]),
        writeJsonl(unrelatedHistory, [tokenCountEvent('2025-01-01T01:00:00.000Z', 1)])
      ])
      await Promise.all([
        setFileMtime(stableSession, '2026-05-22T01:00:00.000Z'),
        setFileMtime(activeOldSession, '2026-05-22T01:00:00.000Z'),
        setFileMtime(unrelatedHistory, '2025-01-01T01:00:00.000Z')
      ])

      const runner = async (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        const scopedHome = String(options?.env?.CODEX_HOME)
        scopedHomes.push(scopedHome)
        commandArgs.push(args)
        if (!verifyFrozenScope) {
          return args.includes('session') ? initialSessionResult(activeTokens) : initialDailyResult(activeTokens)
        }
        expect(scopedHome).not.toBe(codexHome)
        expect(await fileExists(join(scopedHome, 'sessions', '2026', '05', '22', 'stable.jsonl'))).toBe(true)
        expect(await fileExists(join(scopedHome, 'sessions', '2026', '04', '02', 'active-old.jsonl'))).toBe(true)
        expect(await fileExists(join(scopedHome, 'sessions', '2025', '01', '01', 'history.jsonl'))).toBe(false)
        return args.includes('session') ? changedDateSessionResult(activeTokens) : changedDateDailyResult(activeTokens)
      }

      await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        runner
      })
      await clearPendingUploadCursors({ stateDir, source: 'codex' })

      verifyFrozenScope = true
      activeTokens = 20
      await writeFile(
        activeOldSession,
        `${JSON.stringify(tokenCountEvent('2026-05-22T02:00:00.000Z', activeTokens))}\n`,
        {
          flag: 'a'
        }
      )
      await setFileMtime(activeOldSession, '2026-05-22T02:00:00.000Z')
      scopedHomes.length = 0
      commandArgs.length = 0

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        runner
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 30,
          sessionCount: 2
        })
      ])
      expect(scopedHomes).toHaveLength(2)
      expect(new Set(scopedHomes).size).toBe(1)
      expect(commandArgs.every((args) => args.includes('--single-thread'))).toBe(true)
      expect(commandArgs).toEqual([
        expect.arrayContaining(['codex', 'daily', '--since', '20260522', '--until', '20260522']),
        expect.arrayContaining(['codex', 'session', '--since', '20260522', '--until', '20260522'])
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function changedDateDailyResult(activeTokens: number) {
  return {
    data: [
      {
        date: '2026-05-22',
        model: 'gpt-5',
        inputTokens: 10 + activeTokens,
        outputTokens: 0,
        totalTokens: 10 + activeTokens,
        costUSD: 0.01
      }
    ]
  }
}

function initialDailyResult(activeTokens: number) {
  return {
    data: [
      {
        date: '2025-01-01',
        model: 'gpt-5',
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        costUSD: 0.01
      },
      ...changedDateDailyResult(activeTokens).data
    ]
  }
}

function changedDateSessionResult(activeTokens: number) {
  return {
    data: [
      sessionResult('stable', '2026/05/22', '2026-05-22T01:00:00.000Z', 10),
      sessionResult('active-old', '2026/04/02', '2026-05-22T02:00:00.000Z', activeTokens)
    ]
  }
}

function initialSessionResult(activeTokens: number) {
  return {
    data: [
      ...changedDateSessionResult(activeTokens).data,
      sessionResult('history', '2025/01/01', '2025-01-01T01:00:00.000Z', 1)
    ]
  }
}

function sessionResult(sessionFile: string, directory: string, lastActivity: string, totalTokens: number) {
  return {
    sessionId: sessionFile,
    directory,
    sessionFile,
    lastActivity,
    models: {
      'gpt-5': {
        inputTokens: totalTokens,
        outputTokens: 0,
        totalTokens
      }
    }
  }
}

async function setFileMtime(file: string, value: string) {
  const date = new Date(value)
  await utimes(file, date, date)
}

async function fileExists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false)
}
