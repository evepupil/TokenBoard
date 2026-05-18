import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectClaudeCodeUsage } from './claude-code'

describe('collectClaudeCodeUsage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runs ccusage daily json with breakdown and normalizes the output', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const snapshots = await collectClaudeCodeUsage({
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-04-28T10:00:00.000Z',
      async runner(command, args) {
        calls.push({ command, args })
        if (args.includes('session')) {
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
        command: platformCommand('npx'),
        args: ['ccusage@latest', 'claude', 'daily', '--json', '--breakdown']
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@latest', 'claude', 'session', '--json']
      }
    ])
    expect(snapshots[0]).toMatchObject({
      source: 'claude-code',
      model: 'claude-sonnet-4-5',
      totalTokens: 10,
      sessionCount: 1
    })
  })

  test('uses configured since window', async () => {
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
        command: platformCommand('npm'),
        args: [
          'exec',
          '--yes',
          '--package',
          'ccusage@latest',
          '--',
          'ccusage',
          'claude',
          'daily',
          '--json',
          '--breakdown',
          '--since',
          '20260509'
        ]
      },
      {
        command: platformCommand('npm'),
        args: [
          'exec',
          '--yes',
          '--package',
          'ccusage@latest',
          '--',
          'ccusage',
          'claude',
          'session',
          '--json',
          '--since',
          '20260509'
        ]
      }
    ])
  })

  test('allows explicit full scan without passing all to ccusage', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_SINCE', 'all')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '20260509')

    await collectClaudeCodeUsage({
      async runner(command, args) {
        calls.push({ command, args })
        return { data: [] }
      }
    })

    expect(calls).toEqual([
      {
        command: platformCommand('npx'),
        args: ['ccusage@latest', 'claude', 'daily', '--json', '--breakdown']
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@latest', 'claude', 'session', '--json']
      }
    ])
  })
})

function platformCommand(command: string) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}
