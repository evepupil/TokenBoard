import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildInstallCollectorArgs } from './setup-options.mjs'

test('passes setup repo-url override to install collector', () => {
  assert.deepEqual(
    buildInstallCollectorArgs({
      flags: { 'repo-url': 'https://github.com/example/TokenBoard.git' },
      packageManager: 'pnpm',
      installCollectorScript: '/repo/scripts/install-collector.mjs'
    }),
    [
      '/repo/scripts/install-collector.mjs',
      '--repo-url',
      'https://github.com/example/TokenBoard.git',
      '--package-manager',
      'pnpm'
    ]
  )
})

test('setup installs hooks only after initial sync succeeds', () => {
  const source = readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8')
  const syncIndex = source.indexOf("scriptPath('./sync.mjs')")
  const hookIndex = source.indexOf("scriptPath('./install-hook.mjs')")

  assert.notEqual(syncIndex, -1)
  assert.notEqual(hookIndex, -1)
  assert.ok(syncIndex < hookIndex)
})

test('setup activates an existing server profile without pairing again', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-existing-profile-'))
  try {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        activeServer: 'https://private.example.com',
        servers: {
          'https://prod.example.com': {
            endpoint: 'https://prod.example.com/api/v1/ingest',
            uploadToken: 'prod-token'
          },
          'https://private.example.com': {
            endpoint: 'https://private.example.com/api/v1/ingest',
            uploadToken: 'private-token'
          }
        },
        endpoint: 'https://private.example.com/api/v1/ingest',
        uploadToken: 'private-token'
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./setup.mjs', import.meta.url)),
        '--base-url',
        'https://prod.example.com',
        '--skip-collector',
        '--skip-schedule',
        '--skip-initial-sync',
        '--skip-hook'
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TOKENBOARD_CONFIG_DIR: directory }
      }
    )

    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(config.activeServer, 'https://prod.example.com')
    assert.equal(config.endpoint, 'https://prod.example.com/api/v1/ingest')
    assert.equal(config.uploadToken, 'prod-token')
    assert.equal(config.servers['https://private.example.com'].uploadToken, 'private-token')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('setup applies explicit install flags without dropping saved profile defaults', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-profile-options-'))
  try {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        activeServer: 'https://prod.example.com',
        servers: {
          'https://prod.example.com': {
            endpoint: 'https://prod.example.com/api/v1/ingest',
            uploadToken: 'prod-token',
            repoUrl: 'https://github.com/example/private.git',
            repoRef: 'release-branch',
            packageManager: 'bun',
            scheduleTimes: ['07:15', '19:45']
          }
        }
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./setup.mjs', import.meta.url)),
        '--base-url',
        'https://prod.example.com',
        '--repo-ref',
        'override-branch',
        '--schedule-times',
        '08:30,20:30',
        '--skip-collector',
        '--skip-schedule',
        '--skip-initial-sync',
        '--skip-hook'
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TOKENBOARD_CONFIG_DIR: directory }
      }
    )

    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(config.repoUrl, 'https://github.com/example/private.git')
    assert.equal(config.repoRef, 'override-branch')
    assert.equal(config.packageManager, 'bun')
    assert.deepEqual(config.scheduleTimes, ['08:30', '20:30'])
    assert.equal(config.servers['https://prod.example.com'].repoRef, 'override-branch')
    assert.deepEqual(config.servers['https://prod.example.com'].scheduleTimes, ['08:30', '20:30'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('setup reports saved profile activation failures without an uncaught stack', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-profile-error-'))
  try {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        activeServer: 'https://prod.example.com',
        servers: {
          'https://prod.example.com': {
            endpoint: 'https://prod.example.com/api/v1/ingest',
            uploadToken: 'prod-token',
            scheduleTimes: ['not-a-time']
          }
        }
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./setup.mjs', import.meta.url)),
        '--base-url',
        'https://prod.example.com',
        '--skip-collector',
        '--skip-schedule',
        '--skip-initial-sync',
        '--skip-hook'
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TOKENBOARD_CONFIG_DIR: directory }
      }
    )

    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'Invalid schedule time: not-a-time. Expected HH:MM in 24-hour format.\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('setup activates the profile read after acquiring the credentials lock', () => {
  const source = readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8')
  const lockBody = source.slice(
    source.indexOf('withSetupCredentialsLock(() => {'),
    source.indexOf("console.log('TokenBoard server profile activated.')")
  )

  assert.match(lockBody, /const latestProfile = reusableServerProfile\(latestConfig, serverOrigin\)/)
  assert.match(lockBody, /withServerProfile\(latestConfig, serverOrigin, \{/)
  assert.doesNotMatch(lockBody, /withServerProfile\(latestConfig, serverOrigin, savedProfile\)/)
})

test('setup honors explicit device-link reconnect over an existing server profile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-setup-device-link-priority-'))
  try {
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        activeServer: 'https://prod.example.com',
        servers: {
          'https://prod.example.com': {
            endpoint: 'https://prod.example.com/api/v1/ingest',
            uploadToken: 'revoked-token'
          }
        },
        endpoint: 'https://prod.example.com/api/v1/ingest',
        uploadToken: 'revoked-token'
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./setup.mjs', import.meta.url)),
        '--base-url',
        'https://prod.example.com',
        '--use-device-link',
        '--skip-collector',
        '--skip-schedule',
        '--skip-initial-sync',
        '--skip-hook'
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TOKENBOARD_CONFIG_DIR: directory }
      }
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /TokenBoard device link not found/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
