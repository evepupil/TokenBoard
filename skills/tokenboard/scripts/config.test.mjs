import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeConfig,
  normalizeActiveServerConfig,
  packageManagerCommand,
  parseArgs,
  readClientType,
  readPerSource,
  resolveClientForSource,
  readConfig,
  serverOriginFromEndpoint,
  stripUtf8Bom,
  withServerProfile,
  writeConfig
} from './config.mjs'
import { credentialsLockPath, withCredentialsLock } from './credentials-lock.mjs'

test('parseArgs accepts the --key=value spelling the project writes into hooks', () => {
  // The hook installers write `--source=codex` into every Codex config, so that
  // exact spelling has to work when a user copies it into sync.mjs. Read as a
  // bare key it would become a flag named `source=codex` no reader consults,
  // silently downgrading `--mode=preview` to a real upload.
  assert.deepEqual(parseArgs(['--mode=preview']), { mode: 'preview' })
  assert.deepEqual(parseArgs(['--source=codex']), { source: 'codex' })
  // A value containing `=` keeps everything after the first separator.
  assert.deepEqual(parseArgs(['--until=2026-10-01T00:00:00Z']), { until: '2026-10-01T00:00:00Z' })
  assert.deepEqual(parseArgs(['--endpoint=https://h/p?a=b']), { endpoint: 'https://h/p?a=b' })
  // An empty inline value is present-but-empty, not absent.
  assert.deepEqual(parseArgs(['--source=']), { source: '' })
})

test('parseArgs keeps the space-separated and boolean forms', () => {
  assert.deepEqual(parseArgs(['--source', 'codex']), { source: 'codex' })
  assert.deepEqual(parseArgs(['--scheduled']), { scheduled: true })
  assert.deepEqual(parseArgs(['--mode=preview', '--source', 'codex', '--scheduled']), {
    mode: 'preview',
    source: 'codex',
    scheduled: true
  })
  // A bare positional is not a flag.
  assert.deepEqual(parseArgs(['preview']), {})
})

test('readClientType defaults to git so an existing install is untouched', () => {
  assert.equal(readClientType({ flags: {}, env: {}, config: {} }), 'git')
  assert.equal(readClientType({ flags: {}, env: {}, config: { clientType: 'binary' } }), 'binary')
  assert.equal(readClientType({ flags: { client: 'binary' }, env: {}, config: {} }), 'binary')
  assert.equal(readClientType({ flags: {}, env: { TOKENBOARD_CLIENT: 'binary' }, config: {} }), 'binary')
})

test('readClientType prefers the flag over the environment and the config', () => {
  assert.equal(
    readClientType({
      flags: { client: 'git' },
      env: { TOKENBOARD_CLIENT: 'binary' },
      config: { clientType: 'binary' }
    }),
    'git'
  )
})

test('readClientType refuses an unknown value instead of silently running git', () => {
  assert.throws(
    () => readClientType({ flags: {}, env: {}, config: { clientType: 'cargo' } }),
    /Unsupported client type/
  )
  assert.throws(() => readClientType({ flags: { client: 'true' }, env: {}, config: {} }), /Unsupported client type/)
})

test('strips UTF-8 BOM before parsing config content', () => {
  const parsed = JSON.parse(stripUtf8Bom('\ufeff{"configured":true}'))

  assert.deepEqual(parsed, { configured: true })
})

test('leaves non-BOM config content unchanged', () => {
  const config = '{"configured":true}'

  assert.equal(stripUtf8Bom(config), config)
})

test('rejects config replacement after credentials lock ownership is lost', () => {
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-config-lock-fence-'))
  process.env.TOKENBOARD_CONFIG_DIR = directory
  try {
    assert.throws(
      () =>
        withCredentialsLock(directory, () => {
          writeFileSync(credentialsLockPath(directory), JSON.stringify({ pid: process.pid, token: 'replacement' }))
          writeConfig({ activeServer: 'https://tokenboard.example', servers: {} })
        }),
      /credentials lock ownership changed before write/
    )
    assert.equal(statSync(join(directory, 'config.json'), { throwIfNoEntry: false }), undefined)
  } finally {
    if (previousConfigDir === undefined) delete process.env.TOKENBOARD_CONFIG_DIR
    else process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    rmSync(directory, { recursive: true, force: true })
  }
})

test('uses bun.exe on Windows package manager commands', () => {
  assert.equal(packageManagerCommand('bun', 'win32'), 'bun.exe')
})

test('uses executable package manager commands on Windows when available', () => {
  assert.equal(packageManagerCommand('pnpm', 'win32'), 'pnpm.exe')
  assert.equal(packageManagerCommand('npm', 'win32'), 'npm.cmd')
})

test('extracts server origin from ingest endpoint', () => {
  assert.equal(
    serverOriginFromEndpoint('https://tokenboard.example.com/api/v1/ingest'),
    'https://tokenboard.example.com'
  )
})

test('writes active server profile while preserving other server credentials', () => {
  const config = withServerProfile(
    {
      activeServer: 'https://prod.example.com',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-token',
          deviceId: 'dev_prod',
          installationId: 'inst_prod',
          timezone: 'UTC'
        }
      }
    },
    'https://private.example.com',
    {
      endpoint: 'https://private.example.com/api/v1/ingest',
      uploadToken: 'private-token',
      deviceId: 'dev_private',
      installationId: 'inst_private',
      timezone: 'Asia/Shanghai'
    }
  )

  assert.equal(config.activeServer, 'https://private.example.com')
  assert.equal(config.uploadToken, 'private-token')
  assert.equal(config.installationId, 'inst_private')
  assert.equal(config.servers['https://prod.example.com'].uploadToken, 'prod-token')
})

test('migrates legacy root credentials before activating another server profile', () => {
  const config = withServerProfile(
    {
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'prod-token',
      deviceId: 'dev_prod',
      installationId: 'inst_prod',
      repoUrl: 'https://github.com/example/prod.git',
      repoRef: 'prod-branch'
    },
    'https://private.example.com',
    {
      endpoint: 'https://private.example.com/api/v1/ingest',
      uploadToken: 'private-token',
      deviceId: 'dev_private',
      installationId: 'inst_private'
    }
  )

  assert.equal(config.activeServer, 'https://private.example.com')
  assert.equal(config.uploadToken, 'private-token')
  assert.equal(config.servers['https://prod.example.com'].uploadToken, 'prod-token')
  assert.equal(config.servers['https://prod.example.com'].deviceId, 'dev_prod')
  assert.equal(config.servers['https://prod.example.com'].repoUrl, 'https://github.com/example/prod.git')
  assert.equal(config.servers['https://prod.example.com'].repoRef, 'prod-branch')
  assert.equal(config.servers['https://private.example.com'].uploadToken, 'private-token')
})

test('normalizes config by mirroring the active server profile', () => {
  const config = normalizeActiveServerConfig({
    activeServer: 'https://prod.example.com',
    servers: {
      'https://prod.example.com': {
        endpoint: 'https://prod.example.com/api/v1/ingest',
        uploadToken: 'prod-token',
        deviceId: 'dev_prod',
        installationId: 'inst_prod',
        timezone: 'UTC'
      }
    },
    endpoint: 'https://stale.example.com/api/v1/ingest',
    uploadToken: 'stale-token'
  })

  assert.equal(config.endpoint, 'https://prod.example.com/api/v1/ingest')
  assert.equal(config.uploadToken, 'prod-token')
  assert.equal(config.installationId, 'inst_prod')
})

test('mergeConfig updates the active server profile as well as the mirrored root fields', () => {
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  process.env.TOKENBOARD_CONFIG_DIR = directory

  try {
    writeConfig({
      activeServer: 'https://prod.example.com',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-token',
          collectorDir: '/old/collector',
          repoUrl: 'https://github.com/example/old.git',
          repoRef: 'old-branch'
        },
        'https://private.example.com': {
          endpoint: 'https://private.example.com/api/v1/ingest',
          uploadToken: 'private-token',
          collectorDir: '/private/collector'
        }
      },
      endpoint: 'https://stale.example.com/api/v1/ingest',
      uploadToken: 'stale-token'
    })

    mergeConfig({
      collectorDir: '/new/collector',
      repoUrl: 'https://github.com/example/new.git',
      repoRef: 'new-branch',
      packageManager: 'pnpm',
      servers: {
        'https://private.example.com': {
          collectorDir: '/private/new-collector'
        }
      }
    })

    const raw = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(raw.collectorDir, '/new/collector')
    assert.equal(raw.servers['https://prod.example.com'].collectorDir, '/new/collector')
    assert.equal(raw.servers['https://prod.example.com'].repoUrl, 'https://github.com/example/new.git')
    assert.equal(raw.servers['https://prod.example.com'].repoRef, 'new-branch')
    assert.equal(raw.servers['https://private.example.com'].uploadToken, 'private-token')
    assert.equal(raw.servers['https://private.example.com'].collectorDir, '/private/new-collector')

    const normalized = readConfig()
    assert.equal(normalized.collectorDir, '/new/collector')
    assert.equal(normalized.repoUrl, 'https://github.com/example/new.git')
    assert.equal(normalized.repoRef, 'new-branch')
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.TOKENBOARD_CONFIG_DIR
    } else {
      process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('mergeConfig can switch active server without overwriting the previous profile', () => {
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-config-switch-'))
  process.env.TOKENBOARD_CONFIG_DIR = directory

  try {
    writeConfig({
      activeServer: 'https://prod.example.com',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-token',
          collectorDir: '/prod/collector'
        },
        'https://private.example.com': {
          endpoint: 'https://private.example.com/api/v1/ingest',
          uploadToken: 'private-token',
          collectorDir: '/private/collector'
        }
      },
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'prod-token'
    })

    mergeConfig({
      activeServer: 'https://private.example.com',
      uploadToken: 'private-new-token',
      repoUrl: 'https://github.com/example/private.git',
      servers: {
        'https://private.example.com': {
          collectorDir: '/private/new-collector'
        }
      }
    })

    const raw = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(raw.activeServer, 'https://private.example.com')
    assert.equal(raw.uploadToken, 'private-new-token')
    assert.equal(raw.repoUrl, 'https://github.com/example/private.git')
    assert.equal(raw.servers['https://private.example.com'].uploadToken, 'private-new-token')
    assert.equal(raw.servers['https://private.example.com'].collectorDir, '/private/new-collector')
    assert.equal(raw.servers['https://private.example.com'].repoUrl, 'https://github.com/example/private.git')
    assert.equal(raw.servers['https://prod.example.com'].uploadToken, 'prod-token')
    assert.equal(raw.servers['https://prod.example.com'].collectorDir, '/prod/collector')

    const normalized = readConfig()
    assert.equal(normalized.activeServer, 'https://private.example.com')
    assert.equal(normalized.uploadToken, 'private-new-token')
    assert.equal(normalized.collectorDir, '/private/new-collector')
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.TOKENBOARD_CONFIG_DIR
    } else {
      process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('mergeConfig does not mirror stale profile fields when switching servers', () => {
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-config-switch-clean-'))
  process.env.TOKENBOARD_CONFIG_DIR = directory

  try {
    writeConfig({
      activeServer: 'https://prod.example.com',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-token',
          collectorDir: '/prod/collector',
          repoUrl: 'https://github.com/example/prod.git',
          repoRef: 'prod-branch',
          scheduleTimes: ['09:00'],
          updatedAt: '2026-06-30T10:00:00.000Z'
        },
        'https://private.example.com': {
          endpoint: 'https://private.example.com/api/v1/ingest',
          uploadToken: 'private-token'
        }
      },
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'prod-token',
      collectorDir: '/prod/collector',
      repoUrl: 'https://github.com/example/prod.git',
      repoRef: 'prod-branch',
      source: 'all',
      packageManager: 'bun',
      scheduleTimes: ['09:00'],
      createdAt: '2026-06-29T10:00:00.000Z',
      updatedAt: '2026-06-30T10:00:00.000Z'
    })

    mergeConfig({
      activeServer: 'https://private.example.com',
      uploadToken: 'private-new-token'
    })

    const raw = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(raw.activeServer, 'https://private.example.com')
    assert.equal(raw.uploadToken, 'private-new-token')
    assert.equal(raw.repoUrl, undefined)
    assert.equal(raw.repoRef, undefined)
    assert.equal(raw.collectorDir, undefined)
    assert.equal(raw.source, undefined)
    assert.equal(raw.packageManager, undefined)
    assert.equal(raw.scheduleTimes, undefined)
    assert.equal(raw.createdAt, undefined)
    assert.equal(raw.updatedAt, undefined)
    assert.equal(raw.servers['https://private.example.com'].repoUrl, undefined)
    assert.equal(raw.servers['https://prod.example.com'].repoUrl, 'https://github.com/example/prod.git')

    const normalized = readConfig()
    assert.equal(normalized.uploadToken, 'private-new-token')
    assert.equal(normalized.repoUrl, undefined)
    assert.equal(normalized.repoRef, undefined)
    assert.equal(normalized.collectorDir, undefined)
    assert.equal(normalized.source, undefined)
    assert.equal(normalized.packageManager, undefined)
    assert.equal(normalized.scheduleTimes, undefined)
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.TOKENBOARD_CONFIG_DIR
    } else {
      process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('mergeConfig keeps global fields outside server profiles across switches', () => {
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-config-global-'))
  process.env.TOKENBOARD_CONFIG_DIR = directory

  try {
    writeConfig({
      activeServer: 'https://prod.example.com',
      globalFlag: 'initial',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-token'
        },
        'https://private.example.com': {
          endpoint: 'https://private.example.com/api/v1/ingest',
          uploadToken: 'private-token'
        }
      }
    })

    mergeConfig({ globalFlag: 'prod-global' })
    let raw = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(raw.globalFlag, 'prod-global')
    assert.equal(raw.servers['https://prod.example.com'].globalFlag, undefined)

    mergeConfig({ activeServer: 'https://private.example.com' })
    mergeConfig({ globalFlag: 'private-global' })
    raw = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(raw.globalFlag, 'private-global')
    assert.equal(raw.servers['https://private.example.com'].globalFlag, undefined)

    mergeConfig({ activeServer: 'https://prod.example.com' })
    raw = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(raw.globalFlag, 'private-global')
    assert.equal(raw.servers['https://prod.example.com'].globalFlag, undefined)

    const normalized = readConfig()
    assert.equal(normalized.globalFlag, 'private-global')
    assert.equal(normalized.endpoint, 'https://prod.example.com/api/v1/ingest')
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.TOKENBOARD_CONFIG_DIR
    } else {
      process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('normalizeActiveServerConfig ignores legacy global fields inside profiles', () => {
  const config = normalizeActiveServerConfig({
    activeServer: 'https://prod.example.com',
    globalFlag: 'root-global',
    servers: {
      'https://prod.example.com': {
        endpoint: 'https://prod.example.com/api/v1/ingest',
        uploadToken: 'prod-token',
        globalFlag: 'stale-profile-global'
      }
    }
  })

  assert.equal(config.endpoint, 'https://prod.example.com/api/v1/ingest')
  assert.equal(config.uploadToken, 'prod-token')
  assert.equal(config.globalFlag, 'root-global')
})

test('withServerProfile does not carry stale root fields to another server', () => {
  const config = withServerProfile(
    {
      activeServer: 'https://prod.example.com',
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'prod-token',
      collectorDir: '/prod/collector',
      repoUrl: 'https://github.com/example/prod.git',
      repoRef: 'prod-branch',
      source: 'all',
      packageManager: 'bun',
      scheduleTimes: ['09:00'],
      createdAt: '2026-06-29T10:00:00.000Z',
      updatedAt: '2026-06-30T10:00:00.000Z',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-token',
          collectorDir: '/prod/collector',
          repoUrl: 'https://github.com/example/prod.git',
          repoRef: 'prod-branch',
          scheduleTimes: ['09:00'],
          updatedAt: '2026-06-30T10:00:00.000Z'
        }
      }
    },
    'https://private.example.com',
    {
      endpoint: 'https://private.example.com/api/v1/ingest',
      uploadToken: 'private-token'
    }
  )

  assert.equal(config.activeServer, 'https://private.example.com')
  assert.equal(config.endpoint, 'https://private.example.com/api/v1/ingest')
  assert.equal(config.uploadToken, 'private-token')
  assert.equal(config.repoUrl, undefined)
  assert.equal(config.repoRef, undefined)
  assert.equal(config.collectorDir, undefined)
  assert.equal(config.source, undefined)
  assert.equal(config.packageManager, undefined)
  assert.equal(config.scheduleTimes, undefined)
  assert.equal(config.createdAt, undefined)
  assert.equal(config.updatedAt, undefined)
  assert.equal(config.servers['https://prod.example.com'].repoUrl, 'https://github.com/example/prod.git')
})

test('withServerProfile preserves existing fields when setup profile patch omits them', () => {
  const config = withServerProfile(
    {
      activeServer: 'https://private.example.com',
      repoUrl: 'https://github.com/example/private.git',
      repoRef: 'release-branch',
      servers: {
        'https://private.example.com': {
          endpoint: 'https://private.example.com/api/v1/ingest',
          uploadToken: 'old-token',
          repoUrl: 'https://github.com/example/private.git',
          repoRef: 'release-branch'
        }
      }
    },
    'https://private.example.com',
    {
      endpoint: 'https://private.example.com/api/v1/ingest',
      uploadToken: 'new-token',
      repoUrl: undefined,
      repoRef: undefined
    }
  )

  assert.equal(config.uploadToken, 'new-token')
  assert.equal(config.repoUrl, 'https://github.com/example/private.git')
  assert.equal(config.repoRef, 'release-branch')
  assert.equal(config.servers['https://private.example.com'].repoUrl, 'https://github.com/example/private.git')
  assert.equal(config.servers['https://private.example.com'].repoRef, 'release-branch')
})

test('withServerProfile stores only profile-scoped fields', () => {
  const config = withServerProfile(
    {
      activeServer: 'https://prod.example.com',
      globalFlag: 'root-global',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'old-token',
          globalFlag: 'legacy-profile-global'
        }
      }
    },
    'https://prod.example.com',
    {
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'new-token',
      collectorDir: '/prod/collector',
      globalFlag: 'patch-profile-global'
    }
  )

  assert.equal(config.globalFlag, 'root-global')
  assert.equal(config.collectorDir, '/prod/collector')
  assert.equal(config.servers['https://prod.example.com'].uploadToken, 'new-token')
  assert.equal(config.servers['https://prod.example.com'].collectorDir, '/prod/collector')
  assert.equal(config.servers['https://prod.example.com'].globalFlag, undefined)
})

test('mergeConfig stores only profile-scoped fields from server patches', () => {
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-config-profile-scope-'))
  process.env.TOKENBOARD_CONFIG_DIR = directory

  try {
    writeConfig({
      activeServer: 'https://prod.example.com',
      globalFlag: 'root-global',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-token',
          globalFlag: 'legacy-prod-profile-global'
        },
        'https://private.example.com': {
          endpoint: 'https://private.example.com/api/v1/ingest',
          uploadToken: 'private-token'
        }
      }
    })

    mergeConfig({
      servers: {
        'https://prod.example.com': {
          collectorDir: '/prod/collector',
          globalFlag: 'patch-prod-profile-global'
        },
        'https://private.example.com': {
          collectorDir: '/private/collector',
          globalFlag: 'patch-private-profile-global'
        }
      }
    })

    const raw = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    assert.equal(raw.globalFlag, 'root-global')
    assert.equal(raw.servers['https://prod.example.com'].collectorDir, '/prod/collector')
    assert.equal(raw.servers['https://prod.example.com'].globalFlag, undefined)
    assert.equal(raw.servers['https://private.example.com'].collectorDir, '/private/collector')
    assert.equal(raw.servers['https://private.example.com'].globalFlag, undefined)

    const normalized = readConfig()
    assert.equal(normalized.globalFlag, 'root-global')
    assert.equal(normalized.collectorDir, '/prod/collector')
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.TOKENBOARD_CONFIG_DIR
    } else {
      process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('writeConfig re-tightens existing config file permissions', { skip: process.platform === 'win32' }, () => {
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-config-mode-'))
  process.env.TOKENBOARD_CONFIG_DIR = directory

  try {
    writeConfig({ endpoint: 'https://tokenboard.example/api/v1/ingest' })
    const file = join(directory, 'config.json')
    chmodSync(file, 0o644)
    writeConfig({ endpoint: 'https://tokenboard.example/api/v1/ingest', timezone: 'UTC' })

    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.TOKENBOARD_CONFIG_DIR
    } else {
      process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

// The directory holds the config file, and `mkdirSync`'s mode applies only when it creates the
// directory — a pre-existing or later-loosened one keeps its own mode. writeConfig tightens it,
// so the token is never left readable by other users on the machine.
test('writeConfig re-tightens an existing config directory', { skip: process.platform === 'win32' }, () => {
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-config-dir-mode-'))
  process.env.TOKENBOARD_CONFIG_DIR = directory

  try {
    chmodSync(directory, 0o777)
    writeConfig({ endpoint: 'https://tokenboard.example/api/v1/ingest' })

    assert.equal(statSync(directory).mode & 0o777, 0o700)
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.TOKENBOARD_CONFIG_DIR
    } else {
      process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('mergeConfig preserves concurrent server profile updates across processes', async () => {
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-config-concurrent-'))
  process.env.TOKENBOARD_CONFIG_DIR = directory
  try {
    writeConfig({
      activeServer: 'https://base.example.com',
      servers: {
        'https://base.example.com': {
          endpoint: 'https://base.example.com/api/v1/ingest',
          uploadToken: 'base-token'
        }
      }
    })
    const script = [
      "import { mergeConfig } from './config.mjs'",
      'mergeConfig(JSON.parse(process.env.TOKENBOARD_CONFIG_PATCH))'
    ].join('\n')
    const writers = Array.from({ length: 12 }, (_, index) =>
      spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: new URL('.', import.meta.url),
        env: {
          ...process.env,
          TOKENBOARD_CONFIG_DIR: directory,
          TOKENBOARD_CONFIG_PATCH: JSON.stringify({
            servers: {
              [`https://server-${index}.example.com`]: {
                endpoint: `https://server-${index}.example.com/api/v1/ingest`,
                uploadToken: `token-${index}`
              }
            }
          })
        },
        stdio: ['ignore', 'ignore', 'pipe']
      })
    )
    const errors = await Promise.all(writers.map(collectChildExit))
    assert.deepEqual(errors, Array(12).fill(''))

    const config = readConfig()
    assert.equal(Object.keys(config.servers).length, 13)
  } finally {
    if (previousConfigDir === undefined) delete process.env.TOKENBOARD_CONFIG_DIR
    else process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    rmSync(directory, { recursive: true, force: true })
  }
})

test('mergeConfig creates a missing config directory before locking', () => {
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const parent = mkdtempSync(join(tmpdir(), 'tokenboard-config-first-write-'))
  const directory = join(parent, 'nested', 'config')
  process.env.TOKENBOARD_CONFIG_DIR = directory
  try {
    mergeConfig({ endpoint: 'https://tokenboard.example/api/v1/ingest' })
    assert.equal(readConfig().endpoint, 'https://tokenboard.example/api/v1/ingest')
  } finally {
    if (previousConfigDir === undefined) delete process.env.TOKENBOARD_CONFIG_DIR
    else process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    rmSync(parent, { recursive: true, force: true })
  }
})

function collectChildExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => resolve(status === 0 ? '' : stderr || `exit ${status}`))
  })
}

test('readPerSource maps go/ts spellings onto the client types', () => {
  assert.deepEqual(readPerSource({}), {})
  assert.deepEqual(readPerSource({ perSource: { pi: 'go', codex: 'ts' } }), {
    pi: 'binary',
    codex: 'git'
  })
  assert.deepEqual(readPerSource({ perSource: { pi: 'binary', codex: 'git' } }), {
    pi: 'binary',
    codex: 'git'
  })
})

test('readPerSource fails closed on a malformed map', () => {
  assert.throws(() => readPerSource({ perSource: [] }), /perSource/)
  assert.throws(() => readPerSource({ perSource: { pi: 1 } }), /pi/)
  assert.throws(() => readPerSource({ perSource: { pi: 'python' } }), /pi/)
  // A misspelled source never matches a run, so accepting it would leave the
  // operator believing a migration is staged while every run stays on the
  // machine-wide client.
  assert.throws(() => readPerSource({ perSource: { py: 'go' } }), /unknown usage source/)
})

test('resolveClientForSource lets a named source follow its map entry', () => {
  assert.equal(
    resolveClientForSource({ flags: {}, env: {}, config: { perSource: { pi: 'go' } }, source: 'pi' }),
    'binary'
  )
  // An unmapped source keeps the machine-wide client.
  assert.equal(
    resolveClientForSource({ flags: {}, env: {}, config: { perSource: { pi: 'go' } }, source: 'codex' }),
    'git'
  )
})

test('resolveClientForSource refuses an all-source run that would split clients', () => {
  assert.throws(
    () => resolveClientForSource({ flags: {}, env: {}, config: { perSource: { pi: 'go' } }, source: 'all' }),
    /perSource/
  )
  // A map that agrees with the machine client is fine.
  assert.equal(
    resolveClientForSource({
      flags: {},
      env: {},
      config: { clientType: 'binary', perSource: { pi: 'go', codex: 'binary' } },
      source: 'all'
    }),
    'binary'
  )
})
