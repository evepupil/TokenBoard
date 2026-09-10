import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import { CODEX_SESSION_COPY_FALLBACK_MESSAGE } from './codex-session-cloner'
import { createEmptyCodexHome, tokenCountEvent, writeJsonl } from './codex-test-helpers'

describe('Codex bounded canonical attribution retry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('keeps the bounded snapshot when its source session changes after the frozen copy', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-bounded-retry-'))
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl')
    const diagnostics: string[] = []
    let canonicalRuns = 0
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionPath, [tokenCountEvent('2026-05-21T04:24:07.234Z', 10, 'gpt-5.6')])

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        stderr: reportDiagnostic(diagnostics),
        async runner(_command, args, options) {
          if (args.includes('--since') && args.includes('session')) return boundedSessionResult()
          if (args.includes('daily')) return dailyResult()
          canonicalRuns += 1
          if (canonicalRuns === 1) {
            await writeFile(
              sessionPath,
              `${JSON.stringify(tokenCountEvent('2026-05-21T04:24:07.234Z', 20, 'gpt-5.6'))}\n`
            )
          }
          return canonicalSessionResult()
        }
      })

      expect(canonicalRuns).toBe(1)
      expect(diagnostics).toEqual([
        'Skipping stale Codex canonical attribution cache write for a session that changed after copy'
      ])
      expect(snapshots).toContainEqual(
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-21',
          model: 'gpt-5.6',
          totalTokens: 10,
          sessionCount: 1
        })
      )
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('reports a stale canonical attribution cache write during a full-history collection', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-full-history-attribution-'))
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl')
    const diagnostics: string[] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionPath, [tokenCountEvent('2026-05-21T04:24:07.234Z', 10, 'gpt-5.6')])

      await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: 'all',
        stderr: reportDiagnostic(diagnostics),
        async runner(_command, args) {
          if (args.includes('daily')) return dailyResult()
          await writeFile(
            sessionPath,
            `${JSON.stringify(tokenCountEvent('2026-05-21T04:24:07.234Z', 20, 'gpt-5.6'))}\n`,
            { flag: 'a' }
          )
          return canonicalSessionResult()
        }
      })

      expect(diagnostics).toEqual([
        'Skipping stale Codex canonical attribution cache write for a session that changed after copy'
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('retries the complete bounded collection once when the canonical scope copy sees one source change', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-bounded-retry-'))
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '20', 'scope-race-session.jsonl')
    const diagnostics: string[] = []
    let canonicalRuns = 0
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionPath, [tokenCountEvent('2026-05-21T04:24:07.234Z', 10, 'gpt-5.6')])

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        stderr: reportDiagnostic(diagnostics),
        async runner(_command, args) {
          if (args.includes('--since') && args.includes('session')) return scopeRaceBoundedSessionResult()
          if (args.includes('daily')) return dailyResult()
          canonicalRuns += 1
          if (canonicalRuns === 1) {
            throw new Error('Codex session changed during scoped collection; retry the sync')
          }
          return scopeRaceCanonicalSessionResult()
        }
      })

      expect(canonicalRuns).toBe(2)
      expect(diagnostics).toEqual(['Codex canonical attribution changed; retrying the bounded collection once'])
      expect(snapshots).toContainEqual(
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-21',
          model: 'gpt-5.6',
          totalTokens: 10,
          sessionCount: 1
        })
      )
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('retries the complete bounded collection once when canonical attribution is briefly missing', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-bounded-retry-'))
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '20', 'scope-race-session.jsonl')
    const diagnostics: string[] = []
    let canonicalRuns = 0
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionPath, [tokenCountEvent('2026-05-21T04:24:07.234Z', 10, 'gpt-5.6')])

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        stderr: reportDiagnostic(diagnostics),
        async runner(_command, args) {
          if (args.includes('--since') && args.includes('session')) return scopeRaceBoundedSessionResult()
          if (args.includes('daily')) return dailyResult()
          canonicalRuns += 1
          return canonicalRuns === 1 ? { sessions: [] } : scopeRaceCanonicalSessionResult()
        }
      })

      expect(canonicalRuns).toBe(2)
      expect(diagnostics).toEqual(['Codex canonical attribution changed; retrying the bounded collection once'])
      expect(snapshots).toContainEqual(
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-21',
          model: 'gpt-5.6',
          totalTokens: 10,
          sessionCount: 1
        })
      )
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('retries once when a child session remains unstable during frozen bounded correction', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-bounded-retry-'))
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '20', 'unstable-session.jsonl')
    const diagnostics: string[] = []
    let canonicalRuns = 0
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionPath, [tokenCountEvent('2026-05-21T04:24:07.234Z', 10, 'gpt-5.6')])

      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          since: '20260515',
          stderr: reportDiagnostic(diagnostics),
          async runner(_command, args) {
            if (args.includes('--since') && args.includes('session')) {
              return unstableBoundedSessionResult()
            }
            if (args.includes('daily')) return dailyResult()
            canonicalRuns += 1
            if (canonicalRuns <= 2) {
              throw new Error('Codex child session changed while correcting; retry the sync')
            }
            return unstableCanonicalSessionResult()
          }
        })
      ).rejects.toThrow('Codex child session changed while correcting; retry the sync')

      expect(canonicalRuns).toBe(2)
      expect(diagnostics).toEqual(['Codex canonical attribution changed; retrying the bounded collection once'])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})

function reportDiagnostic(diagnostics: string[]) {
  return (line: string) => {
    if (line !== CODEX_SESSION_COPY_FALLBACK_MESSAGE) diagnostics.push(line)
  }
}

function dailyResult() {
  return {
    data: [
      {
        date: '2026-05-21',
        models: { 'gpt-5.6': { inputTokens: 10, totalTokens: 10 } }
      }
    ]
  }
}

function boundedSessionResult() {
  return sessionResult('stable-session', '2026-05-20T04:24:07.234Z', 'gpt-5.4')
}

function canonicalSessionResult() {
  return sessionResult('stable-session', '2026-05-21T04:24:07.234Z', 'gpt-5.6')
}

function unstableBoundedSessionResult() {
  return sessionResult('unstable-session', '2026-05-20T04:24:07.234Z', 'gpt-5.4')
}

function unstableCanonicalSessionResult() {
  return sessionResult('unstable-session', '2026-05-21T04:24:07.234Z', 'gpt-5.6')
}

function scopeRaceBoundedSessionResult() {
  return sessionResult('scope-race-session', '2026-05-20T04:24:07.234Z', 'gpt-5.4')
}

function scopeRaceCanonicalSessionResult() {
  return sessionResult('scope-race-session', '2026-05-21T04:24:07.234Z', 'gpt-5.6')
}

function sessionResult(sessionFile: string, lastActivity: string, model: string) {
  return {
    sessions: [
      {
        directory: '2026/05/20',
        sessionFile,
        lastActivity,
        models: { [model]: { inputTokens: 10, totalTokens: 10 } }
      }
    ]
  }
}
