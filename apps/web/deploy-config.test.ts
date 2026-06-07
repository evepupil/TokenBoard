import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  test('tracked wrangler config stays runnable for local preview', () => {
    const config = readPackageFile('wrangler.jsonc')
    const deploymentScript = readPackageFile('scripts/deploy.mjs')
    const productionCheckScript = readPackageFile('scripts/check-production-config.mjs')

    expect(config).not.toContain('"routes"')
    expect(config).not.toContain('<your-tokenboard-domain>')
    expect(config).toContain('"BETTER_AUTH_URL": "http://localhost:8787"')
    expect(config).toContain('"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "30"')
    expect(config).toContain('"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "50"')
    expect(config).toContain('"TOKENBOARD_USAGE_SUMMARY_STRICT": "false"')
    expect(config).toContain('"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "90"')
    expect(config).toContain('"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "5"')
    expect(config).toContain('"database_id": "local-tokenboard-dev"')
    expect(config).toContain('"binding": "ASSETS"')
    expect(config).toContain('"run_worker_first"')
    expect(config).toContain('"run_worker_first": true')
    expect(config).not.toMatch(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(config).not.toMatch(/"pattern":\s*"[a-z0-9.-]+\.[a-z]{2,}"/i)
    expect(config).not.toMatch(/"database_id":\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i)
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
    expect(example).toContain('"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "<tokenboard-daily-report-history-days>"')
    expect(example).toContain('"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "<tokenboard-usage-summary-backfill-limit>"')
    expect(example).toContain('"TOKENBOARD_USAGE_SUMMARY_STRICT": "<tokenboard-usage-summary-strict>"')
    expect(example).toContain('"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "<tokenboard-webhook-log-retention-days>"')
    expect(example).toContain('"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "<tokenboard-webhook-cron-batch-size>"')
    expect(example).toContain('"database_id": "<your-d1-database-id>"')
    expect(example).not.toMatch(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(example).not.toMatch(/"pattern":\s*"[a-z0-9.-]+\.[a-z]{2,}"/i)
    expect(example).not.toMatch(/"database_id":\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i)
  })

  test('manual production deploy helper applies migrations before Worker deploy', () => {
    const deployScript = readPackageFile('scripts/deploy.mjs')

    expect(deployScript).toContain('wrangler.production.ci.jsonc')
    expect(deployScript).toContain('scripts/write-production-config.mjs')
    expect(deployScript).toContain('scripts/check-production-config.mjs')
    expect(deployScript).toContain("runPnpm(['run', 'build'])")
    expect(deployScript).toContain("'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath")
    expect(deployScript).toContain("'deploy', '--config', configPath")
    expect(deployScript.indexOf("runPnpm(['run', 'build'])")).toBeLessThan(
      deployScript.indexOf("'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath")
    )
    expect(deployScript.indexOf("'d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath")).toBeLessThan(
      deployScript.indexOf("'deploy', '--config', configPath")
    )
    expect(deployScript).not.toContain('--config wrangler.jsonc')
  })

  test('Drizzle schema declares webhook migration indexes', () => {
    const schema = readPackageFile('app/db/schema.ts')

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
    const schema = readPackageFile('app/db/schema.ts')

    expect(schema).toContain("'daily_report_history'")
    expect(schema).toContain('dailyReportShareEnabled')
    expect(schema).toContain('shareRevokedAt')
    expect(schema).toContain("uniqueIndex('daily_report_history_user_date_slot_idx')")
    expect(schema).toContain("index('daily_report_history_user_generated_idx')")
    expect(schema).toContain("index('daily_report_history_report_date_idx')")
    expect(schema).toContain('dailyReportHistory')
  })

  test('Drizzle schema declares usage summary cache tables', () => {
    const schema = readPackageFile('app/db/schema.ts')

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
    expect(migration).toContain("SET schedule_times_local = schedule_time_local")
    expect(migration).toContain("SET pending_schedule_slot = pending_report_date || 'T' || COALESCE(schedule_time_local, '18:00')")
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
      migration.indexOf("SET pending_schedule_slot = pending_report_date || 'T' || COALESCE(schedule_time_local, '18:00')")
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
            D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
          }
        }
      )

      expect(result.status).toBe(0)

      const generated = readFileSync(outputFile, 'utf8')
      expect(generated).toContain('"pattern": "tokenboard.example.com"')
      expect(generated).toContain('"BETTER_AUTH_URL": "https://tokenboard.example.com"')
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
        ['TOKENBOARD_DAILY_REPORT_HISTORY_DAYS', '0', 'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS must be an integer from 1 to 31'],
        ['TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT', '501', 'TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to 500'],
        ['TOKENBOARD_USAGE_SUMMARY_STRICT', 'yes', 'TOKENBOARD_USAGE_SUMMARY_STRICT must be true, false, 1, or 0'],
        ['TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS', '366', 'TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS must be an integer from 1 to 365'],
        ['TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE', '6', 'TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE must be an integer from 1 to 5']
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
  })

  test('production config checker rejects unreplaced resource control placeholders', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-retention-placeholder-config-'))
    const outputFile = join(tempDir, 'wrangler.production.retention-placeholder.jsonc')

    try {
      const content = readPackageFile('wrangler.production.example.jsonc')
        .replace('"pattern": "<your-tokenboard-domain>"', '"pattern": "tokenboard.example.com"')
        .replace('"BETTER_AUTH_URL": "https://<your-tokenboard-domain>"', '"BETTER_AUTH_URL": "https://tokenboard.example.com"')
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
        ['TOKENBOARD_DAILY_REPORT_HISTORY_DAYS', 'abc', 'vars.TOKENBOARD_DAILY_REPORT_HISTORY_DAYS must be an integer from 1 to 31'],
        ['TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT', '501', 'vars.TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to 500'],
        ['TOKENBOARD_USAGE_SUMMARY_STRICT', 'yes', 'vars.TOKENBOARD_USAGE_SUMMARY_STRICT must be true, false, 1, or 0'],
        ['TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS', '366', 'vars.TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS must be an integer from 1 to 365'],
        ['TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE', '6', 'vars.TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE must be an integer from 1 to 5']
      ]) {
        const outputFile = join(tempDir, `wrangler.production.${name}.jsonc`)
        const content = filledProductionExample()
          .replace(`"${name}": "${resourceControlDefault(name)}"`, `"${name}": "${value}"`)
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
  })

  test('deploy helper generates production config for clean Cloudflare builds', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-clean-deploy-'))
    const scriptDir = join(tempDir, 'scripts')
    const pnpmStub = join(tempDir, 'pnpm')

    try {
      mkdirSync(scriptDir)
      copyFileSync(resolve(packageDir, 'scripts/deploy.mjs'), join(scriptDir, 'deploy.mjs'))
      copyFileSync(resolve(packageDir, 'scripts/check-production-config.mjs'), join(scriptDir, 'check-production-config.mjs'))
      copyFileSync(resolve(packageDir, 'scripts/write-production-config.mjs'), join(scriptDir, 'write-production-config.mjs'))
      copyFileSync(resolve(packageDir, 'wrangler.production.example.jsonc'), join(tempDir, 'wrangler.production.example.jsonc'))
      writeFileSync(pnpmStub, '#!/bin/sh\nexit 0\n')
      chmodSync(pnpmStub, 0o755)

      const result = spawnSync(process.execPath, ['scripts/deploy.mjs'], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ''}`,
          TOKENBOARD_WORKER_ROUTE: 'tokenboard.example.com',
          BETTER_AUTH_URL: 'https://tokenboard.example.com',
          TOKENBOARD_DAILY_REPORT_HISTORY_DAYS: '7',
          TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT: '20',
          TOKENBOARD_USAGE_SUMMARY_STRICT: '1',
          TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS: '45',
          TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE: '3',
          D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
        }
      })

      expect(result.status).toBe(0)

      const generated = readFileSync(join(tempDir, 'wrangler.production.ci.jsonc'), 'utf8')
      expect(generated).toContain('"pattern": "tokenboard.example.com"')
      expect(generated).toContain('"BETTER_AUTH_URL": "https://tokenboard.example.com"')
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

  test('production config checker rejects the local preview Wrangler config', () => {
    const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
      cwd: packageDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKENBOARD_WRANGLER_CONFIG: 'wrangler.jsonc'
      }
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('wrangler.jsonc is missing workers_dev: false')
  })

  test('production config checker rejects production config without cron triggers', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-no-cron-config-'))
    const outputFile = join(tempDir, 'wrangler.production.no-cron.jsonc')

    try {
      const content = filledProductionExample()
        .replace(/\s+"triggers":\s*\{\s*"crons":\s*\[\s*"\*\/15 \* \* \* \*"\s*\]\s*\},/, '')
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
      'tokenboard.example.com#hash'
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
            D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
          }
        }
      )

      expect(generatorResult.status).not.toBe(0)
      expect(generatorResult.stderr).toContain('custom domain host')
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
        const content = filledProductionExample()
          .replace('"pattern": "tokenboard.example.com"', `"pattern": "${badRoute}"`)
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
      const content = filledProductionExample()
        .replace('{', '{\n  // "workers_dev": true,\n  // "pattern": "localhost",\n  // "database_id": "00000000-0000-0000-0000-000000000000",')
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

function filledProductionExample() {
  return readPackageFile('wrangler.production.example.jsonc')
    .replace('"pattern": "<your-tokenboard-domain>"', '"pattern": "tokenboard.example.com"')
    .replace('"BETTER_AUTH_URL": "https://<your-tokenboard-domain>"', '"BETTER_AUTH_URL": "https://tokenboard.example.com"')
    .replace('"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "<tokenboard-daily-report-history-days>"', '"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": "30"')
    .replace('"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "<tokenboard-usage-summary-backfill-limit>"', '"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": "50"')
    .replace('"TOKENBOARD_USAGE_SUMMARY_STRICT": "<tokenboard-usage-summary-strict>"', '"TOKENBOARD_USAGE_SUMMARY_STRICT": "false"')
    .replace('"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "<tokenboard-webhook-log-retention-days>"', '"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": "90"')
    .replace('"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "<tokenboard-webhook-cron-batch-size>"', '"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": "5"')
    .replace('"database_id": "<your-d1-database-id>"', '"database_id": "11111111-1111-4111-8111-111111111111"')
}

function resourceControlDefault(name: string) {
  if (name === 'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS') return '30'
  if (name === 'TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT') return '50'
  if (name === 'TOKENBOARD_USAGE_SUMMARY_STRICT') return 'false'
  if (name === 'TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS') return '90'
  if (name === 'TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE') return '5'
  throw new Error(`Unknown resource control variable ${name}`)
}
