import { describe, expect, test } from 'vitest'
import { collectCodexUsage } from './codex'

describe('collectCodexUsage', () => {
  test('runs codex ccusage daily json and normalizes cache input aliases', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const snapshots = await collectCodexUsage({
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-04-28T10:00:00.000Z',
      async runner(command, args) {
        calls.push({ command, args })
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
      }
    ])
    expect(snapshots[0]).toMatchObject({
      source: 'codex',
      model: 'gpt-5',
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 10
    })
  })
})

