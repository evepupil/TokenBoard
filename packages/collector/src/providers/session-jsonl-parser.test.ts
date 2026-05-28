import { describe, expect, test } from 'vitest'
import { parseSessionJsonl } from './session-jsonl-parser'

describe('parseSessionJsonl', () => {
  test('parses Codex token_count rows without exposing conversation fields', () => {
    const snapshots = parseSessionJsonl({
      source: 'codex',
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'codex-session',
      content: `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-05-22T01:00:00.000Z',
        payload: {
          type: 'token_count',
          prompt: 'do not upload',
          info: {
            model: 'gpt-5',
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation_input_tokens: 2,
              cache_read_input_tokens: 3,
              total_tokens: 20,
              cost_usd: 0.04
            }
          }
        }
      })}\n`
    })

    expect(snapshots).toEqual({
      ignoredUploadSafeRows: 0,
      malformedRows: 0,
      missingCost: false,
      unparsedTokenLikeRows: 0,
      snapshots: [
        {
          source: 'codex',
          usageDate: '2026-05-22',
          timezone: 'Asia/Shanghai',
          model: 'gpt-5',
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationTokens: 2,
          cacheReadTokens: 3,
          totalTokens: 20,
          costUsd: 0.04,
          sessionCount: 1,
          collectedAt: '2026-05-22T10:00:00.000Z'
        }
      ]
    })
    expect(JSON.stringify(snapshots)).not.toContain('do not upload')
  })

  test('parses Claude assistant usage rows', () => {
    const snapshots = parseSessionJsonl({
      source: 'claude-code',
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'claude-session',
      content: `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-22T02:00:00.000Z',
        message: {
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'do not upload' }],
          usage: {
            input_tokens: 8,
            output_tokens: 13,
            cache_creation_input_tokens: 21,
            cache_read_input_tokens: 34
          }
        },
        costUSD: 0.12
      })}\n`
    })

    expect(snapshots).toEqual({
      ignoredUploadSafeRows: 0,
      malformedRows: 0,
      missingCost: false,
      unparsedTokenLikeRows: 0,
      snapshots: [
        {
          source: 'claude-code',
          usageDate: '2026-05-22',
          timezone: 'Asia/Shanghai',
          model: 'claude-sonnet-4-5',
          inputTokens: 8,
          outputTokens: 13,
          cacheCreationTokens: 21,
          cacheReadTokens: 34,
          totalTokens: 76,
          costUsd: 0.12,
          sessionCount: 1,
          collectedAt: '2026-05-22T10:00:00.000Z'
        }
      ]
    })
    expect(JSON.stringify(snapshots)).not.toContain('do not upload')
  })

  test('ignores Claude user tool results with token-shaped fields', () => {
    const parsed = parseSessionJsonl({
      source: 'claude-code',
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'claude-session',
      content: `${JSON.stringify({
        type: 'user',
        timestamp: '2026-05-22T02:00:00.000Z',
        message: {
          role: 'user',
          content: 'do not upload'
        },
        toolUseResult: {
          totalTokens: 10,
          inputTokens: 4,
          outputTokens: 6
        }
      })}\n`
    })

    expect(parsed.snapshots).toEqual([])
    expect(parsed.unparsedTokenLikeRows).toBe(0)
    expect(JSON.stringify(parsed)).not.toContain('do not upload')
  })

  test('ignores Claude synthetic zero-usage assistant rows', () => {
    const parsed = parseSessionJsonl({
      source: 'claude-code',
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'claude-session',
      content: `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-22T02:00:00.000Z',
        message: {
          model: '<synthetic>',
          content: [{ type: 'text', text: 'do not upload' }],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            total_tokens: 0
          }
        }
      })}\n`
    })

    expect(parsed).toEqual({
      ignoredUploadSafeRows: 1,
      malformedRows: 0,
      missingCost: false,
      unparsedTokenLikeRows: 0,
      snapshots: []
    })
    expect(JSON.stringify(parsed)).not.toContain('do not upload')
  })

  test('marks token rows without cost as unsupported for upload-safe hook sync', () => {
    const snapshots = parseSessionJsonl({
      source: 'codex',
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'codex-session',
      content: `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-05-22T01:00:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            model: 'gpt-5',
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15
            }
          }
        }
      })}\n`
    })

    expect(snapshots.missingCost).toBe(true)
    expect(snapshots.snapshots[0]).toMatchObject({
      source: 'codex',
      model: 'gpt-5',
      totalTokens: 15,
      costUsd: 0
    })
  })

  test('treats explicit zero cost as a parsed cost value', () => {
    const snapshots = parseSessionJsonl({
      source: 'codex',
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'codex-session',
      content: `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-05-22T01:00:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            model: 'gpt-5',
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              cost_usd: 0
            }
          }
        }
      })}\n`
    })

    expect(snapshots.missingCost).toBe(false)
    expect(snapshots.snapshots[0].costUsd).toBe(0)
  })

  test('ignores Codex cumulative token_count metadata rows without schema drift', () => {
    const parsed = parseSessionJsonl({
      source: 'codex',
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'codex-session',
      content: `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-05-22T01:00:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            model: 'gpt-5',
            total_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15
            }
          }
        }
      })}\n`
    })

    expect(parsed.snapshots).toEqual([])
    expect(parsed.malformedRows).toBe(0)
    expect(parsed.unparsedTokenLikeRows).toBe(0)
  })

  test('ignores legacy Codex payload cumulative token_count metadata rows', () => {
    const parsed = parseSessionJsonl({
      source: 'codex',
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'codex-session',
      content: `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-05-22T01:00:00.000Z',
        payload: {
          type: 'token_count',
          total_token_usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15
          }
        }
      })}\n`
    })

    expect(parsed.snapshots).toEqual([])
    expect(parsed.malformedRows).toBe(0)
    expect(parsed.unparsedTokenLikeRows).toBe(0)
  })

  test('reports token-like rows that are not parsed into snapshots', () => {
    const parsed = parseSessionJsonl({
      source: 'codex',
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'codex-session',
      content: `${JSON.stringify({
        type: 'usage_summary',
        timestamp: '2026-05-22T01:00:00.000Z',
        token_usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cost_usd: 0.03
        }
      })}\n`
    })

    expect(parsed.snapshots).toEqual([])
    expect(parsed.malformedRows).toBe(0)
    expect(parsed.unparsedTokenLikeRows).toBe(1)
  })

  test('reports malformed non-empty JSONL rows', () => {
    const parsed = parseSessionJsonl({
      source: 'codex',
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'codex-session',
      content: '{"type":"event_msg"\n\n'
    })

    expect(parsed.snapshots).toEqual([])
    expect(parsed.malformedRows).toBe(1)
    expect(parsed.unparsedTokenLikeRows).toBe(0)
  })

  test('reports invalid timezone with parser context', () => {
    expect(() => parseSessionJsonl({
      source: 'codex',
      timezone: 'Not/AZone',
      collectedAt: '2026-05-22T10:00:00.000Z',
      sessionId: 'codex-session',
      content: `${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-05-22T01:00:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            model: 'gpt-5',
            last_token_usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              cost_usd: 0
            }
          }
        }
      })}\n`
    })).toThrow('Invalid timezone for session JSONL formatDate: Not/AZone')
  })
})
