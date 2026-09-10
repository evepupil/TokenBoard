import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildStatus } from './status.mjs'
import { scheduledRetryLegacyStatePath, scheduledRetryStatePath } from './scheduled-retry.mjs'

test('status reports health without exposing local configuration identities or paths', () => {
  const status = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: {
      activeServer: 'https://tokenboard.example',
      endpoint: 'https://tokenboard.example/api/v1/ingest',
      deviceId: 'dev_123',
      installationId: 'inst_123',
      timezone: 'Asia/Shanghai',
      source: 'all',
      packageManager: 'bun',
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      scheduleTimes: ['06:00', '09:00']
    },
    hooks: {
      notifyPath: '/home/user/.tokenboard/bin/notify.cjs',
      notifyHandler: 'installed',
      codex: 'installed',
      claudeCode: 'not-installed',
      antigravityCli: 'installed',
      antigravityIde: 'installed-local-history',
      antigravity: 'installed-local-history',
      diagnostic: { privateValue: 'secret' }
    },
    deviceLink: {
      path: '/home/user/.tokenboard/device-link.json',
      present: true
    }
  })

  assert.deepEqual(status, {
    configured: true,
    activeServerConfigured: true,
    collectorConfigured: true,
    deviceIdentityConfigured: true,
    deviceLinkPresent: true,
    timezone: 'Asia/Shanghai',
    source: 'all',
    packageManager: 'bun',
    scheduleTimes: ['06:00', '09:00'],
    hooks: {
      notifyHandler: 'installed',
      codex: 'installed',
      claudeCode: 'not-installed',
      antigravityCli: 'installed',
      antigravityIde: 'installed-local-history',
      antigravity: 'installed-local-history'
    }
  })
  const serialized = JSON.stringify(status)
  for (const privateValue of [
    'https://tokenboard.example',
    'dev_123',
    'inst_123',
    '/home/user/.tokenboard',
    'secret'
  ]) {
    assert.equal(serialized.includes(privateValue), false)
  }
})

test('status exposes scheduled retry progress without the private error detail', () => {
  const status = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: {},
    hooks: {},
    deviceLink: {},
    scheduledRetry: {
      status: 'deferred',
      retryAttempt: 2,
      maxAttempts: 5,
      updatedAt: '2026-07-29T09:00:00.000Z',
      nextRetryAt: '2026-07-29T09:01:00.000Z',
      error: 'Timed out waiting for TokenBoard sync lock: /home/user/.tokenboard/sync.lock'
    }
  })

  assert.deepEqual(status.scheduledRetry, {
    status: 'deferred',
    retryAttempt: 2,
    maxAttempts: 5,
    updatedAt: '2026-07-29T09:00:00.000Z',
    nextRetryAt: '2026-07-29T09:01:00.000Z'
  })
  assert.equal(JSON.stringify(status).includes('/home/user/.tokenboard'), false)
})

test('status rejects non-canonical scheduled retry timestamps instead of normalizing them', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-timestamp-'))
  try {
    writeFileSync(join(root, 'config.json'), '{}\n')
    writeFileSync(
      join(root, 'scheduled-sync-retry.json'),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
        source: 'all',
        status: 'deferred',
        retryAttempt: 1,
        maxAttempts: 3,
        updatedAt: '2026-07-29T09:00:00+08:00',
        nextRetryAt: '2026-07-29'
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout).scheduledRetry, { status: 'invalid' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status fails visibly when the scheduled retry state is not readable', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-unreadable-'))
  try {
    writeFileSync(join(root, 'config.json'), '{}\n')
    mkdirSync(join(root, 'scheduled-sync-retry.json'))

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /EISDIR|directory|read/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status preserves the legacy all-source retry state regardless of its stored source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-all-legacy-source-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'all' }))
    writeFileSync(
      scheduledRetryLegacyStatePath(root),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
        source: 'codex',
        status: 'deferred',
        retryAttempt: 1,
        maxAttempts: 3,
        updatedAt: '2026-07-29T09:00:00.000Z',
        nextRetryAt: '2026-07-29T09:01:00.000Z'
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).scheduledRetry.status, 'deferred')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status reads the retry state for the configured source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-source-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(
      scheduledRetryStatePath(root, 'codex'),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
        source: 'codex',
        status: 'deferred',
        retryAttempt: 1,
        maxAttempts: 3,
        updatedAt: '2026-07-29T09:00:00.000Z',
        nextRetryAt: '2026-07-29T09:01:00.000Z'
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).scheduledRetry.status, 'deferred')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status falls back to a legacy retry state only when its source matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-legacy-source-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(
      scheduledRetryLegacyStatePath(root),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
        source: 'codex',
        status: 'deferred',
        retryAttempt: 1,
        maxAttempts: 3,
        updatedAt: '2026-07-29T09:00:00.000Z',
        nextRetryAt: '2026-07-29T09:01:00.000Z'
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).scheduledRetry.status, 'deferred')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status exposes a legacy all-source retry state for a configured source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-legacy-all-source-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(
      scheduledRetryLegacyStatePath(root),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
        source: 'all',
        status: 'retrying',
        retryAttempt: 2,
        maxAttempts: 5,
        updatedAt: '2026-07-29T09:00:00.000Z'
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout).scheduledRetry, {
      status: 'retrying',
      retryAttempt: 2,
      maxAttempts: 5,
      updatedAt: '2026-07-29T09:00:00.000Z'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status prefers the newer legacy all-source retry state when source state is older', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-newer-legacy-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(
      scheduledRetryStatePath(root, 'codex'),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
        source: 'codex',
        status: 'completed',
        retryAttempt: 1,
        maxAttempts: 5,
        updatedAt: '2026-07-29T09:00:00.000Z'
      })
    )
    writeFileSync(
      scheduledRetryLegacyStatePath(root),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
        source: 'all',
        status: 'retrying',
        retryAttempt: 2,
        maxAttempts: 5,
        updatedAt: '2026-07-29T09:05:00.000Z'
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout).scheduledRetry, {
      status: 'retrying',
      retryAttempt: 2,
      maxAttempts: 5,
      updatedAt: '2026-07-29T09:05:00.000Z'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status preserves an invalid legacy retry state for a configured source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-legacy-invalid-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(scheduledRetryLegacyStatePath(root), '{ invalid json\n')

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout).scheduledRetry, { status: 'invalid' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status keeps an invalid source retry state authoritative over a valid legacy fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-source-invalid-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(scheduledRetryStatePath(root, 'codex'), '{ invalid json\n')
    writeFileSync(
      scheduledRetryLegacyStatePath(root),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
        source: 'all',
        status: 'retrying',
        retryAttempt: 1,
        maxAttempts: 3,
        updatedAt: '2026-07-29T09:00:00.000Z'
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout).scheduledRetry, { status: 'invalid' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status ignores a source retry state whose payload belongs to another source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-source-mismatch-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(
      scheduledRetryStatePath(root, 'codex'),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
        source: 'claude-code',
        status: 'deferred',
        retryAttempt: 1,
        maxAttempts: 3,
        updatedAt: '2026-07-29T09:00:00.000Z',
        nextRetryAt: '2026-07-29T09:01:00.000Z'
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.equal('scheduledRetry' in JSON.parse(result.stdout), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status does not expose a legacy retry state belonging to another source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-legacy-mismatch-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(
      scheduledRetryLegacyStatePath(root),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
        source: 'claude-code',
        status: 'deferred',
        retryAttempt: 1,
        maxAttempts: 3,
        updatedAt: '2026-07-29T09:00:00.000Z',
        nextRetryAt: '2026-07-29T09:01:00.000Z'
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.equal('scheduledRetry' in JSON.parse(result.stdout), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
