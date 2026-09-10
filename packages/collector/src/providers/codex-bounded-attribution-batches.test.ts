import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import { createEmptyCodexHome, tokenCountEvent, writeJsonl } from './codex-test-helpers'

describe('Codex bounded canonical attribution batches', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runs every bounded report in configured frozen session batches', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-bounded-batches-'))
    const first = join(codexHome, 'sessions', '2026', '05', '20', 'first.jsonl')
    const second = join(codexHome, 'sessions', '2026', '05', '20', 'second.jsonl')
    const canonicalBatches: Array<{ first: boolean; second: boolean }> = []
    const commandArgs: string[][] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_CODEX_BATCH_SIZE', '1')

    try {
      await Promise.all([
        writeJsonl(first, [tokenCountEvent('2026-05-21T04:24:07.234Z', 10, 'gpt-5.6')]),
        writeJsonl(second, [tokenCountEvent('2026-05-21T04:25:07.234Z', 10, 'gpt-5.6')])
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        async runner(_command, args, options) {
          commandArgs.push(args)
          const scopedHome = String(options?.env?.CODEX_HOME)
          if (scopedHome === codexHome) {
            throw new Error('Bounded collection must not run ccusage against the live Codex home')
          }
          const batch = {
            first: await exists(join(scopedHome, 'sessions', '2026', '05', '20', 'first.jsonl')),
            second: await exists(join(scopedHome, 'sessions', '2026', '05', '20', 'second.jsonl'))
          }
          if (args.includes('--since') && args.includes('session')) {
            if (batch.first === batch.second) {
              throw new Error('Frozen bounded batch must contain exactly one selected session')
            }
            return boundedSessionResultFor(batch.first ? 'first' : 'second')
          }
          if (args.includes('daily')) {
            if (batch.first === batch.second) {
              throw new Error('Frozen bounded batch must contain exactly one selected session')
            }
            return dailyResult(10)
          }
          canonicalBatches.push(batch)
          if (batch.first === batch.second) {
            throw new Error('Canonical attribution batch must contain exactly one bounded session')
          }
          return canonicalSessionResult(batch.first ? 'first' : 'second')
        }
      })

      expect(canonicalBatches).toHaveLength(2)
      expect(commandArgs).toHaveLength(6)
      expect(commandArgs.every((args) => args.includes('--single-thread'))).toBe(true)
      expect(canonicalBatches).toContainEqual({ first: true, second: false })
      expect(canonicalBatches).toContainEqual({ first: false, second: true })
      expect(snapshots).toContainEqual(
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-21',
          model: 'gpt-5.6',
          totalTokens: 20,
          sessionCount: 2
        })
      )
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('narrows canonical attribution to cache-miss files within a shared bounded scope', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-canonical-cache-miss-'))
    const first = join(codexHome, 'sessions', '2026', '05', '20', 'first.jsonl')
    const second = join(codexHome, 'sessions', '2026', '05', '20', 'second.jsonl')
    const canonicalScopes: Array<{ first: boolean; second: boolean }> = []
    const canonicalTokens: Array<{ first: number | null; second: number | null }> = []
    let dailyCalls = 0
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_CODEX_BATCH_SIZE', '200')

    try {
      await Promise.all([
        writeJsonl(first, [tokenCountEvent('2026-05-21T04:24:07.234Z', 10, 'gpt-5.6')]),
        writeJsonl(second, [tokenCountEvent('2026-05-21T04:25:07.234Z', 10, 'gpt-5.6')])
      ])

      const runner = async (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        const scopedHome = String(options?.env?.CODEX_HOME)
        const selected = {
          first: await exists(join(scopedHome, 'sessions', '2026', '05', '20', 'first.jsonl')),
          second: await exists(join(scopedHome, 'sessions', '2026', '05', '20', 'second.jsonl'))
        }
        if (args.includes('session') && !args.includes('--since')) canonicalScopes.push(selected)
        if (args.includes('session')) {
          if (!args.includes('--since')) {
            canonicalTokens.push({
              first: selected.first ? await readScopedToken(scopedHome, 'first') : null,
              second: selected.second ? await readScopedToken(scopedHome, 'second') : null
            })
          }
          return {
            sessions: [
              ...(selected.first ? [sessionRow('first', '2026-05-20T04:24:07.234Z', 'gpt-5.6')] : []),
              ...(selected.second ? [sessionRow('second', '2026-05-20T04:25:07.234Z', 'gpt-5.6')] : [])
            ]
          }
        }
        dailyCalls += 1
        if (dailyCalls === 2) {
          await writeFile(second, `${JSON.stringify(tokenCountEvent('2026-05-21T04:26:07.234Z', 20, 'gpt-5.6'))}\n`, {
            flag: 'a'
          })
        }
        return dailyResult(20)
      }

      await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        runner
      })

      await writeFile(second, `${JSON.stringify(tokenCountEvent('2026-05-21T04:25:30.234Z', 15, 'gpt-5.6'))}\n`, {
        flag: 'a'
      })

      await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        runner
      })

      expect(canonicalScopes).toEqual([
        { first: true, second: true },
        { first: false, second: true }
      ])
      expect(canonicalTokens).toEqual([
        { first: 10, second: 10 },
        { first: null, second: 15 }
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})

function dailyResult(totalTokens: number) {
  return {
    data: [
      {
        date: '2026-05-21',
        models: { 'gpt-5.6': { inputTokens: totalTokens, totalTokens } }
      }
    ]
  }
}

function boundedSessionResultFor(sessionFile: string) {
  return { sessions: [sessionRow(sessionFile, '2026-05-20T04:24:07.234Z')] }
}

function canonicalSessionResult(sessionFile: string) {
  return {
    sessions: [sessionRow(sessionFile, '2026-05-21T04:24:07.234Z', 'gpt-5.6')]
  }
}

function sessionRow(sessionFile: string, lastActivity: string, model = 'gpt-5.4') {
  return {
    directory: '2026/05/20',
    sessionFile,
    lastActivity,
    models: { [model]: { inputTokens: 10, totalTokens: 10 } }
  }
}

async function exists(filePath: string) {
  return access(filePath)
    .then(() => true)
    .catch(() => false)
}

async function readScopedToken(scopedHome: string, sessionFile: string) {
  const content = await readFile(join(scopedHome, 'sessions', '2026', '05', '20', `${sessionFile}.jsonl`), 'utf8')
  const event = JSON.parse(content.trim().split('\n').at(-1) ?? '{}')
  return event.payload?.info?.last_token_usage?.total_tokens ?? null
}
