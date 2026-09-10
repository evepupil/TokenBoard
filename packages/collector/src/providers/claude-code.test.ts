import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectClaudeCodeUsage } from './claude-code'

describe('collectClaudeCodeUsage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runs ccusage daily json with breakdown and normalizes the output', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
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
        args: ['ccusage@20.0.20', 'claude', 'daily', '--json', '--breakdown']
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@20.0.20', 'claude', 'session', '--json']
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
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
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
          'ccusage@20.0.20',
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
          'ccusage@20.0.20',
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

  test('uses the default since window when the primary environment value is empty', async () => {
    const calls: string[][] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '20260501')

    await collectClaudeCodeUsage({
      async runner(_command, args) {
        calls.push(args)
        return { data: [] }
      }
    })

    expect(calls).toEqual([
      ['ccusage@20.0.20', 'claude', 'daily', '--json', '--breakdown', '--since', '20260501'],
      ['ccusage@20.0.20', 'claude', 'session', '--json', '--since', '20260501']
    ])
  })

  test('prefers explicit date windows over process environment', async () => {
    const calls: string[][] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '20260509')
    vi.stubEnv('TOKENBOARD_UNTIL', '20260510')

    await collectClaudeCodeUsage({
      since: '20260708',
      until: '20260709',
      async runner(_command, args) {
        calls.push(args)
        return { data: [] }
      }
    })

    expect(calls).toEqual([
      ['ccusage@20.0.20', 'claude', 'daily', '--json', '--breakdown', '--since', '20260708', '--until', '20260709'],
      ['ccusage@20.0.20', 'claude', 'session', '--json', '--since', '20260708', '--until', '20260709']
    ])
  })

  test('rejects shell metacharacters in date filters before running ccusage', async () => {
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    await expect(collectClaudeCodeUsage({ since: '20260708&echo injected' })).rejects.toThrow(
      'Invalid Claude since date'
    )
    vi.stubEnv('TOKENBOARD_UNTIL', '20260708&echo injected')
    await expect(collectClaudeCodeUsage({ since: '20260708' })).rejects.toThrow('Invalid Claude until date')
  })

  test('rejects a reversed date window before running ccusage', async () => {
    await expect(
      collectClaudeCodeUsage({
        since: '20260709',
        until: '20260708',
        runner: async () => {
          throw new Error('runner should not be called')
        }
      })
    ).rejects.toThrow('since date must not be after until date')
  })

  test('allows explicit full scan without passing all to ccusage', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '20260708')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '20260509')

    await collectClaudeCodeUsage({
      since: 'all',
      async runner(command, args) {
        calls.push({ command, args })
        return { data: [] }
      }
    })

    expect(calls).toEqual([
      {
        command: platformCommand('npx'),
        args: ['ccusage@20.0.20', 'claude', 'daily', '--json', '--breakdown']
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@20.0.20', 'claude', 'session', '--json']
      }
    ])
  })
})

function platformCommand(command: string) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}
