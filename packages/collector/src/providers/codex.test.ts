import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'

describe('collectCodexUsage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runs codex ccusage daily json and normalizes cache input aliases', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
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

  test('uses since and selected package manager when configured', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', 'bun')
    vi.stubEnv('TOKENBOARD_BUNX_BIN', '/opt/bin/bunx')
    vi.stubEnv('TOKENBOARD_SINCE', '20260509')

    await collectCodexUsage({
      async runner(command, args) {
        calls.push({ command, args })
        return { data: [] }
      }
    })

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
})
