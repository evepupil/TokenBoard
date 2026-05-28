import { describe, expect, test } from 'vitest'
import { normalizeCcusageDailyJson } from './normalize-ccusage'
import {
  codexDisplayDateDailyInput,
  multiModelSessionCountInput,
  multiModelSessionRows
} from './normalize-ccusage-test-helpers'

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

  test('accepts ccusage agent rows that use period instead of date', () => {
    const snapshots = normalizeCcusageDailyJson(
      {
        daily: [
          {
            period: '2026-05-18',
            agent: 'claude',
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            totalCost: 0.12,
            modelBreakdowns: [
              {
                modelName: 'claude-opus-4-6',
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                cost: 0.12
              }
            ]
          }
        ]
      },
      { source: 'claude-code', timezone: 'Asia/Shanghai', collectedAt }
    )

    expect(snapshots).toMatchObject([
      {
        source: 'claude-code',
        usageDate: '2026-05-18',
        model: 'claude-opus-4-6',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
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

  test('normalizes codex rows with display dates and models object', () => {
    const snapshots = normalizeCcusageDailyJson(
      codexDisplayDateDailyInput(),
      { source: 'codex', timezone: 'Asia/Shanghai', collectedAt }
    )

    expect(snapshots).toMatchObject([
      {
        source: 'codex',
        usageDate: '2026-04-28',
        model: 'gpt-5.4',
        inputTokens: 6663074,
        outputTokens: 45372,
        cacheReadTokens: 4871680,
        totalTokens: 6708446
      },
      {
        source: 'codex',
        usageDate: '2026-04-28',
        model: 'gpt-5.5',
        inputTokens: 56915400,
        outputTokens: 205593,
        cacheReadTokens: 53970560,
        totalTokens: 57120993
      }
    ])
    expect(snapshots[0].costUsd).toBeCloseTo(1.9822076685823609)
    expect(snapshots[1].costUsd).toBeCloseTo(16.878077331417643)
    expect(snapshots[0].costUsd + snapshots[1].costUsd).toBeCloseTo(18.860285)
  })

  test('does not double-count sessions that used multiple models', () => {
    const snapshots = normalizeCcusageDailyJson(
      multiModelSessionCountInput(),
      {
        source: 'claude-code',
        timezone: 'Asia/Shanghai',
        collectedAt,
        sessions: multiModelSessionRows()
      }
    )

    expect(snapshots).toMatchObject([
      {
        usageDate: '2026-04-28',
        model: 'claude-sonnet',
        sessionCount: 1
      },
      {
        usageDate: '2026-04-28',
        model: 'claude-opus',
        sessionCount: 2
      }
    ])
    expect(snapshots.reduce((total, snapshot) => total + snapshot.sessionCount, 0)).toBe(3)
  })

  test('does not fall back to per-model daily session counts when session rows are provided', () => {
    const snapshots = normalizeCcusageDailyJson(
      {
        data: [
          {
            date: '2026-04-28',
            modelBreakdowns: [
              {
                modelName: 'claude-sonnet',
                inputTokens: 30,
                outputTokens: 3,
                sessionCount: 1
              },
              {
                modelName: 'claude-opus',
                inputTokens: 40,
                outputTokens: 4,
                sessionCount: 1
              }
            ]
          }
        ]
      },
      {
        source: 'claude-code',
        timezone: 'Asia/Shanghai',
        collectedAt,
        sessions: {
          data: [
            {
              sessionId: 's1',
              lastActivity: '2026-04-28T12:00:00.000Z',
              modelBreakdowns: {
                'claude-sonnet': {
                  inputTokens: 30,
                  outputTokens: 3
                },
                'claude-opus': {
                  inputTokens: 40,
                  outputTokens: 4
                }
              }
            }
          ]
        }
      }
    )

    expect(snapshots).toMatchObject([
      {
        model: 'claude-sonnet',
        sessionCount: 0
      },
      {
        model: 'claude-opus',
        sessionCount: 1
      }
    ])
    expect(snapshots.reduce((total, snapshot) => total + snapshot.sessionCount, 0)).toBe(1)
  })

  test('matches session counts to daily rows using the report timezone', () => {
    const snapshots = normalizeCcusageDailyJson(
      {
        data: [
          {
            date: '2026-04-28',
            modelBreakdowns: [
              {
                modelName: 'claude-opus',
                inputTokens: 40,
                outputTokens: 4
              }
            ]
          }
        ]
      },
      {
        source: 'claude-code',
        timezone: 'Asia/Shanghai',
        collectedAt,
        sessions: {
          data: [
            {
              sessionId: 's1',
              lastActivity: '2026-04-27T16:10:00.000Z',
              modelBreakdowns: {
                'claude-opus': {
                  inputTokens: 40,
                  outputTokens: 4
                }
              }
            }
          ]
        }
      }
    )

    expect(snapshots[0]).toMatchObject({
      usageDate: '2026-04-28',
      model: 'claude-opus',
      sessionCount: 1
    })
  })

  test('treats an explicitly empty session result as authoritative', () => {
    const snapshots = normalizeCcusageDailyJson(
      {
        data: [
          {
            date: '2026-04-28',
            modelBreakdowns: [
              {
                modelName: 'claude-opus',
                inputTokens: 40,
                outputTokens: 4,
                sessionCount: 1
              }
            ]
          }
        ]
      },
      {
        source: 'claude-code',
        timezone: 'Asia/Shanghai',
        collectedAt,
        sessions: { data: [] }
      }
    )

    expect(snapshots[0]).toMatchObject({
      model: 'claude-opus',
      sessionCount: 0
    })
  })

  test('does not crash on session rows with empty model breakdowns', () => {
    const snapshots = normalizeCcusageDailyJson(
      {
        data: [
          {
            date: '2026-04-28',
            model: 'all',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0
          }
        ]
      },
      {
        source: 'claude-code',
        timezone: 'Asia/Shanghai',
        collectedAt,
        sessions: {
          data: [
            {
              sessionId: 's1',
              lastActivity: '2026-04-28T10:00:00.000Z',
              modelBreakdowns: []
            }
          ]
        }
      }
    )

    expect(snapshots[0]).toMatchObject({
      model: 'all',
      sessionCount: 1
    })
  })
})
