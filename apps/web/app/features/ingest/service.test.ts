import type { UsageSnapshot } from '@tokenboard/usage-core'
import { describe, expect, test } from 'vitest'
import type { AuthenticatedUser } from '../auth/middleware'
import { checkExistingSnapshots, ingestSnapshots } from './service'

const legacyUser: AuthenticatedUser = {
  id: 'user_legacy',
  uploadTokenHash: 'hash:legacy-upload-token',
  deviceId: null
}

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    source: 'codex',
    usageDate: '2026-05-22',
    timezone: 'Asia/Shanghai',
    model: 'gpt-5',
    inputTokens: 100,
    outputTokens: 40,
    cacheCreationTokens: 0,
    cacheReadTokens: 20,
    totalTokens: 160,
    costUsd: 0.03,
    sessionCount: 2,
    collectedAt: '2026-05-22T08:00:00.000Z',
    ...overrides
  }
}

function createRecordingDb() {
  const bound: Array<{ sql: string; values: unknown[] }> = []
  const batches: unknown[][] = []

  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const statement = {
            sql,
            values,
            async run() {
              return { success: true }
            },
            async all() {
              return { results: [] }
            }
          }
          bound.push({ sql, values })
          return statement
        }
      }
    },
    async batch(statements: unknown[]) {
      batches.push(statements)
      return statements.map(() => ({ success: true }))
    }
  } as unknown as D1Database

  return { db, bound, batches }
}

describe('ingest service', () => {
  test('stores old upload token snapshots under the legacy device id', async () => {
    const { db, bound, batches } = createRecordingDb()

    const result = await ingestSnapshots(db, legacyUser, [makeSnapshot()], '2026-05-22T09:00:00.000Z')

    expect(result).toEqual({ upserted: 1 })
    expect(batches).toHaveLength(1)
    expect(bound[0].sql).toContain('INSERT INTO daily_usage')
    expect(bound[0].values.slice(0, 6)).toEqual([
      'user_legacy',
      'legacy',
      'codex',
      '2026-05-22',
      'Asia/Shanghai',
      'gpt-5'
    ])
    expect(bound[1].sql).toContain('UPDATE upload_tokens')
    expect(bound[1].values).toEqual(['2026-05-22T09:00:00.000Z', 'hash:legacy-upload-token'])
    expect(bound.some((entry) => entry.sql.includes('UPDATE devices'))).toBe(false)
  })

  test('checks existing hashes against legacy device rows for old upload tokens', async () => {
    const { db, bound } = createRecordingDb()

    await checkExistingSnapshots(db, legacyUser, [
      { source: 'codex', usageDate: '2026-05-22', model: 'gpt-5' }
    ])

    expect(bound[0].sql).toContain('FROM daily_usage')
    expect(bound[0].sql).toContain('device_id = ?')
    expect(bound[0].values.slice(0, 5)).toEqual([
      'user_legacy',
      'legacy',
      'codex',
      '2026-05-22',
      'gpt-5'
    ])
  })
})
