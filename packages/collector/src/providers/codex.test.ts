import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    const snapshots = await collectCodexUsage({
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-04-28T10:00:00.000Z',
      async runner(command, args) {
        calls.push({ command, args })
        if (args.includes('session')) {
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
        command: platformCommand('npx'),
        args: ['ccusage@latest', 'codex', 'daily', '--json']
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@latest', 'codex', 'session', '--json']
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
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
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
        command: platformCommand('npx'),
        args: ['ccusage@latest', 'codex', 'daily', '--json', '--since', '20260501']
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@latest', 'codex', 'session', '--json', '--since', '20260501']
      }
    ])
  })

  test('passes configured codex home to unscoped ccusage commands', async () => {
    const codexHome = await createEmptyCodexHome()
    const homes = new Set<string>()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await collectCodexUsage({
        codexHome,
        async runner(_command, args, options) {
          homes.add(String(options?.env?.CODEX_HOME))
          if (args.includes('session')) return { data: [] }
          return { data: [] }
        }
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }

    expect(homes).toEqual(new Set([codexHome]))
  })

  test('reports partial codex collection when session counts fail', async () => {
    const errors: string[] = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    const snapshots = await collectCodexUsage({
      stderr: (line) => errors.push(line),
      async runner(_command, args) {
        if (args.includes('session')) {
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

function platformCommand(command: string) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}
