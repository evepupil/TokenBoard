import { describe, expect, test } from 'vitest'
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
        TOKENBOARD_UPLOAD_TOKEN: 'tk_test',
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
        uploadToken: 'tk_test',
        snapshots: [codexSnapshot]
      }
    ])
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
})

