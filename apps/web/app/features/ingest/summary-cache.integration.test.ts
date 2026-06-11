import { snapshotHashPayload } from '@tokenboard/usage-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import worker from '../../server'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { backfillUsageSummaryCache, upsertUsageSnapshots, type IngestRecord } from './repository'

const currentDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(currentDir, '../../../db/migrations')
const verificationDate = new Date('2026-06-02T10:00:00.000Z')

describe('usage summary cache integration', () => {
  const tempDirs: string[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(verificationDate)
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('scheduled backfill makes legacy usage visible through public JSON cache queries', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath)
    const today = toIsoDate(verificationDate)
    const monthStart = `${today.slice(0, 8)}01`
    const db = createSqliteD1(dbPath)
    const todayIncludesBothRows = today === monthStart
    const expectedTodayTokens = todayIncludesBothRows ? 1600 : 1000
    const expectedTodayTokensWithoutCacheRead = todayIncludesBothRows ? 1450 : 900
    const expectedTodayCostUsd = todayIncludesBothRows ? 2.5 : 1.25

    await seedLegacyUsage(db, { today, monthStart })
    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 0)
    await expectScalar(db, 'SELECT COUNT(*) FROM user_usage_totals', 0)

    const ctx = createExecutionContext()
    worker.scheduled?.(
      {
        scheduledTime: Date.parse(`${today}T10:00:00.000Z`),
        cron: '*/15 * * * *',
        noRetry() {}
      },
      createEnv(db),
      ctx
    )
    await Promise.all(ctx.waitUntilPromises)

    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 2)
    await expectScalar(
      db,
      'SELECT total_tokens AS value FROM user_usage_totals WHERE user_id = ?',
      1600,
      ['smoke-user']
    )

    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/smoke-user.json?cache-bust=summary-cache'),
      createEnv(db),
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      slug: 'smoke-user',
      displayName: 'Smoke User',
      total: {
        tokens: 1600,
        tokensWithoutCacheRead: 1450,
        costUsd: 2.5
      },
      today: {
        tokens: expectedTodayTokens,
        tokensWithoutCacheRead: expectedTodayTokensWithoutCacheRead,
        costUsd: expectedTodayCostUsd
      },
      month: {
        tokens: 1600,
        tokensWithoutCacheRead: 1450,
        costUsd: 2.5
      },
      sourceSplit: [
        {
          source: 'codex',
          totalTokens: 1000,
          totalTokensWithoutCacheRead: 900
        },
        {
          source: 'claude-code',
          totalTokens: 600,
          totalTokensWithoutCacheRead: 550
        }
      ],
      topModels: [
        {
          model: 'gpt-5',
          totalTokens: 1000,
          totalTokensWithoutCacheRead: 900,
          costUsd: 1.25
        },
        {
          model: 'claude-sonnet-4-5',
          totalTokens: 600,
          totalTokensWithoutCacheRead: 550,
          costUsd: 1.25
        }
      ]
    })
  })

  test('summary cache migration keeps historical usage visible before cron backfill', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath, false)
    const db = createSqliteD1(dbPath)
    const today = toIsoDate(verificationDate)
    const monthStart = `${today.slice(0, 8)}01`
    const todayIncludesBothRows = today === monthStart
    const expectedTodayTokens = todayIncludesBothRows ? 1600 : 1000
    const expectedTodayTokensWithoutCacheRead = todayIncludesBothRows ? 1450 : 900
    const expectedTodayCostUsd = todayIncludesBothRows ? 2.5 : 1.25

    await seedLegacyUsage(db, { today, monthStart })
    applySummaryCacheMigration(dbPath)

    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 0)
    await expectScalar(db, 'SELECT COUNT(*) FROM user_usage_totals', 0)

    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/smoke-user.json?cache-bust=migration'),
      createEnv(db),
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      total: {
        tokens: 1600,
        tokensWithoutCacheRead: 1450,
        costUsd: 2.5
      },
      today: {
        tokens: expectedTodayTokens,
        tokensWithoutCacheRead: expectedTodayTokensWithoutCacheRead,
        costUsd: expectedTodayCostUsd
      },
      month: {
        tokens: 1600,
        tokensWithoutCacheRead: 1450,
        costUsd: 2.5
      }
    })

    const ctx = createExecutionContext()
    worker.scheduled?.(
      {
        scheduledTime: Date.parse(`${today}T10:00:00.000Z`),
        cron: '*/15 * * * *',
        noRetry() {}
      },
      createEnv(db),
      ctx
    )
    await Promise.all(ctx.waitUntilPromises)

    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 2)
    await expectScalar(
      db,
      'SELECT total_tokens AS value FROM user_usage_totals WHERE user_id = ?',
      1600,
      ['smoke-user']
    )
  })

  test('strict summary mode does not read raw historical usage before cron backfill', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath, false)
    const db = createSqliteD1(dbPath)
    const today = toIsoDate(verificationDate)
    const monthStart = `${today.slice(0, 8)}01`

    await seedLegacyUsage(db, { today, monthStart })
    applySummaryCacheMigration(dbPath)
    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 0)

    const beforeBackfill = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/smoke-user.json?cache-bust=strict-before'),
      createEnv(db, { TOKENBOARD_USAGE_SUMMARY_STRICT: 'true' }),
      createExecutionContext()
    )

    expect(beforeBackfill.status).toBe(200)
    await expect(beforeBackfill.json()).resolves.toMatchObject({
      total: {
        tokens: 0,
        tokensWithoutCacheRead: 0,
        costUsd: 0
      },
      today: {
        tokens: 0,
        tokensWithoutCacheRead: 0,
        costUsd: 0
      },
      month: {
        tokens: 0,
        tokensWithoutCacheRead: 0,
        costUsd: 0
      }
    })

    const ctx = createExecutionContext()
    worker.scheduled?.(
      {
        scheduledTime: Date.parse(`${today}T10:00:00.000Z`),
        cron: '*/15 * * * *',
        noRetry() {}
      },
      createEnv(db),
      ctx
    )
    await Promise.all(ctx.waitUntilPromises)

    const afterBackfill = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/smoke-user.json?cache-bust=strict-after'),
      createEnv(db, { TOKENBOARD_USAGE_SUMMARY_STRICT: 'true' }),
      createExecutionContext()
    )

    expect(afterBackfill.status).toBe(200)
    await expect(afterBackfill.json()).resolves.toMatchObject({
      total: {
        tokens: 1600,
        tokensWithoutCacheRead: 1450,
        costUsd: 2.5
      },
      month: {
        tokens: 1600,
        tokensWithoutCacheRead: 1450,
        costUsd: 2.5
      }
    })
  })

  test('bounded summary backfill delays totals until all historical summaries are present', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath)
    const db = createSqliteD1(dbPath)
    const today = toIsoDate(verificationDate)
    const monthStart = `${today.slice(0, 8)}01`

    await seedLegacyUsage(db, { today, monthStart })

    const firstPass = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(firstPass).toEqual({ backfilled: 1, totalsRefreshed: 0 })
    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 1)
    await expectScalar(
      db,
      'SELECT COUNT(*) FROM user_usage_totals WHERE user_id = ?',
      0,
      ['smoke-user']
    )
    await expectScalar(
      db,
      'SELECT phase AS value FROM usage_summary_backfill_state WHERE id = ?',
      'summaries',
      ['initial']
    )

    const secondPass = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(secondPass).toEqual({ backfilled: 1, totalsRefreshed: 0 })
    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 2)
    await expectScalar(
      db,
      'SELECT COUNT(*) FROM user_usage_totals WHERE user_id = ?',
      0,
      ['smoke-user']
    )
    await expectScalar(
      db,
      'SELECT phase AS value FROM usage_summary_backfill_state WHERE id = ?',
      'totals',
      ['initial']
    )

    const thirdPass = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(thirdPass).toEqual({ backfilled: 0, totalsRefreshed: 1 })
    await expectScalar(
      db,
      'SELECT total_tokens AS value FROM user_usage_totals WHERE user_id = ?',
      1600,
      ['smoke-user']
    )
    await expectScalar(
      db,
      'SELECT total_tokens_without_cache_read AS value FROM user_usage_totals WHERE user_id = ?',
      1450,
      ['smoke-user']
    )
    await expectScalar(
      db,
      'SELECT completed_at IS NOT NULL AS value FROM usage_summary_backfill_state WHERE id = ?',
      1,
      ['initial']
    )
  })

  test('ingest does not write partial totals while summary backfill is incomplete', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath)
    const db = createSqliteD1(dbPath)
    const today = toIsoDate(verificationDate)
    const monthStart = `${today.slice(0, 8)}01`

    await seedLegacyUsage(db, { today, monthStart })
    await backfillUsageSummaryCache({ db, limit: 1 })
    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 1)
    await expectScalar(
      db,
      'SELECT phase AS value FROM usage_summary_backfill_state WHERE id = ?',
      'summaries',
      ['initial']
    )

    const syncResult = await upsertUsageSnapshots(db, [makeIngestRecord({ usageDate: today })])

    expect(syncResult).toEqual({ upserted: 1 })
    await expectScalar(
      db,
      'SELECT COUNT(*) FROM user_usage_totals WHERE user_id = ?',
      0,
      ['smoke-user']
    )
  })

  test('public totals ignore stale total rows after summary-only ingest refreshes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath)
    const db = createSqliteD1(dbPath)
    const today = toIsoDate(verificationDate)
    const monthStart = `${today.slice(0, 8)}01`

    await seedProfile(db)
    await insertStaleUserTotal(db)
    await markSummaryBackfillIncomplete(db)

    const syncResult = await upsertUsageSnapshots(db, [makeIngestRecord({ usageDate: today })])

    expect(syncResult).toEqual({ upserted: 1 })
    await expectScalar(
      db,
      'SELECT total_tokens AS value FROM user_usage_totals WHERE user_id = ?',
      100,
      ['smoke-user']
    )

    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/smoke-user.json?cache-bust=stale-total-row'),
      createEnv(db),
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      total: {
        tokens: 1000,
        tokensWithoutCacheRead: 900,
        costUsd: 1.25
      },
      today: {
        tokens: 1000,
        tokensWithoutCacheRead: 900,
        costUsd: 1.25
      },
      month: {
        tokens: 1000,
        tokensWithoutCacheRead: 900,
        costUsd: 1.25
      }
    })
  })

  test('summary backfill key scan uses the logical usage index', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath)
    const db = createSqliteD1(dbPath)
    const today = toIsoDate(verificationDate)
    const monthStart = `${today.slice(0, 8)}01`

    await seedLegacyUsage(db, { today, monthStart })

    const plan = explainQueryPlan(
      dbPath,
      `
        SELECT
          user_id as userId,
          usage_date as usageDate,
          source,
          model
        FROM daily_usage
        GROUP BY user_id, usage_date, source, model
        ORDER BY user_id ASC, usage_date ASC, source ASC, model ASC
        LIMIT ?
      `,
      '2'
    )

    expect(plan).toContain('USING COVERING INDEX daily_usage_logical_key_device_idx')
    expect(plan).not.toContain('USE TEMP B-TREE')
  })

  test('strict public summary plan avoids raw daily usage scans', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath)
    const plan = explainQueryPlan(
      dbPath,
      `
        WITH effective_daily_usage_summary AS (
          SELECT
            user_id,
            usage_date,
            source,
            model,
            timezone,
            input_tokens,
            output_tokens,
            cache_creation_tokens,
            cache_read_tokens,
            total_tokens,
            total_tokens_without_cache_read,
            cost_usd,
            session_count,
            updated_at
          FROM daily_usage_summary
          WHERE daily_usage_summary.user_id = ?
            AND daily_usage_summary.usage_date >= ?
        )
        SELECT COALESCE(SUM(total_tokens), 0) as value
        FROM effective_daily_usage_summary
      `,
      "'smoke-user'",
      "'2026-06-01'"
    )

    expect(plan).toContain('SEARCH daily_usage_summary USING INDEX sqlite_autoindex_daily_usage_summary_1')
    expect(plan).not.toContain('daily_usage_logical_key_device_idx')
    expect(plan).not.toMatch(/\bdaily_usage\b(?!_summary)/)
  })

  test('unchanged ingest retry repairs missing summary cache rows', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath)
    const db = createSqliteD1(dbPath)
    const today = toIsoDate(verificationDate)
    const snapshot = makeIngestRecord({ usageDate: today })

    await seedProfile(db)
    await insertRawUsage(db, snapshot)
    await markSummaryBackfillCompleted(db)
    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 0)
    await expectScalar(db, 'SELECT COUNT(*) FROM user_usage_totals', 0)

    const result = await upsertUsageSnapshots(db, [snapshot])

    expect(result).toEqual({ upserted: 0 })
    await expectScalar(db, 'SELECT total_tokens AS value FROM daily_usage_summary WHERE user_id = ?', 1000, ['smoke-user'])
    await expectScalar(db, 'SELECT total_tokens AS value FROM user_usage_totals WHERE user_id = ?', 1000, ['smoke-user'])

    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/smoke-user.json?cache-bust=unchanged-retry'),
      createEnv(db, { TOKENBOARD_USAGE_SUMMARY_STRICT: 'true' }),
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      total: {
        tokens: 1000,
        tokensWithoutCacheRead: 900,
        costUsd: 1.25
      },
      today: {
        tokens: 1000,
        tokensWithoutCacheRead: 900,
        costUsd: 1.25
      }
    })
  })

  test('webhook schedule migration backfills pending retry slots from the original daily schedule', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-webhook-schedule-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    runSql(dbPath, [
      `.read ${quoteSqlitePath(join(migrationsDir, '0000_initial.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0001_devices.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0002_upload_token_device.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0003_better_auth.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0013_webhook_notifications.sql'))}`,
      `
        INSERT INTO webhook_subscriptions (
          id,
          user_id,
          name,
          provider,
          webhook_url_encrypted,
          webhook_url_host,
          webhook_url_masked,
          timezone,
          schedule_time_local,
          next_run_at,
          pending_report_date,
          failure_count,
          created_at,
          updated_at
        )
        VALUES (
          'sub_retry',
          'seed-user',
          'Retry',
          'generic',
          'encrypted',
          'example.com',
          'https://example.com/webhook',
          'UTC',
          '09:30',
          '2026-04-29T10:05:00.000Z',
          '2026-04-29',
          1,
          '2026-04-29T09:31:00.000Z',
          '2026-04-29T09:31:00.000Z'
        );
      `,
      `.read ${quoteSqlitePath(join(migrationsDir, '0014_webhook_schedule_rules.sql'))}`
    ].join('\n'))

    const db = createSqliteD1(dbPath)

    await expectScalar(
      db,
      'SELECT pending_schedule_slot AS value FROM webhook_subscriptions WHERE id = ?',
      '2026-04-29T09:30',
      ['sub_retry']
    )
  })

  test('follow-up webhook migration repairs pending retry slots for databases that already ran 0014', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-webhook-schedule-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    runSql(dbPath, [
      `.read ${quoteSqlitePath(join(migrationsDir, '0000_initial.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0001_devices.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0002_upload_token_device.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0003_better_auth.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0013_webhook_notifications.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0014_webhook_schedule_rules.sql'))}`,
      `
        INSERT INTO webhook_subscriptions (
          id,
          user_id,
          name,
          provider,
          webhook_url_encrypted,
          webhook_url_host,
          webhook_url_masked,
          timezone,
          schedule_time_local,
          schedule_times_local,
          schedule_weekdays,
          next_run_at,
          pending_report_date,
          pending_schedule_slot,
          failure_count,
          created_at,
          updated_at
        )
        VALUES (
          'sub_old_0014',
          'seed-user',
          'Old 0014',
          'generic',
          'encrypted',
          'example.com',
          'https://example.com/webhook',
          'UTC',
          '09:30',
          '09:30,18:00',
          '0,1,2,3,4,5,6',
          '2026-04-29T10:05:00.000Z',
          '2026-04-29',
          NULL,
          1,
          '2026-04-29T09:31:00.000Z',
          '2026-04-29T09:31:00.000Z'
        );
      `,
      `.read ${quoteSqlitePath(join(migrationsDir, '0019_backfill_webhook_pending_schedule_slots.sql'))}`
    ].join('\n'))

    const db = createSqliteD1(dbPath)

    await expectScalar(
      db,
      'SELECT pending_schedule_slot AS value FROM webhook_subscriptions WHERE id = ?',
      '2026-04-29T09:30',
      ['sub_old_0014']
    )
  })
})

function applyMigrations(dbPath: string, includeSummaryCache = true) {
  const migrations = [
    `.read ${quoteSqlitePath(join(migrationsDir, '0000_initial.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0001_devices.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0002_upload_token_device.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0003_better_auth.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0004_daily_usage_device.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0005_leaderboard_public_profiles.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0006_default_public_leaderboards.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0007_daily_usage_snapshot_hash.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0008_dedupe_legacy_daily_usage.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0009_profile_timezone_source.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0010_default_utc_timezone_source.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0011_preserve_legacy_utc_timezone.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0012_public_card_config.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0013_webhook_notifications.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0014_webhook_schedule_rules.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0015_daily_report_history.sql'))}`
  ]
  if (includeSummaryCache) {
    migrations.push(summaryCacheMigrationCommand())
    migrations.push(refreshSummaryCacheMigrationCommand())
    migrations.push(summaryBackfillStateMigrationCommand())
  }
  migrations.push(
    `.read ${quoteSqlitePath(join(migrationsDir, '0019_backfill_webhook_pending_schedule_slots.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0020_daily_report_share_controls.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0021_api_rate_limits.sql'))}`
  )
  runSql(dbPath, migrations.join('\n'))
}

function applySummaryCacheMigration(dbPath: string) {
  runSql(dbPath, [
    summaryCacheMigrationCommand(),
    refreshSummaryCacheMigrationCommand(),
    summaryBackfillStateMigrationCommand()
  ].join('\n'))
}

function summaryCacheMigrationCommand() {
  return `.read ${quoteSqlitePath(join(migrationsDir, '0016_usage_summary_cache.sql'))}`
}

function refreshSummaryCacheMigrationCommand() {
  return `.read ${quoteSqlitePath(join(migrationsDir, '0017_refresh_usage_summary_cache.sql'))}`
}

function summaryBackfillStateMigrationCommand() {
  return `.read ${quoteSqlitePath(join(migrationsDir, '0018_usage_summary_backfill_state.sql'))}`
}

async function seedLegacyUsage(
  db: D1Database,
  dates: {
    today: string
    monthStart: string
  }
) {
  await db
    .prepare(
      `
        INSERT INTO users (id, email, name, image, created_at, updated_at, email_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'smoke-user',
      null,
      'Smoke User',
      null,
      '2026-04-28T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      0
    )
    .run()

  await db
    .prepare(
      `
        INSERT INTO profiles (
          user_id,
          slug,
          display_name,
          timezone,
          is_public,
          participates_in_leaderboards,
          created_at,
          updated_at,
          timezone_source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'smoke-user',
      'smoke-user',
      'Smoke User',
      'UTC',
      1,
      1,
      '2026-04-28T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      'user'
    )
    .run()

  await db
    .prepare(
      `
        INSERT INTO daily_usage (
          user_id,
          device_id,
          source,
          usage_date,
          timezone,
          model,
          input_tokens,
          output_tokens,
          cache_creation_tokens,
          cache_read_tokens,
          total_tokens,
          cost_usd,
          session_count,
          snapshot_hash,
          synced_at
        )
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'smoke-user',
      'legacy',
      'codex',
      dates.today,
      'UTC',
      'gpt-5',
      700,
      200,
      0,
      100,
      1000,
      1.25,
      3,
      null,
      '2026-04-29T10:00:00.000Z',
      'smoke-user',
      'legacy',
      'claude-code',
      dates.monthStart,
      'UTC',
      'claude-sonnet-4-5',
      400,
      150,
      0,
      50,
      600,
      1.25,
      2,
      null,
      '2026-04-29T10:00:00.000Z'
    )
    .run()
}

async function seedProfile(db: D1Database) {
  await db
    .prepare(
      `
        INSERT INTO users (id, email, name, image, created_at, updated_at, email_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'smoke-user',
      null,
      'Smoke User',
      null,
      '2026-04-28T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      0
    )
    .run()

  await db
    .prepare(
      `
        INSERT INTO profiles (
          user_id,
          slug,
          display_name,
          timezone,
          is_public,
          participates_in_leaderboards,
          created_at,
          updated_at,
          timezone_source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'smoke-user',
      'smoke-user',
      'Smoke User',
      'UTC',
      1,
      1,
      '2026-04-28T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      'user'
    )
    .run()
}

async function insertRawUsage(db: D1Database, record: IngestRecord) {
  await db
    .prepare(
      `
        INSERT INTO daily_usage (
          user_id,
          device_id,
          source,
          usage_date,
          timezone,
          model,
          input_tokens,
          output_tokens,
          cache_creation_tokens,
          cache_read_tokens,
          total_tokens,
          cost_usd,
          session_count,
          snapshot_hash,
          synced_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      record.userId,
      record.deviceId,
      record.source,
      record.usageDate,
      record.timezone,
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheCreationTokens,
      record.cacheReadTokens,
      record.totalTokens,
      record.costUsd,
      record.sessionCount,
      await hashSnapshot(record),
      record.collectedAt
    )
    .run()
}

async function markSummaryBackfillCompleted(db: D1Database) {
  await db
    .prepare(
      `
        INSERT INTO usage_summary_backfill_state (
          id,
          phase,
          cursor_user_id,
          cursor_usage_date,
          cursor_source,
          cursor_model,
          completed_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'initial',
      'totals',
      null,
      null,
      null,
      null,
      '2026-06-02T10:00:00.000Z',
      '2026-06-02T10:00:00.000Z'
    )
    .run()
}

async function markSummaryBackfillIncomplete(db: D1Database) {
  await db
    .prepare(
      `
        INSERT INTO usage_summary_backfill_state (
          id,
          phase,
          cursor_user_id,
          cursor_usage_date,
          cursor_source,
          cursor_model,
          completed_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'initial',
      'summaries',
      'seed',
      '2026-01-01',
      'codex',
      'seed-model',
      null,
      '2026-06-02T10:00:00.000Z'
    )
    .run()
}

async function insertStaleUserTotal(db: D1Database) {
  await db
    .prepare(
      `
        INSERT INTO user_usage_totals (
          user_id,
          total_tokens,
          total_tokens_without_cache_read,
          cost_usd,
          session_count,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'smoke-user',
      100,
      80,
      0.2,
      1,
      '2026-04-28T00:00:00.000Z'
    )
    .run()
}

async function hashSnapshot(record: IngestRecord) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(snapshotHashPayload(record))
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function makeIngestRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    userId: 'smoke-user',
    deviceId: 'dev_1',
    source: 'codex',
    usageDate: '2026-06-02',
    timezone: 'UTC',
    model: 'gpt-5',
    inputTokens: 700,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 100,
    totalTokens: 1000,
    costUsd: 1.25,
    sessionCount: 3,
    collectedAt: '2026-06-02T10:00:00.000Z',
    ...overrides
  }
}

async function expectScalar(
  db: D1Database,
  sql: string,
  expected: unknown,
  bindings: unknown[] = []
) {
  const row = await db.prepare(sql).bind(...bindings).first<{ value: unknown }>()
  expect(row?.value).toBe(expected)
}

function explainQueryPlan(
  dbPath: string,
  sql: string,
  ...bindings: string[]
) {
  const parameterCommands = bindings.map((value, index) => `.parameter set ?${index + 1} ${value}`)
  return runSql(dbPath, [
    '.parameter init',
    ...parameterCommands,
    `.eqp on`,
    sql
  ].join('\n'))
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function quoteSqlitePath(path: string) {
  return `'${path.replaceAll("'", "''")}'`
}

function createEnv(db: D1Database, overrides: Record<string, string | undefined> = {}) {
  return {
    DB: db,
    ASSETS: {
      fetch: async () => new Response('asset response')
    },
    BETTER_AUTH_URL: 'https://tokenboard.example',
    ...overrides
  }
}

function createExecutionContext() {
  const waitUntilPromises: Promise<unknown>[] = []
  return {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise)
    },
    passThroughOnException() {},
    props: {},
    waitUntilPromises
  } as ExecutionContext & { waitUntilPromises: Promise<unknown>[] }
}

function workerRequest(url: string) {
  return new Request(url) as Parameters<typeof worker.fetch>[0]
}
