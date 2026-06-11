import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../test/sqlite-d1'
import { enforceRateLimit, pruneExpiredRateLimits, type RateLimitPolicy } from './rate-limit'

describe('D1 rate limiter', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('blocks requests after the fixed window budget is exhausted', async () => {
    const db = createRateLimitDb(tempDirs)
    const policy: RateLimitPolicy = {
      id: 'ingest',
      maxRequests: 2,
      windowSeconds: 60
    }
    const now = new Date('2026-06-11T00:00:00.000Z')

    await expect(enforceRateLimit(db, {
      policy,
      subject: { kind: 'upload-token', value: 'secret-token-hash' },
      now
    })).resolves.toMatchObject({ remaining: 1 })
    await expect(enforceRateLimit(db, {
      policy,
      subject: { kind: 'upload-token', value: 'secret-token-hash' },
      now
    })).resolves.toMatchObject({ remaining: 0 })

    await expect(enforceRateLimit(db, {
      policy,
      subject: { kind: 'upload-token', value: 'secret-token-hash' },
      now
    })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429
    })
  })

  test('resets the budget after the fixed window expires and does not store raw subjects', async () => {
    const db = createRateLimitDb(tempDirs)
    const policy: RateLimitPolicy = {
      id: 'device-pair',
      maxRequests: 1,
      windowSeconds: 60
    }

    await enforceRateLimit(db, {
      policy,
      subject: { kind: 'ip', value: '203.0.113.10' },
      now: new Date('2026-06-11T00:00:00.000Z')
    })
    const result = await enforceRateLimit(db, {
      policy,
      subject: { kind: 'ip', value: '203.0.113.10' },
      now: new Date('2026-06-11T00:01:00.000Z')
    })
    const row = await db
      .prepare('SELECT key FROM api_rate_limits LIMIT 1')
      .bind()
      .first<{ key: string }>()

    expect(result.remaining).toBe(0)
    expect(row?.key).toMatch(/^rl:v1:device-pair:ip:/)
    expect(row?.key).not.toContain('203.0.113.10')
  })

  test('prunes expired windows without deleting active windows', async () => {
    const db = createRateLimitDb(tempDirs)
    const policy: RateLimitPolicy = {
      id: 'ingest',
      maxRequests: 2,
      windowSeconds: 60
    }

    await enforceRateLimit(db, {
      policy,
      subject: { kind: 'ip', value: 'expired' },
      now: new Date('2026-06-11T00:00:00.000Z')
    })
    await enforceRateLimit(db, {
      policy,
      subject: { kind: 'ip', value: 'active' },
      now: new Date('2026-06-11T00:02:00.000Z')
    })

    await pruneExpiredRateLimits(db, new Date('2026-06-11T00:01:30.000Z'))

    const rows = await db
      .prepare('SELECT key FROM api_rate_limits ORDER BY key')
      .bind()
      .all<{ key: string }>()

    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]?.key).toMatch(/^rl:v1:ingest:ip:/)
  })
})

function createRateLimitDb(tempDirs: string[]) {
  const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-rate-limit-'))
  tempDirs.push(tempDir)
  const dbPath = join(tempDir, 'rate-limit.db')
  const migration = readFileSync('db/migrations/0021_api_rate_limits.sql', 'utf8')
  runSql(dbPath, migration)
  return createSqliteD1(dbPath)
}
