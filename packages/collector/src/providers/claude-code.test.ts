import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectClaudeCodeUsage } from './claude-code'

describe('collectClaudeCodeUsage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runs ccusage daily json with breakdown and normalizes the output', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    const snapshots = await collectClaudeCodeUsage({
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-04-28T10:00:00.000Z',
      async runner(command, args) {
        calls.push({ command, args })
        if (args[1] === 'session') {
          return {
            data: [
              {
                sessionId: 's1',
                lastActivity: '2026-04-28T10:00:00.000Z',
                modelBreakdowns: {
                  'claude-sonnet-4-5': {
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
              date: '2026-04-28',
              breakdown: {
                'claude-sonnet-4-5': {
                  inputTokens: 1,
                  outputTokens: 2,
                  cacheCreationTokens: 3,
                  cacheReadTokens: 4,
                  costUSD: 0.01
                }
              }
            }
          ]
        }
      }
    })

    expect(calls).toEqual([
      {
        command: 'npx',
        args: ['ccusage@latest', 'daily', '--json', '--breakdown']
      },
      {
        command: 'npx',
        args: ['ccusage@latest', 'session', '--json']
      }
    ])
    expect(snapshots[0]).toMatchObject({
      source: 'claude-code',
      model: 'claude-sonnet-4-5',
      totalTokens: 10,
      sessionCount: 1
    })
  })

  test('uses since and selected package manager when configured', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', 'npm')
    vi.stubEnv('TOKENBOARD_SINCE', '20260509')

    await collectClaudeCodeUsage({
      async runner(command, args) {
        calls.push({ command, args })
        return { data: [] }
      }
    })

    expect(calls).toEqual([
      {
        command: 'npm',
        args: [
          'exec',
          '--yes',
          '--package',
          'ccusage@latest',
          '--',
          'ccusage',
          'daily',
          '--json',
          '--breakdown',
          '--since',
          '20260509'
        ]
      },
      {
        command: 'npm',
        args: [
          'exec',
          '--yes',
          '--package',
          'ccusage@latest',
          '--',
          'ccusage',
          'session',
          '--json',
          '--since',
          '20260509'
        ]
      }
    ])
  })
})
