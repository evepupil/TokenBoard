import { describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runCollectorCli } from './cli'

const openCodeSnapshot: UsageSnapshot = {
  source: 'opencode',
  usageDate: '2026-05-26',
  timezone: 'Asia/Shanghai',
  model: 'deepseek-v4-pro',
  inputTokens: 3272,
  outputTokens: 802,
  cacheCreationTokens: 0,
  cacheReadTokens: 52_480,
  totalTokens: 56_554,
  costUsd: 0.0023113,
  sessionCount: 1,
  collectedAt: '2026-05-26T10:00:00.000Z'
}

const claudeSnapshot: UsageSnapshot = {
  ...openCodeSnapshot,
  source: 'claude-code',
  model: 'claude-sonnet-4-5',
  costUsd: 0.01
}

const env = { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_STATE_DIR: '/state' }

describe('runCollectorCli OpenCode, Pi and Grok Build sources', () => {
  test('previews the selected OpenCode source', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'opencode'],
      env,
      deps({
        stdout: (line) => stdout.push(line),
        collectOpenCodeUsage: async (options) => {
          expect(options?.timezone).toBe('Asia/Shanghai')
          return [openCodeSnapshot]
        }
      })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([openCodeSnapshot])
  })

  test('includes OpenCode in an all-source collection', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      env,
      deps({
        stdout: (line) => stdout.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectOpenCodeUsage: async () => [openCodeSnapshot]
      })
    )

    expect(result).toBe(0)
    expect(
      JSON.parse(stdout[0])
        .map((item: UsageSnapshot) => item.source)
        .sort()
    ).toEqual(['claude-code', 'opencode'])
  })

  test('skips OpenCode without failing when it is not installed', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      env,
      deps({
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectOpenCodeUsage: async () => {
          throw new Error('OpenCode database not found: /home/user/.local/share/opencode/opencode.db')
        }
      })
    )

    expect(result).toBe(0)
    // The diagnostic must name OpenCode, not the Antigravity collection it reuses.
    expect(stderr.join('\n')).toContain('Skipping unavailable opencode source')
    expect(stderr.join('\n')).not.toContain('Antigravity collection')
  })

  test('reports a genuine OpenCode failure in an all-source run', async () => {
    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      env,
      deps({
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectOpenCodeUsage: async () => {
          throw new Error('database disk image is malformed')
        }
      })
    )

    expect(result).toBe(1)
  })

  test('fails an explicit OpenCode run when the source is unavailable', async () => {
    const result = await runCollectorCli(
      ['preview', '--source', 'opencode'],
      env,
      deps({
        collectOpenCodeUsage: async () => {
          throw new Error('OpenCode database not found: /db')
        }
      })
    )

    expect(result).toBe(1)
  })

  test('omits OpenCode from hook-mode collection', async () => {
    let calledOpenCode = false

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      { ...env, TOKENBOARD_HOOK_MODE: '1' },
      deps({
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectOpenCodeUsage: async () => {
          calledOpenCode = true
          return [openCodeSnapshot]
        }
      })
    )

    expect(result).toBe(0)
    expect(calledOpenCode).toBe(false)
  })

  test('never warms a hook cursor for OpenCode', async () => {
    const warmed: string[] = []

    const result = await runCollectorCli(
      ['warm-hooks', '--source', 'opencode'],
      { ...env, TOKENBOARD_SINCE: 'all' },
      deps({
        warmHookCursorHighWater: async (input: { source: string }) => {
          warmed.push(input.source)
        }
      })
    )

    expect(result).toBe(0)
    expect(warmed).toEqual([])
  })

  test('rejects an unknown source', async () => {
    const result = await runCollectorCli(['preview', '--source', 'open-code'], env, deps())

    expect(result).toBe(1)
  })

  test('previews the selected Pi and Grok Build sources', async () => {
    const piSnapshot: UsageSnapshot = { ...openCodeSnapshot, source: 'pi', model: 'deepseek-v4-pro' }
    const grokSnapshot: UsageSnapshot = { ...openCodeSnapshot, source: 'grok-build', model: 'grok-4.5', costUsd: 0 }

    for (const [flag, snapshot, override] of [
      ['pi', piSnapshot, 'collectPiUsage'],
      ['grok-build', grokSnapshot, 'collectGrokBuildUsage']
    ] as const) {
      const stdout: string[] = []
      const result = await runCollectorCli(
        ['preview', '--source', flag],
        env,
        deps({ stdout: (line) => stdout.push(line), [override]: async () => [snapshot] })
      )

      expect(result).toBe(0)
      expect(JSON.parse(stdout[0])).toEqual([snapshot])
    }
  })

  test('skips Pi and Grok Build when they are not installed', async () => {
    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      env,
      deps({
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectPiUsage: async () => {
          throw new Error('No Pi sessions found: /home/user/.pi/agent/sessions')
        },
        collectGrokBuildUsage: async () => {
          throw new Error('No Grok Build sessions found: /home/user/.grok/sessions')
        }
      })
    )

    expect(result).toBe(0)
  })

  test('omits Pi and Grok Build from hook-mode collection', async () => {
    const called: string[] = []

    await runCollectorCli(
      ['preview', '--source', 'all'],
      { ...env, TOKENBOARD_HOOK_MODE: '1' },
      deps({
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectPiUsage: async () => {
          called.push('pi')
          return []
        },
        collectGrokBuildUsage: async () => {
          called.push('grok-build')
          return []
        }
      })
    )

    expect(called).toEqual([])
  })

  test('previews the selected DeepSeek Harness source', async () => {
    const dshSnapshot: UsageSnapshot = {
      ...openCodeSnapshot,
      source: 'deepseek-harness',
      model: 'deepseek-v4-pro',
      costUsd: 0
    }
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'deepseek-harness'],
      env,
      deps({ stdout: (line) => stdout.push(line), collectDeepSeekHarnessUsage: async () => [dshSnapshot] })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([dshSnapshot])
  })

  test('skips DeepSeek Harness when it has no sessions', async () => {
    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      env,
      deps({
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectDeepSeekHarnessUsage: async () => {
          throw new Error('No DeepSeek Harness sessions found: /home/user/.dsh/sessions')
        }
      })
    )

    expect(result).toBe(0)
  })

  test('collects every new source in one all-source run', async () => {
    const stdout: string[] = []
    const make = (source: UsageSnapshot['source']): UsageSnapshot => ({
      ...openCodeSnapshot,
      source,
      costUsd: 0
    })

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      env,
      deps({
        stdout: (line) => stdout.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectOpenCodeUsage: async () => [make('opencode')],
        collectPiUsage: async () => [make('pi')],
        collectGrokBuildUsage: async () => [make('grok-build')],
        collectDeepSeekHarnessUsage: async () => [make('deepseek-harness')]
      })
    )

    expect(result).toBe(0)
    expect(
      JSON.parse(stdout[0])
        .map((item: UsageSnapshot) => item.source)
        .sort()
    ).toEqual(['claude-code', 'deepseek-harness', 'grok-build', 'opencode', 'pi'])
  })
})

function deps(overrides: Partial<Parameters<typeof runCollectorCli>[2]> = {}) {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    collectClaudeCodeUsage: async () => [],
    collectCodexUsage: async () => [],
    uploadSnapshots: async () => ({ upserted: 0, skipped: 0 }),
    ...overrides
  }
}
