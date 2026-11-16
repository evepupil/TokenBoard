import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { upsertUsageSnapshots, type IngestRecord } from './repository'
import { snapshotHash } from './repository/types'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

// Re-uploading is the normal case, not an edge one: a collector retries a batch after a partial
// failure, and a scheduled sync re-sends whatever it re-derived. Two independent guards keep that
// from double-counting, and this file pins both, because either alone looks sufficient until the
// other is removed:
//
//   1. the `WHERE daily_usage.snapshot_hash <> excluded.snapshot_hash` clause skips the update
//      entirely when the row already holds this exact measurement;
//   2. the `CASE WHEN ... ELSE excluded.x END` arms replace rather than add, which is what a
//      *changed* measurement for the same day needs — the collector re-derives a day's totals
//      each scan, so a later upload is the newer value and summing would grow without bound.
describe('ingest idempotency', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('re-uploading the identical snapshot does not double-count', async () => {
    const { db, path } = createDb(tempDirs)
    const record = makeRecord()

    await upsertUsageSnapshots(db, [record])
    await upsertUsageSnapshots(db, [record])

    expect(totalTokens(path)).toBe(165)
    expect(rowCount(path)).toBe(1)
  })

  // The same measurement re-sent after its `collectedAt` moved is still the same measurement:
  // the hash covers the metrics, not the timestamp. Without that, every scheduled sync would
  // count the day again.
  test('a re-send with a newer collectedAt is still the same measurement', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [makeRecord({ collectedAt: '2026-04-28T07:00:00.000Z' })])
    await upsertUsageSnapshots(db, [makeRecord({ collectedAt: '2026-04-28T09:30:00.000Z' })])

    expect(totalTokens(path)).toBe(165)
    expect(rowCount(path)).toBe(1)
  })

  // The two guards overlap on totals, so a totals-only assertion cannot tell which one ran —
  // removing the hash short-circuit entirely left every other test in this file green. `synced_at`
  // is written only by the update branch, so it distinguishes them: an identical re-send must
  // leave the row untouched, while a changed measurement must rewrite it.
  test('an identical re-send leaves the stored row untouched', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [makeRecord({ collectedAt: '2026-04-28T07:00:00.000Z' })])
    const firstSyncedAt = scalarText(path, 'SELECT synced_at FROM daily_usage')
    await upsertUsageSnapshots(db, [makeRecord({ collectedAt: '2026-04-28T09:30:00.000Z' })])
    const secondSyncedAt = scalarText(path, 'SELECT synced_at FROM daily_usage')

    expect(secondSyncedAt).toBe(firstSyncedAt)

    // A changed measurement must take the update branch and advance the marker.
    await upsertUsageSnapshots(db, [makeRecord({ totalTokens: 200, collectedAt: '2026-04-28T11:00:00.000Z' })])
    const thirdSyncedAt = scalarText(path, 'SELECT synced_at FROM daily_usage')

    expect(thirdSyncedAt).not.toBe(firstSyncedAt)
  })

  test('a retried batch re-sends stored rows alongside new ones', async () => {
    const { db, path } = createDb(tempDirs)
    const first = makeRecord({ usageDate: '2026-04-27', totalTokens: 100 })
    const second = makeRecord({ usageDate: '2026-04-28', totalTokens: 165 })

    await upsertUsageSnapshots(db, [first])
    await upsertUsageSnapshots(db, [first, second])

    expect(totalTokens(path)).toBe(265)
    expect(rowCount(path)).toBe(2)
  })

  // The collector re-derives a day's totals on every scan, so a changed measurement for the same
  // key must replace the stored one. Summing would make the day grow on every sync.
  test('a changed measurement for the same day replaces rather than accumulates', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [makeRecord({ totalTokens: 165, inputTokens: 100 })])
    await upsertUsageSnapshots(db, [makeRecord({ totalTokens: 200, inputTokens: 135 })])

    expect(totalTokens(path)).toBe(200)
    expect(rowCount(path)).toBe(1)
  })

  test('different models on the same day stay separate rows', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [
      makeRecord({ model: 'claude-sonnet-4-5', totalTokens: 100 }),
      makeRecord({ model: 'gpt-5.4', totalTokens: 50 })
    ])

    expect(rowCount(path)).toBe(2)
    expect(totalTokens(path)).toBe(150)
  })

  // Different devices are different rows under the same user, so one machine re-syncing must not
  // disturb another's totals.
  test('the same day on two devices stays separate', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [
      makeRecord({ deviceId: 'dev_a', totalTokens: 100 }),
      makeRecord({ deviceId: 'dev_b', totalTokens: 50 })
    ])

    expect(rowCount(path)).toBe(2)
    expect(totalTokens(path)).toBe(150)
  })

  // A client re-upload whose only difference is `costUsd` overwrites the stored cost. That is the
  // accepted semantic (native-usage-sources design D7, §9.4.1): the snapshot hash covers costUsd,
  // so a new cost IS a different measurement by the protocol's own definition, and the upsert that
  // the hash mismatch lets through writes `excluded.cost_usd`.
  //
  // The rule this replaced froze the stored cost whenever the token counts matched, on the theory
  // that a re-scan re-deriving the same counts should not adopt a newly published price. That left
  // the row inconsistent with itself: `snapshot_hash` was still assigned `excluded.snapshot_hash`,
  // so the stored hash described a payload that was never stored — `snapshotHash(stored) !==
  // snapshot_hash`. Anything that recomputes the hash from the row (a backfill, a repair script, a
  // future freshness check) would then read the row as never having been delivered, and a
  // price-table change would rewrite spend anyway as soon as the counts moved. D7 chose to accept
  // the overwrite rather than add a protection layer; the second assertion below is what keeps the
  // hash and the row from drifting apart again.
  test('a cost-only re-upload adopts the incoming cost and its hash', async () => {
    const { db, path } = createDb(tempDirs)
    const repriced = makeRecord({ costUsd: 0.34 })

    await upsertUsageSnapshots(db, [makeRecord({ costUsd: 0.12 })])
    await upsertUsageSnapshots(db, [repriced])

    expect(scalarText(path, 'SELECT cost_usd FROM daily_usage')).toBe('0.34')
    expect(scalarText(path, 'SELECT snapshot_hash FROM daily_usage')).toBe(await snapshotHash(repriced))
  })

  // The other half of the rule: a real re-measurement moves the token counts, so it is a new
  // measurement and its cost is the right one — otherwise a day that genuinely grew could never
  // report the spend it grew by.
  test('a changed token measurement adopts the incoming cost', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [makeRecord({ totalTokens: 165, inputTokens: 100, costUsd: 0.12 })])
    await upsertUsageSnapshots(db, [makeRecord({ totalTokens: 200, inputTokens: 135, costUsd: 0.34 })])

    expect(scalarText(path, 'SELECT cost_usd FROM daily_usage')).toBe('0.34')
  })

  // A correction row's tokens are always zero — that is what makes it a correction — while its
  // cost is not: it is the remainder the context-priced split left behind, and it moves whenever
  // the day grows or the split changes. So a correction's cost must follow every re-derive. With
  // the token-equality cost freeze gone this holds by construction, and the test stays as the pin
  // that a future shortcut keyed on token equality cannot come back and strand a correction on its
  // first value.
  //
  // `source: 'codex'` and the default `sessionCount: 2` are both load-bearing, not decoration: the
  // session-only preservation rule fires only on codex rows that report a positive session count,
  // so with the default claude-code source — or a zero session count — this fixture would pass
  // even if the rule started swallowing corrections.
  test('a second correction adopts the newly derived cost', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [
      makeRecord({
        source: 'codex',
        correction: 'codex-context-pricing',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.05
      })
    ])
    await upsertUsageSnapshots(db, [
      makeRecord({
        source: 'codex',
        correction: 'codex-context-pricing',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.03
      })
    ])

    expect(scalarText(path, 'SELECT cost_usd FROM daily_usage')).toBe('0.03')
  })

  // The sequence in one go: after the normal row is replaced, the first correction re-derives the
  // remainder and the second must too. What could still strand it is the session-only preservation
  // rule — a zero-token row over a row that has tokens is exactly what it guards — so its `? = 0`
  // correction exemption is what this pins. The correction's zero tokens replacing the re-measured
  // counts is its defined shape: the split moved those tokens to the context model's row, and the
  // canonical row keeps only the cost remainder.
  test('a correction after a re-measured row still adopts each new cost', async () => {
    const { db, path } = createDb(tempDirs)

    // All four are `codex` on purpose: the preservation rule only fires on that source, so a
    // claude-code fixture would pass whether or not the correction exemption exists.
    await upsertUsageSnapshots(db, [makeRecord({ source: 'codex', costUsd: 0.12 })])
    await upsertUsageSnapshots(db, [makeRecord({ source: 'codex', totalTokens: 200, inputTokens: 135, costUsd: 0.08 })])
    await upsertUsageSnapshots(db, [
      makeRecord({
        source: 'codex',
        correction: 'codex-context-pricing',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.05
      })
    ])
    await upsertUsageSnapshots(db, [
      makeRecord({
        source: 'codex',
        correction: 'codex-context-pricing',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.03
      })
    ])

    expect(scalarText(path, 'SELECT cost_usd FROM daily_usage')).toBe('0.03')
    expect(scalarText(path, 'SELECT total_tokens FROM daily_usage')).toBe('0')
    expect(scalarText(path, 'SELECT input_tokens FROM daily_usage')).toBe('0')
  })
  // The WHERE clause carries its own copy of the codex shapes, with `session_count = 0` where the
  // SET arms have `> 0`. That arm decides whether the row is touched at all; the SET arms only
  // decide what a permitted update writes. Both correction fixtures above use `sessionCount: 2`,
  // so they exercise the SET side; without a case here, deleting the WHERE arm would still pass.
  //
  // A token-less codex report that also reports no sessions, arriving over a row that has usage,
  // is rejected outright — the row does not even lose its session_count. That is the arm working:
  // the source has no tokens to report, so its report says nothing about this row's usage.
  test('a zero-session codex report leaves a populated row entirely untouched', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [makeRecord({ source: 'codex', costUsd: 0.12 })])
    await upsertUsageSnapshots(db, [
      makeRecord({
        source: 'codex',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.5,
        sessionCount: 0
      })
    ])

    expect(scalarText(path, 'SELECT total_tokens FROM daily_usage')).toBe('165')
    expect(scalarText(path, 'SELECT cost_usd FROM daily_usage')).toBe('0.12')
    expect(scalarText(path, 'SELECT session_count FROM daily_usage')).toBe('2')
  })
})

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

function createDb(tempDirs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-idem-'))
  tempDirs.push(dir)
  const path = join(dir, 'test.sqlite')
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  runSql(path, files.map((file) => `.read ${join(migrationsDir, file)}`).join('\n'))
  runSql(
    path,
    `
    INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
    VALUES ('seed-user','seed@example.com','Seed',0,'2026-01-01','2026-01-01');
    INSERT INTO profiles (user_id, slug, display_name, timezone, timezone_source, is_public, participates_in_leaderboards, created_at, updated_at)
    VALUES ('seed-user','seed','Seed','UTC','default',0,0,'2026-01-01','2026-01-01');
  `
  )
  return { path, db: createSqliteD1(path) }
}

function totalTokens(dbPath: string) {
  return scalar(dbPath, 'SELECT COALESCE(SUM(total_tokens), 0) FROM daily_usage')
}

function rowCount(dbPath: string) {
  return scalar(dbPath, 'SELECT COUNT(*) FROM daily_usage')
}

function scalar(dbPath: string, sql: string) {
  return Number(runSql(dbPath, sql).trim())
}

function scalarText(dbPath: string, sql: string) {
  return runSql(dbPath, sql).trim()
}
