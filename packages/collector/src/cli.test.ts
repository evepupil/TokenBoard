import { describe, expect, test, vi } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runCollectorCli } from './cli'

const claudeSnapshot: UsageSnapshot = {
  source: 'claude-code',
  usageDate: '2026-04-28',
  timezone: 'Asia/Shanghai',
  model: 'claude-sonnet-4-5',
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationTokens: 3,
  cacheReadTokens: 4,
  totalTokens: 10,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: '2026-04-28T10:00:00.000Z'
}

const codexSnapshot: UsageSnapshot = {
  ...claudeSnapshot,
  source: 'codex',
  model: 'gpt-5'
}

describe('runCollectorCli', () => {
  test('previews all sources without uploading', async () => {
    const stdout: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async (_config, snapshots) => uploaded.push(snapshots)
      }
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([claudeSnapshot, codexSnapshot])
    expect(uploaded).toEqual([])
  })

  test('syncs selected source to the configured endpoint with the upload token', async () => {
    const uploaded: Array<{ endpoint: string; uploadToken: string; snapshots: UsageSnapshot[] }> = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async (config, snapshots) => {
          uploaded.push({
            endpoint: config.endpoint,
            uploadToken: config.uploadToken,
            snapshots
          })
          return { upserted: snapshots.length }
        }
      }
    )

    expect(result).toBe(0)
    expect(uploaded).toEqual([
      {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'test-upload-token',
        snapshots: [codexSnapshot]
      }
    ])
  })

  test('warms hook cursor high-water after a non-hook sync succeeds', async () => {
    const warmed: string[] = []
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1234).mockReturnValue(9999)

    try {
      const result = await runCollectorCli(
        ['sync', '--source', 'codex'],
        {
          CODEX_HOME: '/codex-home',
          TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
          TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
          TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
          TOKENBOARD_SINCE: 'all',
          TOKENBOARD_STATE_DIR: '/state'
        },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => [claudeSnapshot],
          collectCodexUsage: async () => [codexSnapshot],
          uploadSnapshots: async () => ({ upserted: 1 }),
          warmHookCursorHighWater: async (input) => {
            warmed.push(`${input.stateDir}:${input.source}:${input.sessionsDir}:${input.highWaterMs}`)
          }
        }
      )

      expect(result).toBe(0)
      expect(warmed).toEqual(['/state:codex:/codex-home/sessions:1234'])
    } finally {
      now.mockRestore()
    }
  })

  test('warms hook cursor high-water in configured config dir when state dir is unset', async () => {
    const warmed: string[] = []
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1234).mockReturnValue(9999)

    try {
      const result = await runCollectorCli(
        ['sync', '--source', 'codex'],
        {
          CODEX_HOME: '/codex-home',
          TOKENBOARD_CONFIG_DIR: '/custom-tokenboard',
          TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
          TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
          TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
          TOKENBOARD_SINCE: 'all'
        },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => [claudeSnapshot],
          collectCodexUsage: async () => [codexSnapshot],
          uploadSnapshots: async () => ({ upserted: 1 }),
          warmHookCursorHighWater: async (input) => {
            warmed.push(`${input.stateDir}:${input.source}:${input.sessionsDir}:${input.highWaterMs}`)
          }
        }
      )

      expect(result).toBe(0)
      expect(warmed).toEqual(['/custom-tokenboard:codex:/codex-home/sessions:1234'])
    } finally {
      now.mockRestore()
    }
  })

  test('does not warm hook cursor high-water after a bounded non-hook sync', async () => {
    const warmed: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        CODEX_HOME: '/codex-home',
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_SINCE: '20260517',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        warmHookCursorHighWater: async (input) => {
          warmed.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(0)
    expect(warmed).toEqual([])
  })

  test('does not warm hook cursor high-water during hook sync', async () => {
    const warmed: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        CODEX_HOME: '/codex-home',
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_SINCE: 'all',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        warmHookCursorHighWater: async (input) => {
          warmed.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(0)
    expect(warmed).toEqual([])
  })

  test('warms hook cursors without collecting or uploading', async () => {
    const warmed: string[] = []
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1234).mockReturnValue(9999)

    try {
      const result = await runCollectorCli(
        ['warm-hooks', '--source', 'all'],
        {
          CLAUDE_CONFIG_DIR: '/claude',
          CODEX_HOME: '/codex',
          TOKENBOARD_STATE_DIR: '/state'
        },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => {
            throw new Error('should not collect claude')
          },
          collectCodexUsage: async () => {
            throw new Error('should not collect codex')
          },
          uploadSnapshots: async () => {
            throw new Error('should not upload')
          },
          warmHookCursorHighWater: async (input) => {
            warmed.push(`${input.stateDir}:${input.source}:${input.sessionsDir}:${input.highWaterMs}`)
          }
        }
      )

      expect(result).toBe(0)
      expect(warmed).toEqual([
        '/state:claude-code:/claude/projects:1234',
        '/state:codex:/codex/sessions:1234'
      ])
    } finally {
      now.mockRestore()
    }
  })

  test('acks hook cursor only after upload succeeds', async () => {
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(0)
    expect(acks).toEqual(['/state:codex'])
  })

  test('acks hook cursor in configured config dir when state dir is unset', async () => {
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_CONFIG_DIR: '/custom-tokenboard',
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(0)
    expect(acks).toEqual(['/custom-tokenboard:codex'])
  })

  test('does not ack hook cursor when upload fails', async () => {
    const stderr: string[] = []
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => {
          throw new Error('upload failed')
        },
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['upload failed'])
    expect(acks).toEqual([])
  })

  test('does not ack hook cursor when sync config is missing', async () => {
    const stderr: string[] = []
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr[0]).toContain('TOKENBOARD_ENDPOINT')
    expect(stderr[0]).toContain('TOKENBOARD_UPLOAD_TOKEN')
    expect(acks).toEqual([])
  })

  test('returns an error when sync is missing endpoint or token', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(['sync'], {}, {
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
      collectClaudeCodeUsage: async () => [claudeSnapshot],
      collectCodexUsage: async () => [codexSnapshot],
      uploadSnapshots: async () => ({ upserted: 0 })
    })

    expect(result).toBe(1)
    expect(stderr[0]).toContain('TOKENBOARD_ENDPOINT')
    expect(stderr[0]).toContain('TOKENBOARD_UPLOAD_TOKEN')
  })

  test('warns and continues when one source is unavailable in all mode', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('No valid Claude data directories found')
        },
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length }
        }
      }
    )

    expect(result).toBe(0)
    expect(stderr).toEqual([
      'Skipping claude-code source: No valid Claude data directories found'
    ])
    expect(uploaded).toEqual([[codexSnapshot]])
  })

  test('returns failure after uploading available sources when strict source errors are enabled', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('No valid Claude data directories found')
        },
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length }
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr).toEqual([
      'Skipping claude-code source: No valid Claude data directories found',
      'One or more sources failed: claude-code: No valid Claude data directories found'
    ])
    expect(uploaded).toEqual([[codexSnapshot]])
  })

  test('fails instead of skipping a source in hook all mode', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('Claude hook reconciliation returned no snapshots')
        },
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length }
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['Claude hook reconciliation returned no snapshots'])
    expect(uploaded).toEqual([])
  })

  test('fails when the selected source is unavailable', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'claude-code'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('No valid Claude data directories found')
        },
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 0 })
      }
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['No valid Claude data directories found'])
  })
})
