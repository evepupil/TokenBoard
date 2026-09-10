import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const packageDir = dirname(fileURLToPath(import.meta.url))

describe('Wrangler deploy config', () => {
  test('standard deploy uses the deployment helper', () => {
    const pkg = JSON.parse(readPackageFile('package.json'))
    const deployScript = pkg.scripts.deploy

    expect(deployScript).toBe('node scripts/deploy.mjs')
  })

  test('tracked wrangler config stays production deploy ready', () => {
    const config = readPackageFile('wrangler.jsonc')
    const deploymentScript = readPackageFile('scripts/deploy.mjs')
    const productionCheckScript = readPackageFile('scripts/check-production-config.mjs')

    expect(config).not.toContain('<your-tokenboard-domain>')
    expect(config).toContain('"workers_dev": false')
    expect(config).toContain('"routes"')
    expect(config).toContain('"pattern": "tokenboard.chaosyn.com"')
    expect(config).toContain('"BETTER_AUTH_URL": "https://tokenboard.chaosyn.com"')
    expect(config).toContain('"TOKENBOARD_COLLECTOR_REPO_URL"')
    expect(config).toContain('"TOKENBOARD_COLLECTOR_REF"')
    expect(config).toContain('"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "30"')
    expect(config).toContain('"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "50"')
    expect(config).toContain('"TOKENBOARD_USAGE_SUMMARY_STRICT": "false"')
    expect(config).toContain('"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "90"')
    expect(config).toContain('"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "5"')
    expect(config).toContain('"TOKENBOARD_MODEL_PRICING_SYNC_ENABLED": "true"')
    expect(config).toContain('"TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS": "24"')
    expect(config).toContain('"TOKENBOARD_MODEL_PRICING_SOURCE_URL": "https://models.dev/api.json"')
    expect(config).toContain('"database_id": "4af5cf99-10d9-4114-b707-f82e75f89746"')
    expect(config).toContain('"binding": "ASSETS"')
    expect(config).toContain('"run_worker_first"')
    expect(config).toContain('"run_worker_first": true')
    expect(deploymentScript).toContain('TOKENBOARD_WRANGLER_CONFIG')
    expect(deploymentScript).toContain('wrangler.production.jsonc')
    expect(deploymentScript).toContain('wrangler.production.ci.jsonc')
    expect(deploymentScript).toContain('scripts/write-production-config.mjs')
    expect(deploymentScript).toContain('scripts/check-production-config.mjs')
    expect(deploymentScript).toContain("runPnpm(['run', 'build'])")
    expect(deploymentScript).toContain("process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'")
    expect(deploymentScript).toContain("'d1', 'migrations', 'apply', 'DB'")
    expect(deploymentScript).toContain("'deploy', '--config'")
    expect(productionCheckScript).toContain("|| 'wrangler.production.jsonc'")
    expect(productionCheckScript).not.toContain("|| 'wrangler.jsonc'")
  })

  test('tracked production example documents required deploy fields without private values', () => {
    const example = readPackageFile('wrangler.production.example.jsonc')

    expect(example).toContain('"workers_dev": false')
    expect(example).toContain('"routes"')
    expect(example).toContain('"triggers"')
    expect(example).toContain('"*/15 * * * *"')
    expect(example).toContain('"binding": "ASSETS"')
    expect(example).toContain('"run_worker_first"')
    expect(example).toContain('"run_worker_first": true')
    expect(example).toContain('"BETTER_AUTH_URL": "https://<your-tokenboard-domain>"')
    expect(example).toContain('"TOKENBOARD_COLLECTOR_REPO_URL": "<tokenboard-collector-repo-url>"')
    expect(example).toContain('"TOKENBOARD_COLLECTOR_REF": "<tokenboard-collector-ref>"')
    expect(example).toContain('"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "<tokenboard-daily-report-history-days>"')
    expect(example).toContain('"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "<tokenboard-usage-summary-backfill-limit>"')
    expect(example).toContain('"TOKENBOARD_USAGE_SUMMARY_STRICT": "<tokenboard-usage-summary-strict>"')
    expect(example).toContain('"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "<tokenboard-webhook-log-retention-days>"')
    expect(example).toContain('"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "<tokenboard-webhook-cron-batch-size>"')
    expect(example).toContain('"TOKENBOARD_MODEL_PRICING_SYNC_ENABLED": "true"')
    expect(example).toContain('"TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS": "24"')
    const sourceUrl = /"TOKENBOARD_MODEL_PRICING_SOURCE_URL"\s*:\s*"([^"]+)"/.exec(example)?.[1]
    expect(sourceUrl).toBe('https://models.dev/api.json')
    expect(example).toContain('"database_id": "<your-d1-database-id>"')
    expect(example).not.toMatch(/"pattern":\s*"[a-z0-9.-]+\.[a-z]{2,}"/i)
    expect(example).not.toMatch(/"database_id":\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i)
  })

  test('manual production deploy helper verifies migrated schema before Worker deploy', () => {
    const deployScript = readPackageFile('scripts/deploy.mjs')
    const schemaCheckCommand = /runPnpm\(\[\s*'exec',\s*'wrangler',\s*'d1',\s*'execute'/
    const schemaCheckIndex = deployScript.search(schemaCheckCommand)

    expect(deployScript).toContain('wrangler.production.ci.jsonc')
    expect(deployScript).toContain('scripts/write-production-config.mjs')
    expect(deployScript).toContain('scripts/check-production-config.mjs')
    expect(deployScript).toContain("runPnpm(['run', 'build'])")
    expect(deployScript).toContain("'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath")
    expect(schemaCheckIndex).toBeGreaterThan(-1)
    expect(deployScript).toContain("'deploy', '--config', configPath")
    expect(deployScript.indexOf("runPnpm(['run', 'build'])")).toBeLessThan(
      deployScript.indexOf("'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath")
    )
    expect(deployScript.indexOf("'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath")).toBeLessThan(
      schemaCheckIndex
    )
    expect(schemaCheckIndex).toBeLessThan(deployScript.indexOf("'deploy', '--config', configPath"))
    expect(deployScript).not.toContain('--config wrangler.jsonc')
  })

  test('critical production schema check covers device identity and legacy upload tokens', () => {
    const schemaCheckPath = resolve(packageDir, 'db/verify-critical-schema.sql')

    expect(existsSync(schemaCheckPath)).toBe(true)
    if (!existsSync(schemaCheckPath)) return

    const schemaCheck = readFileSync(schemaCheckPath, 'utf8')
    expect(schemaCheck).toContain('FROM upload_tokens')
    expect(schemaCheck).toContain('upload_tokens.installation_id')
    expect(schemaCheck).toContain('FROM device_installations')
    expect(schemaCheck).toContain('install_claim_hash')
    expect(schemaCheck).toContain('installation_id')
    expect(schemaCheck).toContain('supersedes_token_id')
    expect(schemaCheck).toContain('FROM pairing_codes')
    expect(schemaCheck).toContain('pairing_type')
    expect(schemaCheck).toContain('FROM audit_logs')
  })

  test('critical production schema check rejects pre-device schema and accepts current migrations', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-schema-gate-'))
    const legacyDb = join(tempDir, 'legacy.db')
    const currentDb = join(tempDir, 'current.db')
    const migrationsDir = resolve(packageDir, 'db/migrations')
    const schemaCheck = readPackageFile('db/verify-critical-schema.sql')
    const migrations = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()

    try {
      for (const migration of migrations) {
        const sql = readFileSync(join(migrationsDir, migration), 'utf8')
        if (migration < '0022_') runSqlite(legacyDb, sql)
        runSqlite(currentDb, sql)
      }

      const legacyCheck = runSqlite(legacyDb, schemaCheck, false)
      expect(legacyCheck.status).not.toBe(0)
      expect(legacyCheck.stderr).toMatch(/installation_id|device_installations/)

      const currentCheck = runSqlite(currentDb, schemaCheck, false)
      expect(currentCheck.status).toBe(0)
      expect(currentCheck.stderr).toBe('')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('model pricing migrations add the staged catalogue schema before the critical gate', () => {
    const migrationsDir = resolve(packageDir, 'db/migrations')
    const baseMigration = readFileSync(join(migrationsDir, '0030_model_pricing.sql'), 'utf8')
    const stagingMigration = readFileSync(join(migrationsDir, '0031_model_pricing_staging.sql'), 'utf8')
    const schemaCheck = readPackageFile('db/verify-critical-schema.sql')
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-migration-gate-'))
    const dbPath = join(tempDir, 'pricing.db')

    try {
      for (const migration of readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql') && name < '0030_model_pricing.sql')
        .sort()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }
      runSqlite(dbPath, baseMigration)
      const preStagingCheck = runSqlite(dbPath, schemaCheck, false)
      expect(preStagingCheck.status).not.toBe(0)
      expect(preStagingCheck.stderr).toMatch(/model_pricing_staging/)

      runSqlite(dbPath, stagingMigration)
      const currentCheck = runSqlite(dbPath, schemaCheck, false)
      expect(currentCheck.status).toBe(0)
      expect(currentCheck.stderr).toBe('')

      // The staging migration contains only CREATE IF NOT EXISTS statements,
      // so a retry after an interrupted deployment must remain safe.
      expect(() => runSqlite(dbPath, stagingMigration)).not.toThrow()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('model pricing migration indexes stay aligned with the Drizzle schema', () => {
    const baseMigration = readPackageFile('db/migrations/0030_model_pricing.sql')
    const schema = readDrizzleSchema()

    expect(baseMigration).toContain('model_pricing_active_generation_idx')
    expect(schema).toContain("index('model_pricing_active_generation_idx')")
  })

  test('Drizzle schema declares webhook migration indexes', () => {
    const schema = readDrizzleSchema()

    expect(schema).toContain("index('webhook_subscriptions_user_idx')")
    expect(schema).toContain("index('webhook_subscriptions_due_idx')")
    expect(schema).toContain("index('webhook_delivery_logs_subscription_idx')")
    expect(schema).toContain("index('webhook_delivery_logs_created_idx')")
    expect(schema).toContain("uniqueIndex('webhook_delivery_logs_daily_success_idx')")
    expect(schema).toContain('.on(table.subscriptionId, table.reportDate, table.kind, table.scheduleSlot)')
    expect(schema).toContain("= 'success' AND")
    expect(schema).toContain("= 'daily'")
    expect(schema).toContain('table.scheduleSlot} IS NOT NULL')
  })

  test('Drizzle schema declares daily report history table and indexes', () => {
    const schema = readDrizzleSchema()

    expect(schema).toContain("'daily_report_history'")
    expect(schema).toContain('dailyReportShareEnabled')
    expect(schema).toContain('shareRevokedAt')
    expect(schema).toContain("uniqueIndex('daily_report_history_user_date_slot_idx')")
    expect(schema).toContain("index('daily_report_history_user_generated_idx')")
    expect(schema).toContain("index('daily_report_history_report_date_idx')")
    expect(schema).toContain('dailyReportHistory')
  })

  test('Drizzle schema declares usage summary cache tables', () => {
    const schema = readDrizzleSchema()

    expect(schema).toContain("'daily_usage_summary'")
    expect(schema).toContain("'user_usage_totals'")
    expect(schema).toContain("'usage_summary_backfill_state'")
    expect(schema).toContain("index('daily_usage_logical_key_device_idx')")
    expect(schema).toContain("index('daily_usage_summary_date_user_idx')")
    expect(schema).toContain('dailyUsageSummary')
    expect(schema).toContain('userUsageTotals')
    expect(schema).toContain('usageSummaryBackfillState')
  })

  test('webhook schedule migration backfills schedule slots before rebuilding the daily success index', () => {
    const migration = readPackageFile('db/migrations/0014_webhook_schedule_rules.sql')
    const followUpMigration = readPackageFile('db/migrations/0019_backfill_webhook_pending_schedule_slots.sql')

    expect(migration).toContain("ADD COLUMN schedule_times_local TEXT NOT NULL DEFAULT '18:00'")
    expect(migration).toContain("ADD COLUMN schedule_weekdays TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6'")
    expect(migration).toContain('ADD COLUMN schedule_slot TEXT')
    expect(migration).toContain('SET schedule_times_local = schedule_time_local')
    expect(migration).toContain(
      "SET pending_schedule_slot = pending_report_date || 'T' || COALESCE(schedule_time_local, '18:00')"
    )
    expect(migration).toContain('WHERE pending_report_date IS NOT NULL')
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS webhook_delivery_logs_subscription_idx')
    expect(migration).toContain("SET schedule_slot = report_date || 'T' || COALESCE((")
    expect(migration).toContain("), '18:00')")
    expect(migration).toContain('webhook_subscriptions.schedule_time_local')
    expect(migration).toContain('ON webhook_delivery_logs(subscription_id, report_date, kind, schedule_slot)')
    expect(migration).toContain("WHERE status = 'success' AND kind = 'daily' AND schedule_slot IS NOT NULL")
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS webhook_delivery_logs_created_idx')
    expect(migration).toContain('ON webhook_delivery_logs(created_at)')

    expect(migration.indexOf('ADD COLUMN schedule_slot TEXT')).toBeLessThan(
      migration.indexOf("SET schedule_slot = report_date || 'T' || COALESCE((")
    )
    expect(migration.indexOf('ADD COLUMN pending_schedule_slot TEXT')).toBeLessThan(
      migration.indexOf(
        "SET pending_schedule_slot = pending_report_date || 'T' || COALESCE(schedule_time_local, '18:00')"
      )
    )
    expect(migration.indexOf("SET schedule_slot = report_date || 'T' || COALESCE((")).toBeLessThan(
      migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_logs_daily_success_idx')
    )
    expect(followUpMigration).toContain('UPDATE webhook_subscriptions')
    expect(followUpMigration).toContain('SET pending_schedule_slot = pending_report_date')
    expect(followUpMigration).toContain('WHERE pending_report_date IS NOT NULL')
    expect(followUpMigration).toContain('AND pending_schedule_slot IS NULL')
  })

  test('daily report history migration creates the snapshot table and retention indexes', () => {
    const migration = readPackageFile('db/migrations/0015_daily_report_history.sql')

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS daily_report_history')
    expect(migration).toContain('user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE')
    expect(migration).toContain('report_date TEXT NOT NULL')
    expect(migration).toContain('schedule_slot TEXT NOT NULL')
    expect(migration).toContain('source_split TEXT NOT NULL')
    expect(migration).toContain('top_models TEXT NOT NULL')
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS daily_report_history_user_date_slot_idx')
    expect(migration).toContain('ON daily_report_history(user_id, report_date, schedule_slot)')
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS daily_report_history_user_generated_idx')
    expect(migration).toContain('ON daily_report_history(user_id, generated_at)')
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS daily_report_history_report_date_idx')
    expect(migration).toContain('ON daily_report_history(report_date)')
  })

  test('daily report share migration adds owner-controlled public access fields', () => {
    const migration = readPackageFile('db/migrations/0020_daily_report_share_controls.sql')

    expect(migration).toContain('ALTER TABLE profiles')
    expect(migration).toContain('ADD COLUMN daily_report_share_enabled INTEGER NOT NULL DEFAULT 0')
    expect(migration).toContain('ALTER TABLE daily_report_history')
    expect(migration).toContain('ADD COLUMN share_revoked_at TEXT')
  })

  test('rate limit migration creates a fixed-window state table', () => {
    const migration = readPackageFile('db/migrations/0021_api_rate_limits.sql')

    expect(migration).toContain('CREATE TABLE api_rate_limits')
    expect(migration).toContain('key TEXT PRIMARY KEY NOT NULL')
    expect(migration).toContain('count INTEGER NOT NULL DEFAULT 0')
    expect(migration).toContain('reset_at TEXT NOT NULL')
    expect(migration).toContain('updated_at TEXT NOT NULL')
    expect(migration).toContain('CREATE INDEX api_rate_limits_reset_idx')
  })

  test('device token rotation migration prevents duplicate active successors', () => {
    const schema = readDrizzleSchema()
    const migration = readPackageFile('db/migrations/0024_upload_token_active_successor.sql')

    expect(schema).toContain("uniqueIndex('upload_tokens_active_successor_idx')")
    expect(schema).toContain('table.supersedesTokenId} IS NOT NULL')
    expect(schema).toContain('table.revokedAt} IS NULL')
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS upload_tokens_active_successor_idx')
    expect(migration).toContain('ON upload_tokens(supersedes_token_id)')
    expect(migration).toContain('supersedes_token_id IS NOT NULL')
    expect(migration).toContain('revoked_at IS NULL')
  })

  test('upload token user lookup migration adds the matching schema index', () => {
    const schema = readDrizzleSchema()
    const migration = readPackageFile('db/migrations/0026_upload_tokens_user_id.sql')

    expect(schema).toContain("index('upload_tokens_user_id_idx').on(table.userId)")
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS upload_tokens_user_id_idx')
    expect(migration).toContain('ON upload_tokens(user_id)')
  })

  test('usage summary migration creates cache tables without blocking backfill work', () => {
    const migration = readPackageFile('db/migrations/0016_usage_summary_cache.sql')
    const refreshMigration = readPackageFile('db/migrations/0017_refresh_usage_summary_cache.sql')
    const stateMigration = readPackageFile('db/migrations/0018_usage_summary_backfill_state.sql')

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS daily_usage_summary')
    expect(migration).toContain('PRIMARY KEY (user_id, usage_date, source, model)')
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS daily_usage_summary_date_user_idx')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS user_usage_totals')
    expect(migration).not.toContain('INSERT INTO daily_usage_summary')
    expect(migration).not.toContain('INSERT INTO user_usage_totals')
    expect(refreshMigration).toContain('Historical usage is backfilled by the scheduled Worker job')
    expect(refreshMigration).not.toContain('INSERT INTO daily_usage_summary')
    expect(refreshMigration).not.toContain('INSERT INTO user_usage_totals')
    expect(stateMigration).toContain('CREATE TABLE IF NOT EXISTS usage_summary_backfill_state')
    expect(stateMigration).toContain('cursor_user_id TEXT')
    expect(stateMigration).toContain('Historical usage is backfilled by the scheduled Worker job with a bounded cursor')
  })

  test('production config generator replaces placeholders from CI environment', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-wrangler-'))
    const outputFile = join(tempDir, 'wrangler.production.ci.jsonc')

    try {
      const result = spawnSync(
        process.execPath,
        [resolve(packageDir, 'scripts/write-production-config.mjs'), 'wrangler.production.example.jsonc', outputFile],
        {
          cwd: packageDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKENBOARD_WORKER_ROUTE: 'tokenboard.example.com',
            BETTER_AUTH_URL: 'https://tokenboard.example.com',
            TOKENBOARD_COLLECTOR_REPO_URL: 'https://github.com/MisonL/TokenBoard.git',
            TOKENBOARD_COLLECTOR_REF: 'master',
            D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
          }
        }
      )

      expect(result.status).toBe(0)

      const generated = readFileSync(outputFile, 'utf8')
      expect(generated).toContain('"pattern": "tokenboard.example.com"')
      expect(generated).toContain('"BETTER_AUTH_URL": "https://tokenboard.example.com"')
      expect(generated).toContain('"TOKENBOARD_COLLECTOR_REPO_URL": "https://github.com/MisonL/TokenBoard.git"')
      expect(generated).toContain('"TOKENBOARD_COLLECTOR_REF": "master"')
      expect(generated).toContain('"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "30"')
      expect(generated).toContain('"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "50"')
      expect(generated).toContain('"TOKENBOARD_USAGE_SUMMARY_STRICT": "false"')
      expect(generated).toContain('"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "90"')
      expect(generated).toContain('"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "5"')
      expect(generated).toContain('"database_id": "11111111-1111-4111-8111-111111111111"')
      expect(generated).not.toContain('<your-tokenboard-domain>')
      expect(generated).not.toContain('<your-d1-database-id>')
      expect(generated).not.toContain('<tokenboard-daily-report-history-days>')
      expect(generated).not.toContain('<tokenboard-usage-summary-backfill-limit>')
      expect(generated).not.toContain('<tokenboard-usage-summary-strict>')
      expect(generated).not.toContain('<tokenboard-webhook-log-retention-days>')
      expect(generated).not.toContain('<tokenboard-webhook-cron-batch-size>')

      const checkResult = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: outputFile
        }
      })
      expect(checkResult.status).toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config generator honors CI resource control variables', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-wrangler-'))
    const outputFile = join(tempDir, 'wrangler.production.ci.jsonc')

    try {
      const result = spawnSync(
        process.execPath,
        [resolve(packageDir, 'scripts/write-production-config.mjs'), 'wrangler.production.example.jsonc', outputFile],
        {
          cwd: packageDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKENBOARD_WORKER_ROUTE: 'tokenboard.example.com',
            BETTER_AUTH_URL: 'https://tokenboard.example.com',
            TOKENBOARD_COLLECTOR_REPO_URL: 'https://github.com/MisonL/TokenBoard.git',
            TOKENBOARD_COLLECTOR_REF: 'research/agy-token-support-plan',
            TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '14',
            TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT: '25',
            TOKENBOARD_USAGE_SUMMARY_STRICT: 'true',
            TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS: '120',
            TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE: '4',
            D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
          }
        }
      )

      expect(result.status).toBe(0)

      const generated = readFileSync(outputFile, 'utf8')
      expect(generated).toContain('"TOKENBOARD_COLLECTOR_REPO_URL": "https://github.com/MisonL/TokenBoard.git"')
      expect(generated).toContain('"TOKENBOARD_COLLECTOR_REF": "research/agy-token-support-plan"')
      expect(generated).toContain('"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "14"')
      expect(generated).toContain('"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "25"')
      expect(generated).toContain('"TOKENBOARD_USAGE_SUMMARY_STRICT": "true"')
      expect(generated).toContain('"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "120"')
      expect(generated).toContain('"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "4"')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config generator rejects invalid resource control variables', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-wrangler-'))

    try {
      for (const [name, value, message] of [
        [
          'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS',
          '0',
          'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS must be an integer from 1 to 31'
        ],
        [
          'TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT',
          '501',
          'TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to 500'
        ],
        ['TOKENBOARD_USAGE_SUMMARY_STRICT', 'yes', 'TOKENBOARD_USAGE_SUMMARY_STRICT must be true, false, 1, or 0'],
        [
          'TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS',
          '366',
          'TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS must be an integer from 1 to 365'
        ],
        [
          'TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE',
          '6',
          'TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE must be an integer from 1 to 5'
        ],
        [
          'TOKENBOARD_COLLECTOR_REPO_URL',
          'https://example.com/TokenBoard.git',
          'TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL'
        ],
        [
          'TOKENBOARD_COLLECTOR_REPO_URL',
          'https://secret@github.com/MisonL/TokenBoard.git',
          'TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL'
        ],
        [
          'TOKENBOARD_COLLECTOR_REPO_URL',
          'https://github.com:8443/MisonL/TokenBoard.git',
          'TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL'
        ],
        ['TOKENBOARD_COLLECTOR_REF', 'bad ref', 'TOKENBOARD_COLLECTOR_REF must be a non-empty branch or ref name']
      ]) {
        const outputFile = join(tempDir, `wrangler.production.${name}.jsonc`)
        const result = spawnSync(
          process.execPath,
          [resolve(packageDir, 'scripts/write-production-config.mjs'), 'wrangler.production.example.jsonc', outputFile],
          {
            cwd: packageDir,
            encoding: 'utf8',
            env: {
              ...process.env,
              TOKENBOARD_WORKER_ROUTE: 'tokenboard.example.com',
              BETTER_AUTH_URL: 'https://tokenboard.example.com',
              TOKENBOARD_COLLECTOR_REPO_URL: 'https://github.com/MisonL/TokenBoard.git',
              TOKENBOARD_COLLECTOR_REF: 'master',
              TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '30',
              TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT: '50',
              TOKENBOARD_USAGE_SUMMARY_STRICT: 'false',
              TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS: '90',
              TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE: '5',
              D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
              [name]: value
            }
          }
        )

        expect(result.status).toBe(1)
        expect(result.stderr).toContain(message)
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 15000)

  test('production config checker rejects unreplaced resource control placeholders', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-retention-placeholder-config-'))
    const outputFile = join(tempDir, 'wrangler.production.retention-placeholder.jsonc')

    try {
      const content = readPackageFile('wrangler.production.example.jsonc')
        .replace('"pattern": "<your-tokenboard-domain>"', '"pattern": "tokenboard.example.com"')
        .replace(
          '"BETTER_AUTH_URL": "https://<your-tokenboard-domain>"',
          '"BETTER_AUTH_URL": "https://tokenboard.example.com"'
        )
        .replace(
          '"TOKENBOARD_COLLECTOR_REPO_URL": "<tokenboard-collector-repo-url>"',
          '"TOKENBOARD_COLLECTOR_REPO_URL": "https://github.com/MisonL/TokenBoard.git"'
        )
        .replace('"TOKENBOARD_COLLECTOR_REF": "<tokenboard-collector-ref>"', '"TOKENBOARD_COLLECTOR_REF": "master"')
        .replace('"database_id": "<your-d1-database-id>"', '"database_id": "11111111-1111-4111-8111-111111111111"')
      writeFileSync(outputFile, content)

      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: outputFile
        }
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('still contains placeholder values')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker rejects invalid resource control variables', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-bad-retention-config-'))

    try {
      for (const [name, value, message] of [
        [
          'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS',
          'abc',
          'vars.TOKENBOARD_DAILY_REPORT_HISTORY_DAYS must be an integer from 1 to 31'
        ],
        [
          'TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT',
          '501',
          'vars.TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to 500'
        ],
        ['TOKENBOARD_USAGE_SUMMARY_STRICT', 'yes', 'vars.TOKENBOARD_USAGE_SUMMARY_STRICT must be true, false, 1, or 0'],
        [
          'TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS',
          '366',
          'vars.TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS must be an integer from 1 to 365'
        ],
        [
          'TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE',
          '6',
          'vars.TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE must be an integer from 1 to 5'
        ],
        [
          'TOKENBOARD_MODEL_PRICING_SOURCE_URL',
          'https://example.com/api.json',
          'vars.TOKENBOARD_MODEL_PRICING_SOURCE_URL must be https://models.dev/api.json'
        ],
        [
          'TOKENBOARD_MODEL_PRICING_SOURCE_URL',
          'https://user:pass@models.dev/api.json',
          'vars.TOKENBOARD_MODEL_PRICING_SOURCE_URL must be https://models.dev/api.json'
        ],
        [
          'TOKENBOARD_MODEL_PRICING_SOURCE_URL',
          'https://models.dev:8443/api.json',
          'vars.TOKENBOARD_MODEL_PRICING_SOURCE_URL must be https://models.dev/api.json'
        ],
        [
          'TOKENBOARD_MODEL_PRICING_SOURCE_URL',
          'https://models.dev:443/api.json',
          'vars.TOKENBOARD_MODEL_PRICING_SOURCE_URL must be https://models.dev/api.json'
        ],
        [
          'TOKENBOARD_MODEL_PRICING_SOURCE_URL',
          'https://models.dev:0443/api.json',
          'vars.TOKENBOARD_MODEL_PRICING_SOURCE_URL must be https://models.dev/api.json'
        ],
        [
          'TOKENBOARD_COLLECTOR_REPO_URL',
          'https://example.com/TokenBoard.git',
          'vars.TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL'
        ],
        [
          'TOKENBOARD_COLLECTOR_REPO_URL',
          'https://secret@github.com/MisonL/TokenBoard.git',
          'vars.TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL'
        ],
        [
          'TOKENBOARD_COLLECTOR_REPO_URL',
          'https://github.com:8443/MisonL/TokenBoard.git',
          'vars.TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL'
        ],
        ['TOKENBOARD_COLLECTOR_REF', 'bad ref', 'vars.TOKENBOARD_COLLECTOR_REF must be a non-empty branch or ref name']
      ]) {
        const outputFile = join(tempDir, `wrangler.production.${name}.jsonc`)
        const content = filledProductionExample().replace(
          `"${name}": "${resourceControlDefault(name)}"`,
          `"${name}": "${value}"`
        )
        writeFileSync(outputFile, content)

        const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
          cwd: packageDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKENBOARD_WRANGLER_CONFIG: outputFile
          }
        })

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(message)
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 15000)

  test('deploy helper generates production config for clean Cloudflare builds', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-clean-deploy-'))
    const scriptDir = join(tempDir, 'scripts')
    const pnpmStub = join(tempDir, 'pnpm-stub.mjs')

    try {
      mkdirSync(scriptDir)
      copyFileSync(resolve(packageDir, 'scripts/deploy.mjs'), join(scriptDir, 'deploy.mjs'))
      copyFileSync(
        resolve(packageDir, 'scripts/check-production-config.mjs'),
        join(scriptDir, 'check-production-config.mjs')
      )
      copyFileSync(
        resolve(packageDir, 'scripts/write-production-config.mjs'),
        join(scriptDir, 'write-production-config.mjs')
      )
      copyFileSync(
        resolve(packageDir, 'wrangler.production.example.jsonc'),
        join(tempDir, 'wrangler.production.example.jsonc')
      )
      writeFileSync(pnpmStub, 'process.exit(0)\n')

      const result = spawnSync(process.execPath, ['scripts/deploy.mjs'], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_PNPM_CLI: pnpmStub,
          TOKENBOARD_WORKER_ROUTE: 'tokenboard.example.com',
          BETTER_AUTH_URL: 'https://tokenboard.example.com',
          TOKENBOARD_COLLECTOR_REPO_URL: 'https://github.com/MisonL/TokenBoard.git',
          TOKENBOARD_COLLECTOR_REF: 'master',
          TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7',
          TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT: '20',
          TOKENBOARD_USAGE_SUMMARY_STRICT: '1',
          TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS: '45',
          TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE: '3',
          D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
        }
      })

      expect(result.status, result.stderr || result.stdout).toBe(0)

      const generated = readFileSync(join(tempDir, 'wrangler.production.ci.jsonc'), 'utf8')
      expect(generated).toContain('"pattern": "tokenboard.example.com"')
      expect(generated).toContain('"BETTER_AUTH_URL": "https://tokenboard.example.com"')
      expect(generated).toContain('"TOKENBOARD_COLLECTOR_REPO_URL": "https://github.com/MisonL/TokenBoard.git"')
      expect(generated).toContain('"TOKENBOARD_COLLECTOR_REF": "master"')
      expect(generated).toContain('"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "7"')
      expect(generated).toContain('"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "20"')
      expect(generated).toContain('"TOKENBOARD_USAGE_SUMMARY_STRICT": "true"')
      expect(generated).toContain('"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "45"')
      expect(generated).toContain('"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "3"')
      expect(generated).toContain('"database_id": "11111111-1111-4111-8111-111111111111"')
      expect(result.stderr).toBe('')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker defaults to the private production config path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-empty-config-'))

    try {
      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: ''
        }
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('wrangler.production.jsonc')
      expect(result.stderr).not.toContain('wrangler.jsonc')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker rejects a local preview Wrangler config', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-local-preview-config-'))
    const localConfig = join(tempDir, 'wrangler.local.jsonc')

    try {
      writeFileSync(
        localConfig,
        `
        {
          "name": "tokenboard",
          "main": "./dist/index.js",
          "vars": {
            "BETTER_AUTH_URL": "http://localhost:8787"
          },
          "d1_databases": [
            {
              "binding": "DB",
              "database_name": "tokenboard",
              "database_id": "local-tokenboard-dev"
            }
          ]
        }
      `
      )

      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: localConfig
        }
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`${localConfig} is missing workers_dev: false`)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker rejects production config without cron triggers', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-no-cron-config-'))
    const outputFile = join(tempDir, 'wrangler.production.no-cron.jsonc')

    try {
      const content = filledProductionExample().replace(
        /\s+"triggers":\s*\{\s*"crons":\s*\[\s*"\*\/15 \* \* \* \*"\s*\]\s*\},/,
        ''
      )
      writeFileSync(outputFile, content)

      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: outputFile
        }
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('triggers.crons')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker accepts a missing model pricing source URL because the runtime has a safe default', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-default-model-pricing-source-'))
    const outputFile = join(tempDir, 'wrangler.production.default-model-pricing-source.jsonc')

    try {
      const content = filledProductionExample().replace(/\s+"TOKENBOARD_MODEL_PRICING_SOURCE_URL":\s*"[^"]+",?\n/, '')
      writeFileSync(outputFile, content)

      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: outputFile
        }
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker rejects production config without worker-first assets binding', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-no-worker-first-config-'))
    const outputFile = join(tempDir, 'wrangler.production.no-worker-first.jsonc')

    try {
      const content = filledProductionExample()
        .replace(/,\s*"run_worker_first":\s*true/, '')
        .replace(/,\s*"binding":\s*"ASSETS"/, '')
      writeFileSync(outputFile, content)

      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: outputFile
        }
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('assets.binding')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config tooling rejects route values that are not bare hosts', () => {
    for (const badRoute of [
      'tokenboard.example.com/path',
      'tokenboard.example.com?bad=1',
      'tokenboard.example.com#hash',
      '127.1',
      '192.168.1',
      '169.254.1',
      '0x7f.0.0.1',
      '0177.0.0.1'
    ]) {
      const generatorResult = spawnSync(
        process.execPath,
        [resolve(packageDir, 'scripts/write-production-config.mjs'), 'wrangler.production.example.jsonc'],
        {
          cwd: packageDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKENBOARD_WORKER_ROUTE: badRoute,
            BETTER_AUTH_URL: 'https://tokenboard.example.com',
            TOKENBOARD_COLLECTOR_REPO_URL: 'https://github.com/MisonL/TokenBoard.git',
            TOKENBOARD_COLLECTOR_REF: 'master',
            D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
          }
        }
      )

      expect(generatorResult.status).not.toBe(0)
      expect(generatorResult.stderr).toContain('custom domain host')
    }
  })

  test('production config generator rejects private, credentialed, and port-bearing auth URLs', () => {
    for (const betterAuthUrl of [
      'https://10.0.0.1',
      'https://127.0.0.1.',
      'https://example',
      'https://user:pass@example.com',
      'https://tokenboard.example.com:8443',
      'https://tokenboard.example.com:443',
      'https://tokenboard.example.com:0443'
    ]) {
      const result = spawnSync(
        process.execPath,
        [resolve(packageDir, 'scripts/write-production-config.mjs'), 'wrangler.production.example.jsonc'],
        {
          cwd: packageDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKENBOARD_WORKER_ROUTE: 'tokenboard.example.com',
            BETTER_AUTH_URL: betterAuthUrl,
            TOKENBOARD_COLLECTOR_REPO_URL: 'https://github.com/MisonL/TokenBoard.git',
            TOKENBOARD_COLLECTOR_REF: 'master',
            D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
          }
        }
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('public hostname without credentials or an explicit port')
    }
  })

  test('production config checker rejects private and port-bearing auth URLs and routes', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-unsafe-production-config-'))

    try {
      for (const [field, value] of [
        ['BETTER_AUTH_URL', 'https://10.0.0.1'],
        ['BETTER_AUTH_URL', 'https://example'],
        ['BETTER_AUTH_URL', 'https://user:pass@example.com'],
        ['BETTER_AUTH_URL', 'https://tokenboard.example.com:8443'],
        ['BETTER_AUTH_URL', 'https://tokenboard.example.com:443'],
        ['BETTER_AUTH_URL', 'https://tokenboard.example.com:0443'],
        ['route', '10.0.0.1'],
        ['route', '127.0.0.1.'],
        ['route', '127.1'],
        ['route', '192.168.1'],
        ['route', '169.254.1'],
        ['route', '0x7f.0.0.1'],
        ['route', '0177.0.0.1']
      ]) {
        const outputFile = join(
          tempDir,
          `wrangler.production.unsafe-${field}-${value.replace(/[^a-z0-9]/gi, '-')}.jsonc`
        )
        const content = filledProductionExample().replace(
          field === 'route'
            ? '"pattern": "tokenboard.example.com"'
            : '"BETTER_AUTH_URL": "https://tokenboard.example.com"',
          field === 'route' ? `"pattern": "${value}"` : `"BETTER_AUTH_URL": "${value}"`
        )
        writeFileSync(outputFile, content)

        const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
          cwd: packageDir,
          encoding: 'utf8',
          env: { ...process.env, TOKENBOARD_WRANGLER_CONFIG: outputFile }
        })

        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/public hostname without credentials|production custom domain host/)
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker rejects configured route values that are not bare hosts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-bad-route-config-'))

    try {
      for (const badRoute of [
        'tokenboard.example.com/path',
        'tokenboard.example.com?bad=1',
        'tokenboard.example.com#hash'
      ]) {
        const outputFile = join(tempDir, `wrangler.${badRoute.replace(/[^a-z0-9]/gi, '-')}.jsonc`)
        const content = filledProductionExample().replace(
          '"pattern": "tokenboard.example.com"',
          `"pattern": "${badRoute}"`
        )
        writeFileSync(outputFile, content)

        const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
          cwd: packageDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKENBOARD_WRANGLER_CONFIG: outputFile
          }
        })

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('custom domain host')
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker ignores misleading JSONC comments', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-commented-config-'))
    const outputFile = join(tempDir, 'wrangler.production.commented.jsonc')

    try {
      const content = filledProductionExample().replace(
        '{',
        '{\n  // "workers_dev": true,\n  // "pattern": "localhost",\n  // "database_id": "00000000-0000-0000-0000-000000000000",'
      )
      writeFileSync(outputFile, content)

      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: outputFile
        }
      })

      expect(result.status).toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

function readPackageFile(relativePath: string): string {
  return readFileSync(resolve(packageDir, relativePath), 'utf8')
}

function readDrizzleSchema() {
  return [readPackageFile('app/db/schema.ts'), readPackageFile('app/db/schema-identity.ts')].join('\n')
}

function filledProductionExample() {
  return readPackageFile('wrangler.production.example.jsonc')
    .replace('"pattern": "<your-tokenboard-domain>"', '"pattern": "tokenboard.example.com"')
    .replace(
      '"BETTER_AUTH_URL": "https://<your-tokenboard-domain>"',
      '"BETTER_AUTH_URL": "https://tokenboard.example.com"'
    )
    .replace(
      '"TOKENBOARD_COLLECTOR_REPO_URL": "<tokenboard-collector-repo-url>"',
      '"TOKENBOARD_COLLECTOR_REPO_URL": "https://github.com/MisonL/TokenBoard.git"'
    )
    .replace('"TOKENBOARD_COLLECTOR_REF": "<tokenboard-collector-ref>"', '"TOKENBOARD_COLLECTOR_REF": "master"')
    .replace(
      '"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "<tokenboard-daily-report-history-days>"',
      '"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "30"'
    )
    .replace(
      '"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "<tokenboard-usage-summary-backfill-limit>"',
      '"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "50"'
    )
    .replace(
      '"TOKENBOARD_USAGE_SUMMARY_STRICT": "<tokenboard-usage-summary-strict>"',
      '"TOKENBOARD_USAGE_SUMMARY_STRICT": "false"'
    )
    .replace(
      '"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "<tokenboard-webhook-log-retention-days>"',
      '"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "90"'
    )
    .replace(
      '"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "<tokenboard-webhook-cron-batch-size>"',
      '"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "5"'
    )
    .replace('"database_id": "<your-d1-database-id>"', '"database_id": "11111111-1111-4111-8111-111111111111"')
}

function resourceControlDefault(name: string) {
  if (name === 'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS') return '30'
  if (name === 'TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT') return '50'
  if (name === 'TOKENBOARD_USAGE_SUMMARY_STRICT') return 'false'
  if (name === 'TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS') return '90'
  if (name === 'TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE') return '5'
  if (name === 'TOKENBOARD_MODEL_PRICING_SOURCE_URL') return 'https://models.dev/api.json'
  if (name === 'TOKENBOARD_COLLECTOR_REPO_URL') return 'https://github.com/MisonL/TokenBoard.git'
  if (name === 'TOKENBOARD_COLLECTOR_REF') return 'master'
  throw new Error(`Unknown resource control variable ${name}`)
}

function runSqlite(dbPath: string, sql: string, requireSuccess = true) {
  const result = spawnSync('sqlite3', [dbPath], {
    encoding: 'utf8',
    input: sql
  })
  if (requireSuccess && result.status !== 0) {
    throw new Error(result.stderr || `sqlite3 exited with status ${result.status}`)
  }
  return result
}
