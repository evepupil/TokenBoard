import { describe, expect, test } from 'vitest'
import { upsertUsageSnapshots, type IngestRecord } from './repository'

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    userId: 'seed-user',
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
    sessionCount: 2,
    collectedAt: '2026-04-28T07:00:00.000Z',
    ...overrides
  }
}

describe('upsertUsageSnapshots', () => {
  test('upserts daily usage rows with the aggregate primary key', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { success: true }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await upsertUsageSnapshots(db, [makeRecord()])

    expect(result).toEqual({ upserted: 1 })
    expect(sqlStatements[0]).toContain('INSERT INTO daily_usage')
    expect(sqlStatements[0]).toContain(
      'ON CONFLICT(user_id, source, usage_date, model) DO UPDATE SET'
    )
    expect(bindings[0]).toEqual([
      'seed-user',
      'claude-code',
      '2026-04-28',
      'Asia/Shanghai',
      'claude-sonnet-4-5',
      100,
      50,
      10,
      5,
      165,
      0.12,
      2,
      '2026-04-28T07:00:00.000Z'
    ])
  })
})

