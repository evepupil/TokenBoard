import { describe, expect, test } from 'vitest'
import {
  backfillUsageSummaryCache,
  findExistingSnapshotHashes,
  markIngestSynced,
  upsertUsageSnapshots,
  type IngestRecord
} from './repository'

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
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              sql,
              values,
              statementIndex: statementIndex++,
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

    const result = await upsertUsageSnapshots(db, [makeRecord(), makeRecord({ model: 'claude-opus-4-5' })])

    expect(result).toEqual({ upserted: 2 })
    expect(sqlStatements[0]).toContain('INSERT INTO daily_usage')
    expect(sqlStatements[0]).toContain('ON CONFLICT(user_id, device_id, source, usage_date, model) DO UPDATE SET')
    expect(sqlStatements[0]).toContain('daily_usage.snapshot_hash IS NULL')
    expect(sqlStatements[0]).toContain('OR daily_usage.snapshot_hash <> excluded.snapshot_hash')
    expect(sqlStatements[0]).toContain("excluded.source = 'codex'")
    expect(sqlStatements[0]).toContain('daily_usage.total_tokens > 0')
    expect(runCount).toBe(0)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(2)
    expect(batches[1]).toHaveLength(3)
    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO daily_usage_summary'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO user_usage_totals'))).toBe(true)
    const upsertBindings = bindings.filter((values) => values.length === 22)
    expect(upsertBindings.map((values) => values[5]).sort()).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5'])
    expect(upsertBindings.find((values) => values[5] === 'claude-sonnet-4-5')).toEqual([
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
      '2026-04-28T07:00:00.000Z',
      0,
      0,
      0,
      0,
      0,
      0,
      0
    ])
  })

  test('keeps each ingest phase inside D1 batch limits', async () => {
    const batches: unknown[][] = []
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              sql,
              values,
              statementIndex: statementIndex++
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
    expect(batches).toHaveLength(34)
    expect(batches.every((batch) => batch.length <= 100)).toBe(true)
    expect(batches.flat()).toHaveLength(1019)
    expect(batches.slice(0, -2).every((batch, index) => batch.length === (index % 2 === 0 ? 30 : 31))).toBe(true)
    expect(batches.at(-2)).toHaveLength(21)
    expect(batches.at(-1)).toHaveLength(22)
  })

  test('throws when D1 reports a failed ingest batch statement', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return { sql, values }
          }
        }
      },
      async batch(statements: unknown[]) {
        return statements.map((_, index) => ({
          success: index !== 1,
          error: index === 1 ? 'constraint failed' : undefined
        }))
      }
    } as unknown as D1Database

    await expect(upsertUsageSnapshots(db, [makeRecord()])).rejects.toThrow(
      'D1 batch statement 2 failed: constraint failed'
    )
  })

  test('refreshes deduped summary rows once per changed logical usage key', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return { sql, values, statementIndex: statementIndex++ }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    await upsertUsageSnapshots(db, [
      makeRecord({ deviceId: 'dev_1' }),
      makeRecord({ deviceId: 'dev_2' }),
      makeRecord({ usageDate: '2026-04-29' })
    ])

    const summaryBindings = bindings.filter((values) => values.length === 8)
    const totalsBindings = bindings.filter((values) => values.length === 2)
    expect(summaryBindings).toEqual([
      [
        'seed-user',
        '2026-04-28',
        'claude-code',
        'claude-sonnet-4-5',
        'seed-user',
        '2026-04-28',
        'claude-code',
        'claude-sonnet-4-5'
      ],
      [
        'seed-user',
        '2026-04-29',
        'claude-code',
        'claude-sonnet-4-5',
        'seed-user',
        '2026-04-29',
        'claude-code',
        'claude-sonnet-4-5'
      ]
    ])
    expect(totalsBindings).toEqual([['seed-user', 'seed-user']])
    const totalRefreshSql = sqlStatements.find((sql) => sql.includes('INSERT INTO user_usage_totals')) ?? ''
    expect(totalRefreshSql).toContain('FROM usage_summary_backfill_state')
    expect(totalRefreshSql).toContain('LEFT JOIN daily_usage_summary')
    expect(totalRefreshSql).not.toMatch(/FROM daily_usage(?!_summary)/)
    expect(sqlStatements.some((sql) => sql.includes('COALESCE(SUM(total_tokens - cache_read_tokens), 0)'))).toBe(true)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(3)
    expect(batches[1]).toHaveLength(3)
  })

  test('skips summary and total refreshes for unchanged snapshot upserts', async () => {
    const batches: unknown[][] = []
    const sqlStatements: string[] = []
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            return {
              sql,
              values,
              statementIndex: statementIndex++,
              async all() {
                return { results: [] }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map((statement) => ({
          success: true,
          meta: { changes: (statement as { sql: string }).sql.includes('INSERT INTO daily_usage') ? 0 : 1 }
        }))
      }
    } as unknown as D1Database

    const result = await upsertUsageSnapshots(db, [makeRecord(), makeRecord({ model: 'claude-opus-4-5' })])

    expect(result).toEqual({ upserted: 0 })
    expect(sqlStatements.some((sql) => sql.includes('expected_summary'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('expected_totals'))).toBe(true)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
    expect(
      batches[0].every((statement) => (statement as { sql: string }).sql.includes('INSERT INTO daily_usage'))
    ).toBe(true)
  })

  test('repairs missing summary and totals after an unchanged retry', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              sql,
              values,
              statementIndex: statementIndex++,
              async all() {
                if (sql.includes('expected_summary')) {
                  return {
                    results: [
                      {
                        userId: 'seed-user',
                        usageDate: '2026-04-28',
                        source: 'claude-code',
                        model: 'claude-sonnet-4-5'
                      }
                    ]
                  }
                }
                return { results: [] }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map((statement) => ({
          success: true,
          meta: { changes: (statement as { sql: string }).sql.includes('INSERT INTO daily_usage') ? 0 : 1 }
        }))
      }
    } as unknown as D1Database

    const result = await upsertUsageSnapshots(db, [makeRecord()])

    expect(result).toEqual({ upserted: 0 })
    expect(sqlStatements.some((sql) => sql.includes('expected_summary'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('expected_totals'))).toBe(false)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO daily_usage_summary'))).toHaveLength(1)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO user_usage_totals'))).toHaveLength(1)
    expect(bindings.some((values) => values.length === 8)).toBe(true)
    expect(bindings.some((values) => values.length === 2 && values.every((value) => value === 'seed-user'))).toBe(true)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(1)
    expect(batches[1]).toHaveLength(2)
  })

  test('repairs stale totals after an unchanged retry with current summaries', async () => {
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            return {
              sql,
              values,
              statementIndex: statementIndex++,
              async all() {
                if (sql.includes('expected_totals')) {
                  return { results: [{ userId: 'seed-user' }] }
                }
                return { results: [] }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map((statement) => ({
          success: true,
          meta: { changes: (statement as { sql: string }).sql.includes('INSERT INTO daily_usage') ? 0 : 1 }
        }))
      }
    } as unknown as D1Database

    const result = await upsertUsageSnapshots(db, [makeRecord()])

    expect(result).toEqual({ upserted: 0 })
    expect(sqlStatements.some((sql) => sql.includes('expected_summary'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('expected_totals'))).toBe(true)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO daily_usage_summary'))).toHaveLength(0)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO user_usage_totals'))).toHaveLength(1)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(1)
    expect(batches[1]).toHaveLength(1)
  })

  test('marks the upload token and device as synced after ingest', async () => {
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

    await markIngestSynced(db, {
      uploadTokenHash: 'hash:upload-token',
      deviceId: 'dev_123',
      installationId: 'inst_123',
      syncedAt: '2026-04-28T08:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('UPDATE upload_tokens')
    expect(sqlStatements[0]).toContain('last_used_at = ?')
    expect(bindings[0]).toEqual(['2026-04-28T08:00:00.000Z', 'hash:upload-token', '2026-04-28T08:00:00.000Z'])
    expect(sqlStatements[1]).toContain('UPDATE devices')
    expect(sqlStatements[1]).toContain('last_synced_at = ?')
    expect(bindings[1]).toEqual([
      '2026-04-28T08:00:00.000Z',
      '2026-04-28T08:00:00.000Z',
      'dev_123',
      '2026-04-28T08:00:00.000Z'
    ])
    expect(sqlStatements[2]).toContain('UPDATE device_installations')
    expect(sqlStatements[2]).toContain('last_seen_at = ?')
    expect(bindings[2]).toEqual([
      '2026-04-28T08:00:00.000Z',
      '2026-04-28T08:00:00.000Z',
      'inst_123',
      '2026-04-28T08:00:00.000Z',
      'hash:upload-token'
    ])
    expect(runCount).toBe(0)
    expect(batches).toEqual([[expect.any(Object), expect.any(Object), expect.any(Object)]])
  })
})

describe('backfillUsageSummaryCache', () => {
  test('refreshes summary keys with a bounded cursor before totals', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    const runValues: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              sql,
              values,
              async first() {
                return null
              },
              async all() {
                if (!sql.includes('FROM daily_usage') || sql.includes('daily_usage_summary')) {
                  return { results: [] }
                }
                return {
                  results: [
                    {
                      userId: 'user_1',
                      usageDate: '2026-04-28',
                      source: 'codex',
                      model: 'gpt-5'
                    },
                    {
                      userId: 'user_1',
                      usageDate: '2026-04-29',
                      source: 'claude-code',
                      model: 'claude-sonnet-4-5'
                    },
                    {
                      userId: 'user_2',
                      usageDate: '2026-04-30',
                      source: 'codex',
                      model: 'gpt-5'
                    }
                  ]
                }
              },
              async run() {
                runValues.push(values)
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

    const result = await backfillUsageSummaryCache({ db, limit: 2 })

    expect(result).toEqual({ backfilled: 2, totalsRefreshed: 0 })
    expect(sqlStatements[0]).toContain('FROM usage_summary_backfill_state')
    expect(sqlStatements[1]).toContain('FROM daily_usage')
    expect(sqlStatements[1]).toContain('GROUP BY user_id, usage_date, source, model')
    expect(sqlStatements[1]).toContain('ORDER BY user_id ASC, usage_date ASC, source ASC, model ASC')
    expect(sqlStatements[1]).not.toContain('aggregate_usage AS')
    expect(sqlStatements[1]).not.toContain('WHERE (user_id, usage_date, source, model) >')
    expect(bindings[1].at(-1)).toBe(3)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO daily_usage_summary'))).toHaveLength(2)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO user_usage_totals'))).toHaveLength(0)
    expect(runValues.at(-1)).toEqual([
      'initial',
      'summaries',
      'user_1',
      '2026-04-29',
      'claude-code',
      'claude-sonnet-4-5',
      null
    ])
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
  })

  test('continues summary backfill with a composite cursor instead of an OR scan', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return {
                  phase: 'summaries',
                  cursorUserId: 'user_1',
                  cursorUsageDate: '2026-04-28',
                  cursorSource: 'codex',
                  cursorModel: 'gpt-5',
                  completedAt: null
                }
              },
              async all() {
                return {
                  results: [
                    {
                      userId: 'user_1',
                      usageDate: '2026-04-29',
                      source: 'claude-code',
                      model: 'claude-sonnet-4-5'
                    }
                  ]
                }
              },
              async run() {
                return { success: true }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const result = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(result).toEqual({ backfilled: 1, totalsRefreshed: 0 })
    expect(sqlStatements[1]).toContain('WHERE (user_id, usage_date, source, model) > (?, ?, ?, ?)')
    expect(sqlStatements[1]).not.toContain('OR user_id >')
    expect(bindings[1]).toEqual(['user_1', '2026-04-28', 'codex', 'gpt-5', 2])
  })

  test('treats missing cursor columns as an initial summary backfill state', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return { phase: 'summaries' }
              },
              async all() {
                return { results: [] }
              },
              async run() {
                return { success: true }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const result = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(result).toEqual({ backfilled: 0, totalsRefreshed: 0 })
    expect(sqlStatements[1]).toContain('FROM daily_usage')
    expect(sqlStatements[1]).not.toContain('WHERE (user_id, usage_date, source, model) >')
    expect(bindings[1]).toEqual([2])
  })

  test('refreshes totals from summaries after summary backfill completes', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              sql,
              values,
              async first() {
                return {
                  phase: 'totals',
                  cursorUserId: null,
                  cursorUsageDate: null,
                  cursorSource: null,
                  cursorModel: null,
                  completedAt: null
                }
              },
              async all() {
                return { results: [{ userId: 'user_1' }, { userId: 'user_2' }] }
              },
              async run() {
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

    const result = await backfillUsageSummaryCache({ db, limit: 50 })

    expect(result).toEqual({ backfilled: 0, totalsRefreshed: 2 })
    expect(sqlStatements[1]).toContain('FROM daily_usage_summary')
    expect(sqlStatements[1]).not.toContain('WHERE ? IS NULL')
    expect(sqlStatements.join('\n')).not.toContain('aggregate_totals AS')
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO daily_usage_summary'))).toHaveLength(0)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO user_usage_totals'))).toHaveLength(2)
    expect(bindings.some((values) => values.length === 2 && values.every((value) => value === 'user_1'))).toBe(true)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
  })

  test('continues totals backfill with a user id cursor instead of a nullable OR scan', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return {
                  phase: 'totals',
                  cursorUserId: 'user_1',
                  cursorUsageDate: null,
                  cursorSource: null,
                  cursorModel: null,
                  completedAt: null
                }
              },
              async all() {
                return { results: [{ userId: 'user_2' }] }
              },
              async run() {
                return { success: true }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const result = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(result).toEqual({ backfilled: 0, totalsRefreshed: 1 })
    expect(sqlStatements[1]).toContain('FROM daily_usage_summary')
    expect(sqlStatements[1]).toContain('WHERE user_id > ?')
    expect(sqlStatements[1]).not.toContain('WHERE ? IS NULL')
    expect(bindings[1]).toEqual(['user_1', 2])
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
                if (sql.includes('expected_summary')) return { results: [] }
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
    expect(sqlStatements[1]).toContain('expected_summary')
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
    expect(bindings[1]).toEqual(['seed-user', '2026-04-28', 'codex', 'gpt-5'])
  })

  test('does not report existing hashes when the summary cache is missing or stale', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes('expected_summary')) {
                  return {
                    results: [
                      {
                        userId: 'seed-user',
                        usageDate: '2026-04-28',
                        source: 'codex',
                        model: 'gpt-5'
                      }
                    ]
                  }
                }
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
      keys: [{ source: 'codex', usageDate: '2026-04-28', model: 'gpt-5' }]
    })

    expect(result).toEqual([])
  })

  test('does not report existing hashes when user totals are missing or stale', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes('expected_summary')) {
                  return { results: [] }
                }
                if (sql.includes('expected_totals')) {
                  return { results: [{ userId: 'seed-user' }] }
                }
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
      keys: [{ source: 'codex', usageDate: '2026-04-28', model: 'gpt-5' }]
    })

    expect(result).toEqual([])
  })

  test('keeps existing hash queries under the D1 bound parameter limit', async () => {
    const bindings: unknown[][] = []
    let requestIndex = 0
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                if (sql.includes('expected_summary')) {
                  return { results: [] }
                }
                if (sql.includes('expected_totals')) {
                  return { results: [] }
                }
                const chunkKeys = values.slice(2)
                const results = []
                for (let index = 0; index < chunkKeys.length; index += 3) {
                  results.push({
                    source: chunkKeys[index],
                    usageDate: chunkKeys[index + 1],
                    model: chunkKeys[index + 2],
                    snapshotHash: `hash_${requestIndex}_${index}`
                  })
                }
                requestIndex += 1
                return { results }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const keys = Array.from({ length: 40 }, (_, index) => ({
      source: 'codex' as const,
      usageDate: `2026-04-${String((index % 30) + 1).padStart(2, '0')}`,
      model: `gpt-5-${index}`
    }))

    await findExistingSnapshotHashes(db, {
      userId: 'seed-user',
      deviceId: 'dev_123',
      keys
    })

    expect(bindings.every((values) => values.length <= 100)).toBe(true)
    expect(bindings.map((values) => values.length)).toEqual([98, 26, 100, 60, 1])
  })
})
