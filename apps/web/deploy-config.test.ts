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
import { runSqliteScript } from './app/test/sqlite-script'

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
    expect(productionCheckScript).toContain("new URL('../wrangler.production.jsonc', import.meta.url)")
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

  // The example is the template the deploy generator fills in, and the tracked config is what
  // ships. Nothing compared them structurally, so a var added to one and not the other (or
  // renamed in one) drifted silently until a deploy failed or a default shipped. Compare the
  // flattened key sets and the non-placeholder values, so the two cannot diverge unnoticed.
  test('the tracked config and the production example carry the same keys and defaults', () => {
    const tracked = flattenJsonc(readPackageFile('wrangler.jsonc'))
    const example = flattenJsonc(readPackageFile('wrangler.production.example.jsonc'))

    const trackedKeys = Object.keys(tracked).sort()
    const exampleKeys = Object.keys(example).sort()
    expect(trackedKeys).toEqual(exampleKeys)

    // Every value the example leaves as a placeholder must be filled in the tracked config;
    // every value it states outright must match it exactly.
    for (const key of exampleKeys) {
      const exampleValue = example[key]
      if (isPlaceholder(exampleValue)) continue
      expect(tracked[key], `${key} must match the example's stated value`).toBe(exampleValue)
    }
  })

  test('static assets are published by allow-list, not by deny-list enumeration', () => {
    // `assets.directory` is the whole build output root (it also holds `main`), so an
    // ignore list that enumerates what to hide publishes every future root-level build
    // artifact by default. The list must invert: ignore everything, re-include only the
    // files that are meant to be public (favicon, logo, hashed client assets).
    const assetsIgnore = readPackageFile('public/.assetsignore')
    const lines = assetsIgnore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))

    expect(lines[0]).toBe('/*')
    expect(lines).toContain('!/logo.svg')
    expect(lines).toContain('!/favicon.ico')
    expect(lines).toContain('!/static')
    expect(lines).not.toContain('index.js')
    expect(lines).not.toContain('.vite/')
  })

  test('manual production deploy helper verifies migrated schema before Worker deploy', () => {
    const deployScript = readPackageFile('scripts/deploy.mjs')
    const routeCheckScript = readPackageFile('scripts/check-production-route.mjs')
    const schemaCheckCommand = /runPnpm\(\[\s*'exec',\s*'wrangler',\s*'d1',\s*'execute'/
    const schemaCheckIndex = deployScript.search(schemaCheckCommand)

    expect(deployScript).toContain('wrangler.production.ci.jsonc')
    expect(deployScript).toContain('scripts/write-production-config.mjs')
    expect(deployScript).toContain('scripts/check-production-config.mjs')
    expect(deployScript).toContain('scripts/check-production-route.mjs')
    expect(deployScript).toContain("'deploy', '--dry-run', '--config', configPath")
    expect(deployScript).toContain("runPnpm(['run', 'build'])")
    expect(deployScript).toContain("'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath")
    expect(schemaCheckIndex).toBeGreaterThan(-1)
    expect(deployScript).toContain("'deploy', '--config', configPath")
    expect(deployScript.indexOf("runPnpm(['run', 'build'])")).toBeLessThan(
      deployScript.indexOf("'deploy', '--dry-run', '--config', configPath")
    )
    expect(deployScript.indexOf("'deploy', '--dry-run', '--config', configPath")).toBeLessThan(
      deployScript.indexOf('scripts/check-production-route.mjs')
    )
    expect(deployScript.indexOf('scripts/check-production-route.mjs')).toBeLessThan(
      deployScript.indexOf("'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath")
    )
    expect(deployScript.indexOf("'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath")).toBeLessThan(
      schemaCheckIndex
    )
    expect(schemaCheckIndex).toBeLessThan(deployScript.indexOf("'deploy', '--config', configPath"))
    expect(deployScript).not.toContain('--config wrangler.jsonc')
    expect(routeCheckScript).toContain('Cloudflare zone preflight')
    expect(routeCheckScript).toContain('oauth_token')
    expect(routeCheckScript).toContain('CLOUDFLARE_API_TOKEN')
  })

  // A declined "About to apply N migration(s)" prompt makes `migrations apply` exit 0 with
  // nothing applied, and a pure-data migration leaves every schema gate green — so the deploy
  // would publish a Worker against an unmigrated database. The re-list after apply is what
  // closes that gap, and it must sit between the apply and the Worker publish.
  test('manual production deploy re-lists migrations after applying and before publishing', () => {
    const deployScript = readPackageFile('scripts/deploy.mjs')
    // Whitespace-normalized: the listing call is a multi-line argument array, and the assertion
    // is about which command runs and where, not how the line breaks.
    const compactScript = deployScript.replace(/\s+/g, ' ')
    const applyIndex = deployScript.indexOf("'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath")
    const verifyIndex = deployScript.indexOf('assertNoPendingMigrations(configPath)')
    const publishIndex = deployScript.indexOf("runPnpm(['exec', 'wrangler', 'deploy', '--config', configPath])")

    expect(applyIndex).toBeGreaterThan(-1)
    expect(verifyIndex).toBeGreaterThan(applyIndex)
    expect(publishIndex).toBeGreaterThan(verifyIndex)
    expect(compactScript).toContain("'d1', 'migrations', 'list', 'DB', '--remote', '--config', configPath")
    expect(deployScript).toContain('No migrations to apply')
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

  // The migration chain is hand-maintained (AGENTS.md bans `drizzle-kit generate`, and the
  // applied history is immutable). Wrangler applies migrations in filename order and only
  // dedupes by name, so a skipped or duplicated number would not fail the deploy — it would
  // silently apply out of the intended order, or never. Pin the numbering as a contiguous
  // 0000..N sequence with no gaps so a hand-added file cannot drift the chain.
  test('the migration chain is a contiguous numbered sequence', () => {
    const migrationsDir = resolve(packageDir, 'db/migrations')
    const names = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
    const numbers = names.map((name) => {
      const match = /^(\d{4})_/.exec(name)
      expect(match, `migration ${name} must start with a four-digit sequence number`).not.toBeNull()
      return Number(match?.[1])
    })

    expect(numbers).toEqual(numbers.map((_value, index) => index))
  })

  test('model pricing migrations add the staged catalogue schema before the critical gate', () => {
    const migrationsDir = resolve(packageDir, 'db/migrations')
    const baseMigration = readFileSync(join(migrationsDir, '0030_model_pricing.sql'), 'utf8')
    const stagingMigration = readFileSync(join(migrationsDir, '0031_model_pricing_staging.sql'), 'utf8')
    const reservedSlugMigrationName = '0032_reserved_model_pricing_slug.sql'
    const migrationNames = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
    expect(migrationNames.indexOf('0031_model_pricing_staging.sql')).toBeGreaterThanOrEqual(0)
    expect(migrationNames.indexOf(reservedSlugMigrationName)).toBe(
      migrationNames.indexOf('0031_model_pricing_staging.sql') + 1
    )
    const reservedSlugMigration = readFileSync(join(migrationsDir, reservedSlugMigrationName), 'utf8')
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

      runSqlite(dbPath, reservedSlugMigration)
      expect(() => runSqlite(dbPath, reservedSlugMigration)).not.toThrow()
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

  test('rate limit maintenance migrations replace the legacy reset index', () => {
    const expressionIndexMigration = readPackageFile('db/migrations/0033_rate_limit_reset_julianday_index.sql')
    const dropLegacyIndexMigration = readPackageFile('db/migrations/0034_drop_api_rate_limits_reset_index.sql')
    const schema = readDrizzleSchema()

    expect(expressionIndexMigration).toContain('CREATE INDEX IF NOT EXISTS api_rate_limits_reset_julianday_idx')
    expect(expressionIndexMigration).toContain('ON api_rate_limits(julianday(reset_at))')
    expect(dropLegacyIndexMigration).toContain('DROP INDEX IF EXISTS api_rate_limits_reset_idx')
    expect(schema).toContain("index('api_rate_limits_reset_julianday_idx').on(sql`julianday(")
  })

  // The migration files are read as text elsewhere, which cannot tell whether the index
  // that ends up in the database actually covers the expression the prune query needs.
  // This runs the real migrations and then asserts against sqlite_master.
  test('the rate limit expression index survives the migration pair', () => {
    const schemaCheck = readPackageFile('db/verify-rate-limit-index.sql')
    const migrationsDir = resolve(packageDir, 'db/migrations')
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-rate-limit-index-gate-'))
    const dbPath = join(tempDir, 'index.db')

    try {
      for (const migration of readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }

      const check = runSqlite(dbPath, schemaCheck, false)
      expect(check.status).toBe(0)
      expect(check.stderr).toBe('')

      // Dropping it has to make the check fail, or the assertion proves nothing.
      runSqlite(dbPath, 'DROP INDEX api_rate_limits_reset_julianday_idx;')
      const afterDrop = runSqlite(dbPath, schemaCheck, false)
      expect(afterDrop.status).not.toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  // AGENTS.md says the model-pricing deploy runs a foreign-key check after applying the
  // migrations. This asserts the deploy script actually schedules it, so the documented
  // contract cannot silently drift away from what deploy.mjs executes.
  test('deploy runs the foreign-key check after migrations and before the live deploy', () => {
    const deployScript = readPackageFile('scripts/deploy.mjs')
    const migrationsApply = deployScript.indexOf(
      "'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath"
    )
    const foreignKeyCheck = deployScript.indexOf('db/verify-foreign-keys.sql')
    const liveDeploy = deployScript.indexOf("'deploy', '--config', configPath")

    expect(foreignKeyCheck).toBeGreaterThan(-1)
    expect(migrationsApply).toBeLessThan(foreignKeyCheck)
    expect(foreignKeyCheck).toBeLessThan(liveDeploy)
  })

  // The ordering test above anchors the foreign-key check relative to migrations and the live
  // deploy, but all the gates share one array literal: reordering inside it, or dropping
  // `verify-critical-schema.sql` / `verify-rate-limit-index.sql` / `verify-retention-index.sql`
  // from it, moves no anchor and would leave that test green. Pin the array itself, in order, so
  // the deploy loop cannot drift from the gate set the rest of this file asserts the contents of.
  test('deploy runs every schema gate in the documented order', () => {
    const deployScript = readPackageFile('scripts/deploy.mjs')
    const gates = [
      'db/verify-critical-schema.sql',
      'db/verify-rate-limit-index.sql',
      'db/verify-retention-index.sql',
      'db/verify-foreign-keys.sql'
    ]
    const positions = gates.map((gate) => deployScript.indexOf(`'${gate}'`))

    // Every gate must be scheduled, in the array's order, so neither a dropped gate nor a
    // reordering can pass unnoticed.
    for (const position of positions) expect(position).toBeGreaterThan(-1)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))

    // `wrangler d1 execute --file --remote` only prompts when interactive, and declining
    // returns null (exit 0), so a gate without `--yes` can be skipped while deploy.mjs reads a
    // zero status and publishes. Pin the flag so the gate command cannot lose it.
    const gateCall = deployScript.slice(
      deployScript.indexOf('for (const file of ['),
      deployScript.indexOf("runPnpm(['exec', 'wrangler', 'deploy', '--config', configPath])")
    )
    expect(gateCall).toContain("'--yes'")
  })

  // The retention indexes from 0036 were built the same way the rate-limit index was, and
  // suffered the same gap: nothing in the deploy gate knew they existed, so `DROP INDEX` on
  // either left every gate green. This runs the real migrations and then asserts the check
  // notices a missing index — the negative half is what makes the positive half mean anything.
  test('the retention index check accepts migrated data and rejects a dropped index', () => {
    const schemaCheck = readPackageFile('db/verify-retention-index.sql')
    const migrationsDir = resolve(packageDir, 'db/migrations')
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-retention-index-gate-'))
    const dbPath = join(tempDir, 'retention.db')

    try {
      for (const migration of readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }

      const check = runSqlite(dbPath, schemaCheck, false)
      expect(check.status).toBe(0)
      expect(check.stderr).toBe('')

      runSqlite(dbPath, 'DROP INDEX pairing_codes_retention_julianday_idx;')
      const afterPairingDrop = runSqlite(dbPath, schemaCheck, false)
      expect(afterPairingDrop.status).not.toBe(0)

      runSqlite(
        dbPath,
        'CREATE INDEX pairing_codes_retention_julianday_idx ON pairing_codes(julianday(COALESCE(consumed_at, expires_at)));'
      )
      runSqlite(dbPath, 'DROP INDEX audit_logs_created_julianday_idx;')
      const afterAuditDrop = runSqlite(dbPath, schemaCheck, false)
      expect(afterAuditDrop.status).not.toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  // The retention indexes from 0036 were built the same way the rate-limit index was, and
  // suffered the same gap: nothing in the deploy gate knew they existed, so `DROP INDEX` on
  // either left every gate green. The runtime check above proves the migration produces them;
  // this pins the Drizzle declarations so the hand-maintained schema keeps the index even if
  // someone edits `schema-identity.ts` and forgets the migration (the AGENTS.md ban on
  // `drizzle-kit generate` means the SQL and the declaration can drift).
  test('the schema declares the retention expression indexes from 0036', () => {
    const schema = readDrizzleSchema()

    expect(schema).toContain("index('pairing_codes_retention_julianday_idx')")
    expect(schema).toContain("index('audit_logs_created_julianday_idx')")
  })

  // The verifier only proves something if a clean database passes and an orphaned row fails.
  // `PRAGMA foreign_key_check` returns rows on violation but still exits zero, so the check has
  // to convert a non-empty result into an error the way verify-rate-limit-index.sql does.
  test('the foreign-key check accepts migrated data and rejects an orphaned row', () => {
    const foreignKeyCheck = readPackageFile('db/verify-foreign-keys.sql')
    const migrationsDir = resolve(packageDir, 'db/migrations')
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-foreign-key-gate-'))
    const dbPath = join(tempDir, 'foreign-key.db')

    try {
      for (const migration of readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }

      const clean = runSqlite(dbPath, foreignKeyCheck, false)
      expect(clean.status).toBe(0)
      expect(clean.stderr).toBe('')

      // `profiles.user_id` references `users(id)`, so a profile for a user that does not
      // exist is exactly the corruption the check exists to catch.
      runSqlite(
        dbPath,
        `PRAGMA foreign_keys = OFF;
         INSERT INTO profiles (user_id, slug, display_name, timezone, timezone_source, is_public, participates_in_leaderboards, created_at, updated_at)
         VALUES ('ghost-user', 'ghost', 'Ghost', 'UTC', 'default', 0, 0, '2026-01-01', '2026-01-01');`
      )

      const orphaned = runSqlite(dbPath, foreignKeyCheck, false)
      expect(orphaned.status).not.toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

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
          '51',
          'TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE must be an integer from 1 to 50'
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
          '51',
          'vars.TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE must be an integer from 1 to 50'
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

  test('production config checker rejects secrets placed in vars', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-inline-secret-config-'))

    try {
      for (const [name, message] of [
        ['BETTER_AUTH_SECRET', 'vars.BETTER_AUTH_SECRET'],
        ['WEBHOOK_ENCRYPTION_KEY', 'vars.WEBHOOK_ENCRYPTION_KEY'],
        ['GITHUB_CLIENT_SECRET', 'vars.GITHUB_CLIENT_SECRET']
      ]) {
        const outputFile = join(tempDir, `wrangler.production.${name}.jsonc`)
        const content = filledProductionExample().replace(
          '"BETTER_AUTH_URL": "https://tokenboard.example.com",',
          `"BETTER_AUTH_URL": "https://tokenboard.example.com",\n    "${name}": "inline-secret-value",`
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
        expect(result.stderr).toContain('Worker secret')
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

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
      writeFileSync(join(scriptDir, 'check-production-route.mjs'), 'process.exit(0)\n')
      copyFileSync(
        resolve(packageDir, 'wrangler.production.example.jsonc'),
        join(tempDir, 'wrangler.production.example.jsonc')
      )
      // The deploy re-lists migrations after applying them and treats an unreadable listing as
      // pending (fail-closed), so the stub has to answer the `migrations list` call with the
      // same clean-state line wrangler prints; every other command still exits 0 silently.
      writeFileSync(
        pnpmStub,
        [
          'const argv = process.argv.slice(2)',
          "if (argv.includes('migrations') && argv.includes('list')) console.log('✅ No migrations to apply!')",
          'process.exit(0)'
        ].join('\n') + '\n'
      )

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
          TOKENBOARD_MODEL_PRICING_SYNC_ENABLED: '0',
          TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS: '12',
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
      // The model-pricing sync vars are real values in the example, not placeholders, so the
      // generator must still replace them by key; assert the env values reached the output.
      // The source URL is deliberately left alone: the deploy checker pins it to
      // `https://models.dev/api.json`, which is the only value that passes.
      expect(generated).toContain('"TOKENBOARD_MODEL_PRICING_SYNC_ENABLED": "false"')
      expect(generated).toContain('"TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS": "12"')
      expect(generated).toContain('"database_id": "11111111-1111-4111-8111-111111111111"')
      expect(result.stderr).toBe('')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 15_000)

  test('production config checker resolves its default config next to the script, not the cwd', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-empty-config-'))

    try {
      // A decoy in the working directory: it still contains a placeholder, so if the
      // checker resolved its default against `process.cwd()` the failure would name the
      // decoy's path. The script-relative default must never read it.
      writeFileSync(join(tempDir, 'wrangler.production.jsonc'), '{ "pattern": "<decoy-marker>" }')

      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: ''
        }
      })

      expect(result.stderr).not.toContain(tempDir)
      expect(result.stderr).not.toContain('wrangler.jsonc')
      // With the private config present next to the script (developer machines) the check
      // passes; in a bare checkout it fails with the package-relative filename.
      if (result.status !== 0) {
        expect(result.stderr).toContain('wrangler.production.jsonc')
      }
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
  }, 15_000)

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

  test('production config checker rejects an auth URL host that differs from the route host', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-mismatched-auth-url-'))
    const outputFile = join(tempDir, 'wrangler.production.mismatched.jsonc')

    try {
      const content = filledProductionExample().replace(
        '"BETTER_AUTH_URL": "https://tokenboard.example.com"',
        '"BETTER_AUTH_URL": "https://accounts.example.com"'
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

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('BETTER_AUTH_URL')
      expect(result.stderr).toContain('routes[0].pattern')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker rejects wildcard routes that wrangler custom domains do not accept', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-wildcard-route-'))
    const outputFile = join(tempDir, 'wrangler.production.wildcard.jsonc')

    try {
      const content = filledProductionExample().replace(
        '"pattern": "tokenboard.example.com"',
        '"pattern": "*.example.com"'
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

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('wildcard')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config generator rejects a route and auth URL on different hosts', () => {
    const result = spawnSync(
      process.execPath,
      [resolve(packageDir, 'scripts/write-production-config.mjs'), 'wrangler.production.example.jsonc'],
      {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WORKER_ROUTE: 'tokenboard.example.com',
          BETTER_AUTH_URL: 'https://accounts.example.com',
          TOKENBOARD_COLLECTOR_REPO_URL: 'https://github.com/MisonL/TokenBoard.git',
          TOKENBOARD_COLLECTOR_REF: 'master',
          D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
        }
      }
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('BETTER_AUTH_URL')
    expect(result.stderr).toContain('TOKENBOARD_WORKER_ROUTE')
  })

  test('production config generator rejects wildcard routes that wrangler custom domains do not accept', () => {
    const result = spawnSync(
      process.execPath,
      [resolve(packageDir, 'scripts/write-production-config.mjs'), 'wrangler.production.example.jsonc'],
      {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WORKER_ROUTE: '*.example.com',
          BETTER_AUTH_URL: 'https://tokenboard.example.com',
          TOKENBOARD_COLLECTOR_REPO_URL: 'https://github.com/MisonL/TokenBoard.git',
          TOKENBOARD_COLLECTOR_REF: 'master',
          D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
        }
      }
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('wildcard')
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

// The two configs are JSONC (comments allowed), so parse them by stripping line comments and
// flattening nested objects into dotted keys. Only the key *structure* and the non-placeholder
// values are compared, so a comment or key reorder is not a divergence.
function flattenJsonc(source: string) {
  const withoutComments = source
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
  const parsed = JSON.parse(withoutComments)
  const flat: Record<string, string> = {}
  const walk = (value: unknown, prefix: string) => {
    if (value === null || typeof value !== 'object') {
      flat[prefix] = String(value)
      return
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, prefix ? `${prefix}.${key}` : key)
    }
  }
  walk(parsed, '')
  return flat
}

function isPlaceholder(value: string) {
  // A placeholder may be the whole value (`<your-d1-database-id>`) or embedded in one
  // (`https://<your-tokenboard-domain>`); either way the tracked config is free to differ.
  return value.includes('<') && value.includes('>')
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
  const result = runSqliteScript(dbPath, sql)
  if (requireSuccess && result.status !== 0) {
    throw new Error(result.stderr || `sqlite exited with status ${result.status}`)
  }
  return result
}
