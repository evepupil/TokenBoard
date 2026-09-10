import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const correction = vi.hoisted(() => vi.fn())

vi.mock('./codex-subagent-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex-subagent-usage')>()
  return {
    ...actual,
    applyCodexSubagentUsageCorrections: correction
  }
})

import { collectCodexUsage } from './codex'
import { CODEX_SESSION_COPY_FALLBACK_MESSAGE } from './codex-session-cloner'

describe('Codex hook child-session race recovery', () => {
  afterEach(() => {
    correction.mockReset()
    vi.unstubAllEnvs()
  })

  test('reruns the entire narrow reconciliation once after one child reader race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-hook-race-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const diagnostics: string[] = []
    const runner = vi.fn(async (_command: string, args: string[]) =>
      args.includes('session') ? sessionResult() : dailyResult()
    )

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    correction
      .mockRejectedValueOnce(new Error('Codex child session changed while reading; retry the sync'))
      .mockImplementation(async (input: { snapshots: unknown[] }) => input.snapshots)

    try {
      await writeJsonl(sessionFile, [tokenCountEvent()])

      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          stderr: reportDiagnostic(diagnostics),
          runner
        })
      ).resolves.toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15,
          sessionCount: 1
        })
      ])

      expect(correction).toHaveBeenCalledTimes(2)
      expect(runner).toHaveBeenCalledTimes(4)
      expect(diagnostics).toEqual(['Codex child session changed; retrying hook reconciliation once'])
      expect(await readPendingUpload(stateDir)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('leaves the parsed hook cursor pending after a second child reader race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-hook-race-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const runner = vi.fn(async (_command: string, args: string[]) =>
      args.includes('session') ? sessionResult() : dailyResult()
    )

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    correction.mockRejectedValue(new Error('Codex child session changed while reading; retry the sync'))

    try {
      await writeJsonl(sessionFile, [tokenCountEvent()])

      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          runner
        })
      ).rejects.toThrow('Codex child session changed while reading; retry the sync')

      expect(correction).toHaveBeenCalledTimes(2)
      expect(runner).toHaveBeenCalledTimes(4)
      expect(await readPendingUpload(stateDir)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not retry a non-race correction failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-hook-race-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const runner = vi.fn(async (_command: string, args: string[]) =>
      args.includes('session') ? sessionResult() : dailyResult()
    )

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    correction.mockRejectedValue(new Error('Codex child session contains invalid UTF-8'))

    try {
      await writeJsonl(sessionFile, [tokenCountEvent()])

      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          runner
        })
      ).rejects.toThrow('Codex child session contains invalid UTF-8')

      expect(correction).toHaveBeenCalledTimes(1)
      expect(runner).toHaveBeenCalledTimes(2)
      expect(await readPendingUpload(stateDir)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries an unbounded collection after one child reader race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-unbounded-race-'))
    const codexHome = join(root, 'codex')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const diagnostics: string[] = []
    const runner = vi.fn(async (_command: string, args: string[]) =>
      args.includes('session') ? sessionResult() : dailyResult()
    )

    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '')
    vi.stubEnv('TOKENBOARD_UNTIL', '')
    correction
      .mockRejectedValueOnce(new Error('Codex child session changed while reading; retry the sync'))
      .mockImplementation(async (input: { snapshots: unknown[] }) => input.snapshots)

    try {
      await writeJsonl(sessionFile, [tokenCountEvent()])

      await expect(
        collectCodexUsage({
          codexHome,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          stderr: reportDiagnostic(diagnostics),
          runner
        })
      ).resolves.toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15,
          sessionCount: 1
        })
      ])

      expect(correction).toHaveBeenCalledTimes(2)
      expect(runner).toHaveBeenCalledTimes(4)
      expect(diagnostics).toEqual(['Codex session files changed during unbounded collection; retrying once'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'w'
  })
}

function reportDiagnostic(diagnostics: string[]) {
  return (line: string) => {
    if (line !== CODEX_SESSION_COPY_FALLBACK_MESSAGE) diagnostics.push(line)
  }
}

async function readPendingUpload(stateDir: string) {
  const cursor = JSON.parse(await readFile(join(stateDir, 'codex-cursor.json'), 'utf8')) as {
    files: Record<string, { pendingUpload?: boolean }>
  }
  return cursor.files['2026/05/22/session.jsonl'].pendingUpload === true
}

function tokenCountEvent() {
  return {
    type: 'event_msg',
    timestamp: '2026-05-22T01:00:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5',
        last_token_usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cost_usd: 0.03
        }
      }
    }
  }
}

function dailyResult() {
  return {
    data: [
      {
        date: '2026-05-22',
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUSD: 0.03
      }
    ]
  }
}

function sessionResult() {
  return {
    data: [
      {
        sessionId: 'session',
        lastActivity: '2026-05-22T01:00:00.000Z',
        models: {
          'gpt-5': {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15
          }
        }
      }
    ]
  }
}
