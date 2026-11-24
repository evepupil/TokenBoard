import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  buildStatus,
  collectRecentRunSummary,
  readClientStatus,
  readClientVersionNotice,
  redactPath
} from './status.mjs'
import { clientVersionStatePath } from './client-version-state.mjs'
import { scheduledRetryLegacyStatePath, scheduledRetryStatePath } from './scheduled-retry.mjs'
import { scheduledSyncStatePath } from './scheduled-sync-state.mjs'

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
    clientType: 'git',
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

test('status exposes scheduled sync progress without private error details', () => {
  const status = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: {},
    hooks: {},
    deviceLink: {},
    scheduledSync: {
      schemaVersion: 'tokenboard-scheduled-sync/v1',
      source: 'all',
      status: 'failed',
      startedAt: '2026-09-20T01:00:00.000Z',
      updatedAt: '2026-09-20T01:05:00.000Z',
      completedAt: '2026-09-20T01:05:00.000Z',
      exitCode: 1,
      error: '/home/user/.tokenboard/private-error'
    }
  })

  assert.deepEqual(status.scheduledSync, {
    status: 'failed',
    source: 'all',
    startedAt: '2026-09-20T01:00:00.000Z',
    updatedAt: '2026-09-20T01:05:00.000Z',
    completedAt: '2026-09-20T01:05:00.000Z',
    exitCode: 1
  })
  assert.equal(JSON.stringify(status).includes('private-error'), false)
})

test('status reads the source-specific scheduled sync state file', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-scheduled-source-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(
      scheduledSyncStatePath(root, 'codex'),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync/v1',
        source: 'codex',
        status: 'success',
        startedAt: '2026-09-20T01:00:00.000Z',
        updatedAt: '2026-09-20T01:05:00.000Z',
        completedAt: '2026-09-20T01:05:00.000Z',
        exitCode: 0
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
    assert.deepEqual(JSON.parse(result.stdout).scheduledSync, {
      status: 'success',
      source: 'codex',
      startedAt: '2026-09-20T01:00:00.000Z',
      updatedAt: '2026-09-20T01:05:00.000Z',
      completedAt: '2026-09-20T01:05:00.000Z',
      exitCode: 0
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status reads run logs from the state directory, not the config directory', () => {
  // The coordinator writes `runs/` under resolveStateDir (STATE_DIR ||
  // CONFIG_DIR || ~/.tokenboard). A user who only sets TOKENBOARD_STATE_DIR
  // must still see their recent runs.
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-runs-dir-'))
  const stateRoot = mkdtempSync(join(tmpdir(), 'tokenboard-status-runs-state-'))
  try {
    writeFileSync(join(root, 'config.json'), '{}\n')
    mkdirSync(join(stateRoot, 'runs'), { recursive: true })
    // Run files are named by their start time; the summary only counts the
    // last seven days, so the fixture has to be recent.
    const started = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const runId = started.replace(/:/g, '-')
    writeFileSync(
      join(stateRoot, 'runs', `${runId}.json`),
      JSON.stringify({ runId, startedAt: started, status: 'success', exitCode: 0 })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: stateRoot
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).recentRuns.total, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  }
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

// The unsuffixed state file is written by a `--source all` install, so a per-source
// configuration has to fall back to it. The previous comparison required the stored
// source to equal the configured one, which a file that always says 'all' can never
// satisfy — the fallback was unreachable and the sync state simply went missing.
test('status exposes a legacy all-source sync state for a configured source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-sync-legacy-all-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(
      scheduledSyncStatePath(root),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync/v1',
        source: 'all',
        status: 'success',
        startedAt: '2026-07-29T09:00:00.000Z',
        updatedAt: '2026-07-29T09:01:00.000Z',
        completedAt: '2026-07-29T09:01:00.000Z',
        exitCode: 0
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: { ...process.env, TOKENBOARD_CONFIG_DIR: root, TOKENBOARD_STATE_DIR: root },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.stdout).scheduledSync, {
      status: 'success',
      source: 'all',
      startedAt: '2026-07-29T09:00:00.000Z',
      updatedAt: '2026-07-29T09:01:00.000Z',
      completedAt: '2026-07-29T09:01:00.000Z',
      exitCode: 0
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A per-source file still wins, and a legacy file for a *different* named source is not
// silently adopted — only the 'all' fallback is shared.
test('status prefers a per-source sync state over the legacy all-source one', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-sync-source-wins-'))
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ source: 'codex' }))
    writeFileSync(
      scheduledSyncStatePath(root),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync/v1',
        source: 'all',
        status: 'failed',
        startedAt: '2026-07-29T08:00:00.000Z',
        updatedAt: '2026-07-29T08:01:00.000Z',
        exitCode: 1
      })
    )
    writeFileSync(
      scheduledSyncStatePath(root, 'codex'),
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync/v1',
        source: 'codex',
        status: 'success',
        startedAt: '2026-07-29T09:00:00.000Z',
        updatedAt: '2026-07-29T09:01:00.000Z',
        completedAt: '2026-07-29T09:01:00.000Z',
        exitCode: 0
      })
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: { ...process.env, TOKENBOARD_CONFIG_DIR: root, TOKENBOARD_STATE_DIR: root },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).scheduledSync.source, 'codex')
    assert.equal(JSON.parse(result.stdout).scheduledSync.status, 'success')
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

test('status surfaces the upgraded commit only when the config records one', () => {
  const base = {
    activeServer: 'https://tokenboard.example',
    timezone: 'Asia/Shanghai',
    source: 'all'
  }
  const withoutCommit = buildStatus({ configPath: '/home/user/.tokenboard/config.json', config: base })
  assert.equal('lastUpgradedCommit' in withoutCommit, false)
  assert.equal('upgradedAt' in withoutCommit, false)

  const withCommit = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: { ...base, upgradedCommit: 'a'.repeat(40), upgradedAt: '2026-10-14T01:00:00.000Z' }
  })
  assert.equal(withCommit.lastUpgradedCommit, 'a'.repeat(40))
  assert.equal(withCommit.upgradedAt, '2026-10-14T01:00:00.000Z')
})

test('aggregates the last 7 days of run logs by filename prefix', () => {
  const files = {
    '2026-10-08T09-00-00.000Z-aaa111.json': JSON.stringify({ status: 'success' }),
    '2026-10-12T09-00-00.000Z-bbb222.json': JSON.stringify({ status: 'success' }),
    '2026-10-13T09-00-00.000Z-ccc333.json': JSON.stringify({ status: 'error' }),
    '2026-10-13T10-00-00.000Z-ddd444.json': JSON.stringify({
      status: 'skipped',
      coordination: { skippedSync: true, skippedReason: 'cooldown' }
    }),
    '2026-10-06T09-00-00.000Z-eee555.json': JSON.stringify({ status: 'error' })
  }
  const summary = collectRecentRunSummary('/state/runs', {
    now: new Date('2026-10-14T00:00:00.000Z'),
    readdir: () => Object.keys(files),
    readFile: (path) => {
      const name = basename(path)
      if (!(name in files)) throw new Error('unexpected ' + name)
      return files[name]
    }
  })
  assert.deepEqual(summary, {
    windowDays: 7,
    total: 4,
    success: 2,
    error: 1,
    skipped: 1,
    skippedReasons: { cooldown: 1 },
    invalid: 0,
    lastErrorAt: '2026-10-13T09:00:00.000Z'
  })
})

// Skips outweigh successes in a normal week, so the totals alone cannot tell an operator
// whether the collector is throttled by design or starved by a broken host or endpoint.
test('breaks skipped runs down by reason', () => {
  const files = {
    '2026-10-13T09-00-00.000Z-a.json': JSON.stringify({
      status: 'skipped',
      coordination: { skippedReason: 'resource-pressure' }
    }),
    '2026-10-13T09-10-00.000Z-b.json': JSON.stringify({
      status: 'skipped',
      coordination: { skippedReason: 'resource-pressure' }
    }),
    '2026-10-13T09-20-00.000Z-c.json': JSON.stringify({
      status: 'skipped',
      coordination: { skippedReason: 'failure-backoff' }
    }),
    '2026-10-13T09-30-00.000Z-d.json': JSON.stringify({ status: 'skipped' })
  }
  const summary = collectRecentRunSummary('/state/runs', {
    now: new Date('2026-10-14T00:00:00.000Z'),
    readdir: () => Object.keys(files),
    readFile: (path) => files[basename(path)]
  })
  assert.equal(summary.skipped, 4)
  assert.deepEqual(summary.skippedReasons, { 'resource-pressure': 2, 'failure-backoff': 1 })
})

test('half-written run files count as invalid and never surface content', () => {
  const summary = collectRecentRunSummary('/state/runs', {
    now: new Date('2026-10-14T00:00:00.000Z'),
    readdir: () => ['2026-10-13T09-00-00.000Z-ccc333.json'],
    readFile: () => '{"status": "err' // truncated write
  })
  assert.equal(summary.invalid, 1)
  assert.equal(summary.total, 1)
  const serialized = JSON.stringify(summary)
  assert.equal(serialized.includes('"status"'), false)
  assert.equal(serialized.includes('status":"err'), false)
})

test('an absent runs directory omits the block', () => {
  const summary = collectRecentRunSummary('/state/runs', {
    now: new Date('2026-10-14T00:00:00.000Z'),
    readdir: () => {
      const error = new Error('no such dir')
      error.code = 'ENOENT'
      throw error
    },
    readFile: () => {
      throw new Error('unreachable')
    }
  })
  assert.equal(summary, null)
})

test('status surfaces an active upload pause and omits an absent one', () => {
  const base = { activeServer: 'https://tokenboard.example', timezone: 'Asia/Shanghai', source: 'all' }
  const withoutBackoff = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: base,
    uploadBackoff: null
  })
  assert.equal('uploadBackoff' in withoutBackoff, false)

  const paused = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: base,
    uploadBackoff: { pausedUntil: '2026-10-15T00:00:00.000Z', consecutiveFailures: 5 }
  })
  assert.deepEqual(paused.uploadBackoff, { pausedUntil: '2026-10-15T00:00:00.000Z', consecutiveFailures: 5 })
})

// The notify worker runs detached with stdio ignored; a fatal error there used
// to be invisible. Status reports the recorded messages so an operator can see
// why hooks stopped dispatching.
test('status surfaces fatal notify-worker errors and omits an empty list', () => {
  const base = { activeServer: 'https://tokenboard.example', timezone: 'Asia/Shanghai', source: 'all' }
  assert.equal(
    'notifyWorkerErrors' in buildStatus({ configPath: '/c.json', config: base, notifyWorkerErrors: [] }),
    false
  )
  const reported = buildStatus({
    configPath: '/c.json',
    config: base,
    notifyWorkerErrors: [{ message: 'TokenBoard config is not valid JSON: /c.json', at: '2026-10-30T00:00:00.000Z' }]
  })
  assert.deepEqual(reported.notifyWorkerErrors, [
    { message: 'TokenBoard config is not valid JSON: /c.json', at: '2026-10-30T00:00:00.000Z' }
  ])
})

// A binary install's health is not visible from clientType alone: the client
// can be missing. A ccusage copy is still reported when one sits beside it —
// an earlier release may have left one — but it is informational only.
test('status reports the installed binary and any ccusage left beside it', () => {
  const status = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: { clientType: 'binary', timezone: 'UTC', source: 'all' },
    client: {
      present: true,
      version: '1.2.3',
      ccusagePresent: true,
      ccusageVersion: '20.0.33'
    }
  })
  assert.equal(status.client.present, true)
  assert.equal(status.client.version, '1.2.3')
  assert.equal(status.client.ccusagePresent, true)
  assert.equal(status.client.ccusageVersion, '20.0.33')
})

test('status reports a missing binary instead of implying a healthy install', () => {
  const status = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: { clientType: 'binary', timezone: 'UTC', source: 'all' },
    client: { present: false, version: null, ccusagePresent: false, ccusageVersion: null }
  })
  assert.equal(status.client.present, false)
  assert.equal(status.client.version, null)
  assert.equal(status.client.ccusagePresent, false)
})

// A git install has no released binary to report.
test('status omits the client block for a git install', () => {
  const status = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: { clientType: 'git', timezone: 'UTC', source: 'all' }
  })
  assert.equal(status.client, undefined)
})

// The probe reports what is on disk, not what the config claims: a deleted
// binary or an unreadable one must not look like a healthy install.
test('readClientStatus reports a real installed client and any ccusage beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-status-'))
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    const spawn = (path, args) => {
      // Each binary answers its own flag; asserting it here is what catches a
      // probe that runs the wrong one and reads a usage line as a version.
      assert.deepEqual(args, path.endsWith('ccusage') ? ['--version'] : ['version'])
      const printed = path.endsWith('ccusage') ? 'ccusage 20.0.33' : 'tokenboard (go) 1.2.3'
      return { status: 0, stdout: printed + '\n', stderr: '' }
    }
    const status = readClientStatus({ configDir: dir, platform: 'darwin', spawn, exists: () => true })
    assert.deepEqual(status, {
      present: true,
      version: '1.2.3',
      ccusagePresent: true,
      ccusageVersion: '20.0.33'
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readClientStatus reports missing files without running them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-status-'))
  try {
    const status = readClientStatus({
      configDir: dir,
      platform: 'darwin',
      spawn: () => assert.fail('a missing binary must not be executed'),
      exists: (path) => path.endsWith('ccusage')
    })
    assert.equal(status.present, false)
    assert.equal(status.version, null)
    assert.equal(status.ccusagePresent, true)
    assert.equal(status.ccusageVersion, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The per-source rollout map is reported as written, and only when present,
// so an operator can see which sources have moved to the binary client.
test('status reports the perSource rollout map', () => {
  const base = {
    configPath: '/home/user/.tokenboard/config.json',
    config: {
      timezone: 'UTC',
      source: 'all',
      perSource: { pi: 'go', codex: 'ts' }
    },
    hooks: {}
  }
  assert.deepEqual(buildStatus(base).perSource, { pi: 'go', codex: 'ts' })
  delete base.config.perSource
  assert.equal('perSource' in buildStatus(base), false)
})

// The dual run's recent verdicts belong in the daily health check: deciding
// whether a source can move onto the Go client needs the comparison log, and
// making the operator run a second command is how that log stops being read.
// Only counts and timestamps are exposed — the log's records carry messages
// that can include local paths.
test('status reports the dual-run trend from the log the harness writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-shadow-'))
  try {
    writeFileSync(join(root, 'config.json'), '{}\n')
    mkdirSync(join(root, 'logs'), { recursive: true })
    // Relative to now: the summary is omitted once its newest record is older
    // than a week (see collectShadowDualRunSummary), so fixed dates would turn
    // this test into a calendar bomb.
    const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
    const firstAt = hoursAgo(30)
    const lastAt = hoursAgo(20)
    writeFileSync(
      join(root, 'logs', 'shadow-dual-run.jsonl'),
      [
        JSON.stringify({ at: firstAt, source: 'claude-code', status: 'match', snapshots: 40 }),
        JSON.stringify({
          at: lastAt,
          source: 'claude-code',
          status: 'diff',
          message: '/home/user/private'
        }),
        ''
      ].join('\n')
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: { ...process.env, TOKENBOARD_CONFIG_DIR: root, TOKENBOARD_STATE_DIR: root },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    const status = JSON.parse(result.stdout)
    assert.deepEqual(status.shadowDualRun, {
      records: 2,
      firstAt,
      lastAt,
      match: 1,
      empty: 0,
      diff: 1,
      notInstalled: 0,
      busy: 0,
      error: 0,
      lastDiffAt: lastAt
    })
    assert.equal(JSON.stringify(status).includes('/home/user/private'), false)
    assert.equal(JSON.stringify(status).includes('shadow-dual-run.jsonl'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status omits the dual-run trend when the harness log is older than a week', () => {
  // The scheduled comparison moved to observation-dual-run.jsonl on 2026-11-12;
  // shadow-dual-run.jsonl now only receives manual `shadow-dual-run.mjs` runs.
  // A stale record set keeps describing the old harness long after it stopped,
  // so one whose newest record is older than the window is dropped instead.
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-shadow-stale-'))
  try {
    writeFileSync(join(root, 'config.json'), '{}\n')
    mkdirSync(join(root, 'logs'), { recursive: true })
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(
      join(root, 'logs', 'shadow-dual-run.jsonl'),
      `${JSON.stringify({ at: eightDaysAgo, source: 'pi', status: 'match', snapshots: 1 })}\n`
    )

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./status.mjs', import.meta.url))], {
      env: { ...process.env, TOKENBOARD_CONFIG_DIR: root, TOKENBOARD_STATE_DIR: root },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.equal('shadowDualRun' in JSON.parse(result.stdout), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// An empty log, or one whose only line was torn by an interrupted write, must
// not take the whole health check down: readRecentRecords deliberately tolerates
// torn lines and can therefore hand back an empty array, and the freshness check
// this summary gained on 2026-11-15 dereferenced the trend it never got.
test('status omits the trend for an empty or torn-only dual-run log', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-shadow-empty-'))
  const empty = mkdtempSync(join(tmpdir(), 'tokenboard-status-shadow-emptyfile-'))
  const torn = mkdtempSync(join(tmpdir(), 'tokenboard-status-shadow-torn-'))
  try {
    writeFileSync(join(root, 'config.json'), '{}\n')
    const emptyLog = join(empty, 'shadow-dual-run.jsonl')
    writeFileSync(emptyLog, '')
    const tornLog = join(torn, 'shadow-dual-run.jsonl')
    writeFileSync(tornLog, '{"at":"2026-11-15T00:00:00.000Z","source":"pi","sta')

    const script = fileURLToPath(new URL('./status.mjs', import.meta.url))
    const run = (env) =>
      spawnSync(process.execPath, [script], {
        env: { ...process.env, TOKENBOARD_CONFIG_DIR: root, TOKENBOARD_STATE_DIR: root, ...env },
        encoding: 'utf8'
      })

    for (const logPath of [emptyLog, tornLog]) {
      const result = run({ TOKENBOARD_SHADOW_DUAL_RUN_LOG: logPath })
      assert.equal(result.status, 0, `status failed for ${logPath}: ${result.stderr}`)
      assert.equal('shadowDualRun' in JSON.parse(result.stdout), false)
    }
  } finally {
    for (const dir of [root, empty, torn]) rmSync(dir, { recursive: true, force: true })
  }
})

test('status finds a moved dual-run log and omits the trend when none exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-status-shadow-move-'))
  const moved = mkdtempSync(join(tmpdir(), 'tokenboard-status-shadow-log-'))
  try {
    writeFileSync(join(root, 'config.json'), '{}\n')
    const logPath = join(moved, 'shadow-dual-run.jsonl')
    writeFileSync(
      logPath,
      `${JSON.stringify({ at: new Date().toISOString(), source: 'pi', status: 'empty', snapshots: 0 })}\n`
    )

    const script = fileURLToPath(new URL('./status.mjs', import.meta.url))
    const run = (env) =>
      spawnSync(process.execPath, [script], {
        env: { ...process.env, TOKENBOARD_CONFIG_DIR: root, TOKENBOARD_STATE_DIR: root, ...env },
        encoding: 'utf8'
      })

    const movedResult = run({ TOKENBOARD_SHADOW_DUAL_RUN_LOG: logPath })
    assert.equal(movedResult.status, 0)
    assert.equal(JSON.parse(movedResult.stdout).shadowDualRun.empty, 1)

    const absentResult = run({})
    assert.equal(absentResult.status, 0)
    assert.equal('shadowDualRun' in JSON.parse(absentResult.stdout), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(moved, { recursive: true, force: true })
  }
})

// status must surface the recorded client version change: it is the only place
// an operator can see when the version changed relative to the sync results.
test('buildStatus reports the recorded client version and when it changed', () => {
  const status = buildStatus({
    configPath: '/home/u/.tokenboard/config.json',
    config: { timezone: 'UTC', source: 'all', clientType: 'binary' },
    hooks: { claudeCode: 'not-installed', codex: 'not-installed', antigravity: 'not-installed' },
    deviceLink: { present: false },
    clientVersion: { version: '0.2.1', since: '2026-11-18T00:00:00.000Z', previous: '0.2.0' }
  })

  assert.deepEqual(status.clientVersion, {
    version: '0.2.1',
    since: '2026-11-18T00:00:00.000Z',
    previous: '0.2.0'
  })
})

test('buildStatus omits the clientVersion field when nothing is recorded', () => {
  const status = buildStatus({
    configPath: '/home/u/.tokenboard/config.json',
    config: { timezone: 'UTC', source: 'all', clientType: 'git' },
    hooks: { claudeCode: 'not-installed', codex: 'not-installed', antigravity: 'not-installed' },
    deviceLink: { present: false }
  })

  assert.equal('clientVersion' in status, false)
})

// A file system error names the absolute path it failed on, and status output
// is pasted into issues. The reason has to survive; the account name in the
// path does not.
test('an unreadable version record reports the reason without the path', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-status-path-'))
  const file = clientVersionStatePath(dir)
  writeFileSync(file, '{"schemaVersion":"tokenboard-client-version/v1"}', { mode: 0o000 })
  try {
    const notice = readClientVersionNotice(dir)
    assert.match(notice.error, /EACCES/)
    assert.doesNotMatch(notice.error, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    chmodSync(file, 0o600)
    rmSync(dir, { recursive: true, force: true })
  }
})

// The redaction itself, independent of how a platform reports permissions.
test('the recorded read error never carries a path', () => {
  const shapes = [
    "EACCES: permission denied, open '/home/alice/.tokenboard/client-version-state.json'",
    'open C:\\Users\\alice\\.tokenboard\\client-version-state.json: Access is denied.',
    // Spaces and parentheses are legal in a home directory, and splitting the
    // path on them left the account name behind.
    'open /Users/Alice Bob Smith/.tokenboard/client-version-state.json',
    'open /home/alice(work)/.tokenboard/client-version-state.json'
  ]
  for (const message of shapes) {
    const redacted = redactPath(message)
    assert.doesNotMatch(redacted, /alice|Alice|Smith|Bob|work/i, `a path survived redaction: ${redacted}`)
    assert.doesNotMatch(redacted, /[\\/]/, `a separator survived redaction: ${redacted}`)
  }
})

test('redaction leaves a reason without a path and a bare timestamp alone', () => {
  assert.equal(
    redactPath('EISDIR: illegal operation on a directory, read'),
    'EISDIR: illegal operation on a directory, read'
  )
  assert.equal(redactPath('2026-11-18T00:00:00.000Z'), '2026-11-18T00:00:00.000Z')
})

// A URL is not a path: redacting its slashes as one left "https:<path>", which
// is neither the reason nor a useful trace.
test('redaction replaces a URL as a whole', () => {
  assert.equal(redactPath('failed at https://example.com/releases/tag/v1.2.3'), 'failed at <url>')
})
