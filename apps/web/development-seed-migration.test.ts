import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'

const migrationsDir = resolve(import.meta.dirname, 'db/migrations')

describe('development seed migration', () => {
  test('removes the public seed identity and fixed pairing credential without connection-level foreign keys', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-seed-cleanup-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      for (const migration of migrationsBeforeSeedCleanup()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }
      insertSeedDependentData(dbPath)
      expectSeedState(dbPath, 1)
      runSqlite(dbPath, readFileSync(join(migrationsDir, '0028_remove_development_seed.sql'), 'utf8'), {
        foreignKeys: false
      })

      expectFullSeedDataRemoved(dbPath)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test.each([
    { label: 'immediate', deferForeignKeys: false },
    { label: 'deferred', deferForeignKeys: true }
  ])(
    'removes the full seed graph with $label foreign-key enforcement',
    ({ deferForeignKeys }) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-seed-cleanup-'))
      const dbPath = join(tempDir, 'tokenboard.db')

      try {
        for (const migration of migrationsBeforeSeedCleanup()) {
          runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
        }
        insertSeedDependentData(dbPath)
        expectSeedState(dbPath, 1)

        runSqlite(
          dbPath,
          `BEGIN;\n${readFileSync(join(migrationsDir, '0028_remove_development_seed.sql'), 'utf8')}\nCOMMIT;`,
          { foreignKeys: true, deferForeignKeys }
        )

        expectFullSeedDataRemoved(dbPath)
        expect(runSqlite(dbPath, 'PRAGMA foreign_key_check;').stdout.trim()).toBe('')
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
    30_000
  )

  test('removes the fixed pairing credential without deleting an adopted seed user', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-seed-cleanup-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      for (const migration of migrationsBeforeSeedCleanup()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }

      runSqlite(
        dbPath,
        `
        UPDATE users
        SET email = 'claimed@example.test', name = 'Claimed User'
        WHERE id = 'seed-user';
      `
      )
      insertSeedUsage(dbPath)
      expectSeedState(dbPath, 1)
      runSqlite(dbPath, readFileSync(join(migrationsDir, '0028_remove_development_seed.sql'), 'utf8'))

      const result = runSqlite(
        dbPath,
        `
        SELECT
          (SELECT COUNT(*) FROM users WHERE id = 'seed-user'),
          (SELECT COUNT(*) FROM profiles WHERE user_id = 'seed-user'),
          (SELECT COUNT(*) FROM pairing_codes WHERE id = 'pair_dev_seed'),
          (SELECT COUNT(*) FROM pairing_codes WHERE code_hash = '2fb2770cbfd167e945dd3495b21f241f03bb5ed864e153b0ef841eb1a19282bc'),
          (SELECT COUNT(*) FROM daily_usage WHERE user_id = 'seed-user');
      `
      )

      expect(result.stdout.trim()).toBe('1|1|0|0|1')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('preserves a default-profile seed user with a linked authentication account', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-seed-cleanup-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      for (const migration of migrationsBeforeSeedCleanup()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }
      insertSeedDependentData(dbPath)
      insertSeedAuthenticationAccount(dbPath)
      expectSeedState(dbPath, 1)

      runSqlite(dbPath, readFileSync(join(migrationsDir, '0028_remove_development_seed.sql'), 'utf8'))

      const result = runSqlite(
        dbPath,
        `
        SELECT
          (SELECT COUNT(*) FROM users WHERE id = 'seed-user'),
          (SELECT COUNT(*) FROM profiles WHERE user_id = 'seed-user'),
          (SELECT COUNT(*) FROM accounts WHERE user_id = 'seed-user'),
          (SELECT COUNT(*) FROM daily_usage WHERE user_id = 'seed-user'),
          (SELECT COUNT(*) FROM pairing_codes WHERE id = 'pair_dev_seed'),
          (SELECT COUNT(*) FROM pairing_codes WHERE code_hash = '2fb2770cbfd167e945dd3495b21f241f03bb5ed864e153b0ef841eb1a19282bc');
      `
      )

      expect(result.stdout.trim()).toBe('1|1|1|1|0|0')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)
})

function migrationsBeforeSeedCleanup() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && name < '0028_remove_development_seed.sql')
    .sort()
}

function insertSeedUsage(dbPath: string) {
  runSqlite(
    dbPath,
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
      synced_at
    ) VALUES (
      'seed-user',
      'legacy',
      'codex',
      '2026-04-28',
      'UTC',
      'gpt-5',
      1,
      0,
      0,
      0,
      1,
      0,
      1,
      '2026-04-28T00:00:00.000Z'
    );
  `
  )
}

function insertSeedDependentData(dbPath: string) {
  insertSeedUsage(dbPath)
  runSqlite(
    dbPath,
    `
    INSERT INTO upload_tokens (id, user_id, name, token_hash, created_at)
    VALUES ('token_seed', 'seed-user', 'Seed token', 'hash_seed', '2026-04-28T00:00:00.000Z');

    INSERT INTO pairing_codes (id, user_id, code_hash, pairing_type, expires_at, created_at)
    VALUES ('pair_seed_extra', 'seed-user', 'hash_seed_extra', 'new_device', '2026-05-01T00:00:00.000Z', '2026-04-28T00:00:00.000Z');

    INSERT INTO devices (id, user_id, name, platform, created_at, updated_at)
    VALUES ('device_seed', 'seed-user', 'Seed device', 'darwin', '2026-04-28T00:00:00.000Z', '2026-04-28T00:00:00.000Z');

    INSERT INTO device_installations (id, user_id, device_id, platform, first_seen_at, created_at, updated_at)
    VALUES ('installation_seed', 'seed-user', 'device_seed', 'darwin', '2026-04-28T00:00:00.000Z', '2026-04-28T00:00:00.000Z', '2026-04-28T00:00:00.000Z');

    INSERT INTO audit_logs (id, user_id, actor_type, action, target_type, created_at)
    VALUES ('audit_seed', 'seed-user', 'system', 'seed', 'user', '2026-04-28T00:00:00.000Z');

    INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at)
    VALUES ('session_seed', 'seed-user', 'session-token-seed', 0, 0, 0);

    INSERT INTO daily_usage_summary (
      user_id, usage_date, source, model, timezone, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, total_tokens, total_tokens_without_cache_read,
      cost_usd, session_count, updated_at
    ) VALUES (
      'seed-user', '2026-04-28', 'codex', 'gpt-5', 'UTC', 1, 0, 0, 0, 1, 1, 0, 1,
      '2026-04-28T00:00:00.000Z'
    );

    INSERT INTO user_usage_totals (
      user_id, total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at
    ) VALUES ('seed-user', 1, 1, 0, 1, '2026-04-28T00:00:00.000Z');

    INSERT INTO webhook_subscriptions (
      id, user_id, name, provider, webhook_url_encrypted, webhook_url_host, webhook_url_masked,
      next_run_at, created_at, updated_at
    ) VALUES (
      'subscription_seed', 'seed-user', 'Seed webhook', 'generic', 'ciphertext', 'example.test',
      'https://example.test/***', '2026-04-29T00:00:00.000Z', '2026-04-28T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z'
    );

    INSERT INTO webhook_delivery_logs (id, subscription_id, user_id, report_date, status, created_at)
    VALUES ('delivery_seed', 'subscription_seed', 'seed-user', '2026-04-28', 'success', '2026-04-28T00:00:00.000Z');

    INSERT INTO daily_report_history (
      id, user_id, report_date, schedule_slot, display_name, timezone, dashboard_url,
      total_tokens, total_tokens_without_cache_read, cache_read_rate, cost_usd, session_count,
      source_split, top_models, generated_at, updated_at
    ) VALUES (
      'report_seed', 'seed-user', '2026-04-28', '09:00', 'Seed User', 'UTC',
      'https://example.test/dashboard', 1, 1, 0, 0, 1, '{}', '[]',
      '2026-04-28T00:00:00.000Z', '2026-04-28T00:00:00.000Z'
    );
  `
  )
}

function insertSeedAuthenticationAccount(dbPath: string) {
  runSqlite(
    dbPath,
    `
    INSERT INTO accounts (id, account_id, provider_id, user_id, created_at, updated_at)
    VALUES ('account_seed', 'github-seed-account', 'github', 'seed-user', 0, 0);
  `
  )
}

function expectSeedState(dbPath: string, usageCount: number) {
  const result = runSqlite(
    dbPath,
    `
    SELECT
      (SELECT COUNT(*) FROM users WHERE id = 'seed-user'),
      (SELECT COUNT(*) FROM profiles WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM daily_usage WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM pairing_codes WHERE id = 'pair_dev_seed'),
      (SELECT COUNT(*) FROM pairing_codes WHERE code_hash = '2fb2770cbfd167e945dd3495b21f241f03bb5ed864e153b0ef841eb1a19282bc');
  `
  )

  expect(result.stdout.trim()).toBe(`1|1|${usageCount}|1|1`)
}

function expectFullSeedDataRemoved(dbPath: string) {
  const result = runSqlite(
    dbPath,
    `
    SELECT
      (SELECT COUNT(*) FROM users WHERE id = 'seed-user'),
      (SELECT COUNT(*) FROM profiles WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM upload_tokens WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM pairing_codes WHERE id = 'pair_dev_seed'),
      (SELECT COUNT(*) FROM pairing_codes WHERE code_hash = '2fb2770cbfd167e945dd3495b21f241f03bb5ed864e153b0ef841eb1a19282bc'),
      (SELECT COUNT(*) FROM pairing_codes WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM daily_usage WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM daily_usage_summary WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM user_usage_totals WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM devices WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM device_installations WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM audit_logs WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM sessions WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM accounts WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM webhook_subscriptions WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM webhook_delivery_logs WHERE user_id = 'seed-user'),
      (SELECT COUNT(*) FROM daily_report_history WHERE user_id = 'seed-user');
  `
  )

  expect(result.stdout.trim()).toBe('0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0')
}

function runSqlite(dbPath: string, sql: string, options: { foreignKeys?: boolean; deferForeignKeys?: boolean } = {}) {
  const foreignKeys = options.foreignKeys !== false ? 'ON' : 'OFF'
  const deferForeignKeys = options.deferForeignKeys ? 'PRAGMA defer_foreign_keys = ON;\n' : ''
  const result = spawnSync('sqlite3', [dbPath], {
    encoding: 'utf8',
    input: `PRAGMA foreign_keys = ${foreignKeys};\n${deferForeignKeys}${sql}`
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite3 exited with status ${result.status}`)
  }
  return result
}
