import { describe, expect, test } from 'vitest'
import { normalizeCcusageDailyJson } from './normalize-ccusage'

const collectedAt = '2026-04-28T10:00:00.000Z'

describe('normalizeCcusageDailyJson', () => {
  test('normalizes ccusage daily breakdown rows into per-model snapshots', () => {
    const snapshots = normalizeCcusageDailyJson(
      {
        type: 'daily',
        data: [
          {
            date: '2026-04-28',
            breakdown: {
              'claude-sonnet-4-5': {
                inputTokens: 100,
                outputTokens: 50,
                cacheCreationTokens: 10,
                cacheReadTokens: 5,
                totalTokens: 165,
                costUSD: 0.12
              }
            }
          }
        ]
      },
      { source: 'claude-code', timezone: 'Asia/Shanghai', collectedAt }
    )

    expect(snapshots).toEqual([
      {
        source: 'claude-code',
        usageDate: '2026-04-28',
        timezone: 'Asia/Shanghai',
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 5,
        totalTokens: 165,
        costUsd: 0.12,
        sessionCount: 0,
        collectedAt
      }
    ])
  })

  test('normalizes standard daily rows when no model breakdown is present', () => {
    const snapshots = normalizeCcusageDailyJson(
      {
        daily: [
          {
            date: '2026-04-28',
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationTokens: 10,
            cacheReadTokens: 5,
            totalTokens: 165,
            totalCost: 0.12,
            modelsUsed: ['claude-sonnet-4-5', 'claude-opus-4-5']
          }
        ]
      },
      { source: 'claude-code', timezone: 'UTC', collectedAt }
    )

    expect(snapshots).toMatchObject([
      {
        source: 'claude-code',
        usageDate: '2026-04-28',
        timezone: 'UTC',
        model: 'all',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 5,
        totalTokens: 165,
        costUsd: 0.12
      }
    ])
  })

  test('accepts cache input token aliases from companion CLIs', () => {
    const snapshots = normalizeCcusageDailyJson(
      {
        type: 'daily',
        data: [
          {
            date: '2026-04-28',
            models: ['gpt-5'],
            inputTokens: 120,
            outputTokens: 80,
            cacheCreationInputTokens: 7,
            cacheReadInputTokens: 11,
            costUSD: 0.25
          }
        ]
      },
      { source: 'codex', timezone: 'Asia/Shanghai', collectedAt }
    )

    expect(snapshots).toMatchObject([
      {
        source: 'codex',
        usageDate: '2026-04-28',
        model: 'gpt-5',
        inputTokens: 120,
        outputTokens: 80,
        cacheCreationTokens: 7,
        cacheReadTokens: 11,
        totalTokens: 218,
        costUsd: 0.25
      }
    ])
  })
})

