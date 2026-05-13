import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'

describe('collectCodexUsage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runs codex ccusage daily json and normalizes cache input aliases', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const snapshots = await collectCodexUsage({
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-04-28T10:00:00.000Z',
      async runner(command, args) {
        calls.push({ command, args })
        if (args[1] === 'session') {
          return {
            data: [
              {
                sessionId: 's1',
                lastActivity: 'Apr 28, 2026',
                models: {
                  'gpt-5': {
                    inputTokens: 1,
                    outputTokens: 2,
                    cachedInputTokens: 4
                  }
                }
              }
            ]
          }
        }
        return {
          data: [
            {
              date: '2026-04-28',
              models: ['gpt-5'],
              inputTokens: 1,
              outputTokens: 2,
              cacheCreationInputTokens: 3,
              cacheReadInputTokens: 4,
              costUSD: 0.01
            }
          ]
        }
      }
    })

    expect(calls).toEqual([
      {
        command: 'npx',
        args: ['@ccusage/codex@latest', 'daily', '--json']
      },
      {
        command: 'npx',
        args: ['@ccusage/codex@latest', 'session', '--json']
      }
    ])
    expect(snapshots[0]).toMatchObject({
      source: 'codex',
      model: 'gpt-5',
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 10,
      sessionCount: 1
    })
  })

  test('uses configured default since window when env is unset', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_SINCE', '')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '20260501')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '01', 'active.jsonl'), [
        tokenCountEvent('2026-05-01T04:24:07.234Z', 10)
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
        command: 'npx',
        args: ['@ccusage/codex@latest', 'daily', '--json', '--since', '20260501']
      },
      {
        command: 'npx',
        args: ['@ccusage/codex@latest', 'session', '--json', '--since', '20260501']
      }
    ])
  })

  test('reports partial codex collection when session counts fail', async () => {
    const errors: string[] = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    const snapshots = await collectCodexUsage({
      stderr: (line) => errors.push(line),
      async runner(_command, args) {
        if (args[1] === 'session') {
          throw new Error('session timed out')
        }
        return {
          data: [
            {
              date: '2026-05-12',
              model: 'gpt-5',
              inputTokens: 1,
              outputTokens: 2,
              totalTokens: 3
            }
          ]
        }
      }
    })

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      source: 'codex',
      usageDate: '2026-05-12',
      model: 'gpt-5',
      totalTokens: 3,
      sessionCount: 0
    })
    expect(errors).toEqual([
      'Codex daily tokens collected, but session counts are unavailable; continuing with sessionCount=0: session timed out'
    ])
  })

  test('allows explicit full codex scan in batches', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_SINCE', 'all')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '20260501')
    vi.stubEnv('TOKENBOARD_CODEX_BATCH_SIZE', '2')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '03', '20', 'first.jsonl'), [
        tokenCountEvent('2026-03-20T04:24:07.234Z', 10)
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '04', '20', 'second.jsonl'), [
        tokenCountEvent('2026-04-20T04:24:07.234Z', 10)
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '09', 'third.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z', 10)
      ])

      const scopedHomes = new Set<string>()
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-09T10:00:00.000Z',
        async runner(command, args, options) {
          calls.push({ command, args })
          scopedHomes.add(String(options?.env?.CODEX_HOME))
          if (args[1] === 'session') {
            return {
              data: [
                {
                  sessionId: `session-${scopedHomes.size}`,
                  lastActivity: 'May 9, 2026',
                  models: {
                    'gpt-5': {
                      inputTokens: 1,
                      outputTokens: 2
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-09',
                model: 'gpt-5',
                inputTokens: 1,
                outputTokens: 2,
                costUSD: 0.01
              }
            ]
          }
        }
      })

      expect(calls).toEqual([
        {
          command: 'npx',
          args: ['@ccusage/codex@latest', 'daily', '--json']
        },
        {
          command: 'npx',
          args: ['@ccusage/codex@latest', 'session', '--json']
        },
        {
          command: 'npx',
          args: ['@ccusage/codex@latest', 'daily', '--json']
        },
        {
          command: 'npx',
          args: ['@ccusage/codex@latest', 'session', '--json']
        }
      ])
      expect(scopedHomes.size).toBe(2)
      expect(snapshots).toEqual([
        expect.objectContaining({
          usageDate: '2026-05-09',
          model: 'gpt-5',
          inputTokens: 2,
          outputTokens: 4,
          totalTokens: 6,
          costUsd: 0.02,
          sessionCount: 2
        })
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('uses since and selected package manager when configured', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', 'bun')
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
        args: ['@ccusage/codex@latest', 'daily', '--json', '--since', '20260509']
      },
      {
        command: '/opt/bin/bunx',
        args: ['@ccusage/codex@latest', 'session', '--json', '--since', '20260509']
      }
    ])
  })

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
          if (args[1] === 'daily') {
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

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, {
    flag: 'w'
  })
}

async function createEmptyCodexHome() {
  const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  return codexHome
}

async function fileContainsTokenCount(file: string) {
  return readFile(file, 'utf8')
    .then((content) => content.includes('token_count'))
    .catch(() => false)
}

async function fileExists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false)
}

function tokenCountEvent(timestamp: string, totalTokens: number) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5',
        last_token_usage: {
          input_tokens: totalTokens,
          output_tokens: 0,
          total_tokens: totalTokens
        }
      }
    }
  }
}
