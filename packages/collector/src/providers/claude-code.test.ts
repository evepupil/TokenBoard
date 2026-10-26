import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectClaudeCodeUsage } from './claude-code'

const bundledCcusageConfigArgs = [
  '--config',
  join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'ccusage.json')
]

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
        args: [
          'ccusage@20.0.33',
          'claude',
          'daily',
          '--json',
          '--breakdown',
          '--single-thread',
          ...bundledCcusageConfigArgs
        ]
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@20.0.33', 'claude', 'session', '--json', '--single-thread', ...bundledCcusageConfigArgs]
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
          'ccusage@20.0.33',
          '--',
          'ccusage',
          'claude',
          'daily',
          '--json',
          '--breakdown',
          '--single-thread',
          '--since',
          '20260509',
          ...bundledCcusageConfigArgs
        ]
      },
      {
        command: platformCommand('npm'),
        args: [
          'exec',
          '--yes',
          '--package',
          'ccusage@20.0.33',
          '--',
          'ccusage',
          'claude',
          'session',
          '--json',
          '--single-thread',
          '--since',
          '20260509',
          ...bundledCcusageConfigArgs
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
      [
        'ccusage@20.0.33',
        'claude',
        'daily',
        '--json',
        '--breakdown',
        '--single-thread',
        '--since',
        '20260501',
        ...bundledCcusageConfigArgs
      ],
      [
        'ccusage@20.0.33',
        'claude',
        'session',
        '--json',
        '--single-thread',
        '--since',
        '20260501',
        ...bundledCcusageConfigArgs
      ]
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
      [
        'ccusage@20.0.33',
        'claude',
        'daily',
        '--json',
        '--breakdown',
        '--single-thread',
        '--since',
        '20260708',
        '--until',
        '20260709',
        ...bundledCcusageConfigArgs
      ],
      [
        'ccusage@20.0.33',
        'claude',
        'session',
        '--json',
        '--single-thread',
        '--since',
        '20260708',
        '--until',
        '20260709',
        ...bundledCcusageConfigArgs
      ]
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
        args: [
          'ccusage@20.0.33',
          'claude',
          'daily',
          '--json',
          '--breakdown',
          '--single-thread',
          ...bundledCcusageConfigArgs
        ]
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@20.0.33', 'claude', 'session', '--json', '--single-thread', ...bundledCcusageConfigArgs]
      }
    ])
  })

  // ccusage walks the whole session tree per report, so it gets the same 15-minute budget the
  // Codex provider uses rather than the generic 2-minute command default — the difference
  // between a loaded machine finishing a hook sync and a bare `Command failed` in the log.
  test('budgets ccusage commands for a full session scan, not the shared command default', async () => {
    const timeouts: Array<number | undefined> = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    await collectClaudeCodeUsage({
      since: '20260708',
      env: { TOKENBOARD_FORCE_PACKAGE_RUNNER: '1' },
      async runner(_command, _args, options) {
        timeouts.push(options?.timeoutMs)
        return { data: [] }
      }
    })

    expect(timeouts).toEqual([900_000, 900_000])
  })

  test('honours TOKENBOARD_CCUSAGE_TIMEOUT_MS for ccusage commands', async () => {
    const timeouts: Array<number | undefined> = []

    await collectClaudeCodeUsage({
      since: '20260708',
      env: { TOKENBOARD_FORCE_PACKAGE_RUNNER: '1', TOKENBOARD_CCUSAGE_TIMEOUT_MS: '1234' },
      async runner(_command, _args, options) {
        timeouts.push(options?.timeoutMs)
        return { data: [] }
      }
    })

    expect(timeouts).toEqual([1234, 1234])
  })

  // ccusage loads every session JSONL in parallel by default, which on a large
  // history peaks at 4.6-7.6 GB of resident memory held by a background hook.
  // The Codex provider already passes --single-thread everywhere; the Claude
  // calls were the remaining source of that peak.
  test('runs both ccusage calls single-threaded to bound memory', async () => {
    const calls: string[][] = []

    await collectClaudeCodeUsage({
      since: '20260708',
      env: { TOKENBOARD_FORCE_PACKAGE_RUNNER: '1' },
      async runner(_command, args) {
        calls.push(args)
        return { data: [] }
      }
    })

    expect(calls).toHaveLength(2)
    for (const args of calls) {
      expect(args).toContain('--single-thread')
    }
  })

  test('passes the generated dynamic pricing config to every ccusage invocation', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-claude-pricing-'))
    const calls: string[][] = []
    try {
      await collectClaudeCodeUsage({
        env: {
          TOKENBOARD_ENDPOINT: 'https://tokenboard.example/api/v1/ingest',
          TOKENBOARD_STATE_DIR: stateDir,
          TOKENBOARD_FORCE_PACKAGE_RUNNER: '1'
        },
        pricingFetcher: async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  provider: 'anthropic',
                  modelId: 'claude-fable-5-1',
                  inputCostPerMillion: 10,
                  outputCostPerMillion: 50,
                  cacheReadCostPerMillion: 1,
                  cacheWriteCostPerMillion: 12.5,
                  contextWindow: 1_000_000,
                  maxInputTokens: 1_000_000,
                  pricing: {}
                }
              ],
              nextCursor: null
            })
          ),
        async runner(_command, args) {
          calls.push(args)
          return { data: [] }
        }
      })

      expect(calls).toHaveLength(2)
      for (const args of calls) {
        expect(args).toContain('--config')
        expect(args).toContain(join(stateDir, 'ccusage.dynamic.json'))
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('passes the bundled pricing config when called directly without an endpoint', async () => {
    const calls: string[][] = []

    await collectClaudeCodeUsage({
      env: {
        TOKENBOARD_ENDPOINT: '',
        TOKENBOARD_FORCE_PACKAGE_RUNNER: '1'
      },
      async runner(_command, args) {
        calls.push(args)
        return { data: [] }
      }
    })

    const bundledConfigPath = bundledCcusageConfigArgs[1]
    expect(calls).toHaveLength(2)
    for (const args of calls) {
      expect(args).toContain('--config')
      expect(args).toContain(bundledConfigPath)
    }
  })

  // ccusage prices models from its own builtin catalogue, so a model missing from the
  // TokenBoard override set still arrives with a real cost. Warning about it buried the
  // log: on one machine 43-44 models per run, all priced, 1666 lines in a rotated stderr.
  // The warning only carries information when the cost actually came back as zero.
  test('stays quiet about models ccusage priced itself', async () => {
    const stderr: string[] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    await collectClaudeCodeUsage({
      env: { TOKENBOARD_ENDPOINT: '', TOKENBOARD_FORCE_PACKAGE_RUNNER: '1' },
      stderr: (line) => stderr.push(line),
      async runner(_command, args) {
        if (args.includes('session')) return { data: [] }
        return {
          data: [
            {
              date: '2026-04-28',
              breakdown: {
                'ccusage-priced-model': { inputTokens: 10, outputTokens: 2, costUSD: 0.25 }
              }
            }
          ]
        }
      }
    })

    expect(stderr.filter((line) => line.includes('model pricing unavailable'))).toEqual([])
  })

  test('still warns when a model came back with no cost at all', async () => {
    const stderr: string[] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    await collectClaudeCodeUsage({
      env: { TOKENBOARD_ENDPOINT: '', TOKENBOARD_FORCE_PACKAGE_RUNNER: '1' },
      stderr: (line) => stderr.push(line),
      async runner(_command, args) {
        if (args.includes('session')) return { data: [] }
        return {
          data: [
            {
              date: '2026-04-28',
              breakdown: {
                'self-hosted-alias': { inputTokens: 10, outputTokens: 2, costUSD: 0 }
              }
            }
          ]
        }
      }
    })

    expect(stderr.filter((line) => line.includes('model pricing unavailable'))).toEqual([
      'TokenBoard model pricing unavailable for Claude Code model self-hosted-alias; preserving ccusage result'
    ])
  })
})

function platformCommand(command: string) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}
