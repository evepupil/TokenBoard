import { describe, expect, test } from 'vitest'
import { findExistingSnapshotHashes, markIngestSynced, upsertUsageSnapshots, type IngestRecord } from './repository'

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    userId: 'seed-user',
    deviceId: 'dev_123',
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
  test('upserts daily usage rows with the device-level aggregate primary key', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    let runCount = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                runCount += 1
                return { success: true }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const result = await upsertUsageSnapshots(db, [
      makeRecord(),
      makeRecord({ model: 'claude-opus-4-5' })
    ])

    expect(result).toEqual({ upserted: 2 })
    expect(sqlStatements[0]).toContain('INSERT INTO daily_usage')
    expect(sqlStatements[0]).toContain(
      'ON CONFLICT(user_id, device_id, source, usage_date, model) DO UPDATE SET'
    )
    expect(runCount).toBe(0)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
    expect(bindings.map((values) => values[5]).sort()).toEqual([
      'claude-opus-4-5',
      'claude-sonnet-4-5'
    ])
    expect(bindings.find((values) => values[5] === 'claude-sonnet-4-5')).toEqual([
      'seed-user',
      'dev_123',
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
      expect.stringMatching(/^[a-f0-9]{64}$/),
      '2026-04-28T07:00:00.000Z'
    ])
  })

  test('splits large upserts into conservative D1 batches of 100 records', async () => {
    const batches: unknown[][] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              sql,
              values
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const records = Array.from({ length: 501 }, (_, index) =>
      makeRecord({
        model: `claude-sonnet-4-5-${index}`,
        totalTokens: 165 + index
      })
    )

    const result = await upsertUsageSnapshots(db, records)

    expect(result).toEqual({ upserted: 501 })
    expect(batches).toHaveLength(6)
    expect(batches.slice(0, 5).every((batch) => batch.length === 100)).toBe(true)
    expect(batches[5]).toHaveLength(1)
  })

  test('marks the upload token and device as synced after ingest', async () => {
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

    await markIngestSynced(db, {
      uploadTokenHash: 'hash:upload-token',
      deviceId: 'dev_123',
      syncedAt: '2026-04-28T08:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('UPDATE upload_tokens')
    expect(sqlStatements[0]).toContain('last_used_at = ?')
    expect(bindings[0]).toEqual(['2026-04-28T08:00:00.000Z', 'hash:upload-token'])
    expect(sqlStatements[1]).toContain('UPDATE devices')
    expect(sqlStatements[1]).toContain('last_synced_at = ?')
    expect(bindings[1]).toEqual([
      '2026-04-28T08:00:00.000Z',
      '2026-04-28T08:00:00.000Z',
      'dev_123'
    ])
  })
})

describe('findExistingSnapshotHashes', () => {
  test('queries existing hashes for the authenticated device and requested snapshot keys', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                return {
                  results: [
                    {
                      source: 'codex',
                      usageDate: '2026-04-28',
                      model: 'gpt-5',
                      snapshotHash: 'hash_1'
                    }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await findExistingSnapshotHashes(db, {
      userId: 'seed-user',
      deviceId: 'dev_123',
      keys: [
        { source: 'codex', usageDate: '2026-04-28', model: 'gpt-5' },
        { source: 'claude-code', usageDate: '2026-04-29', model: 'claude-sonnet-4-5' }
      ]
    })

    expect(result).toEqual([
      {
        source: 'codex',
        usageDate: '2026-04-28',
        model: 'gpt-5',
        snapshotHash: 'hash_1'
      }
    ])
    expect(sqlStatements[0]).toContain('FROM daily_usage')
    expect(sqlStatements[0]).toContain('user_id = ?')
    expect(sqlStatements[0]).toContain('device_id = ?')
    expect(sqlStatements[0]).toContain('(source = ? AND usage_date = ? AND model = ?)')
    expect(bindings[0]).toEqual([
      'seed-user',
      'dev_123',
      'codex',
      '2026-04-28',
      'gpt-5',
      'claude-code',
      '2026-04-29',
      'claude-sonnet-4-5'
    ])
  })
})
