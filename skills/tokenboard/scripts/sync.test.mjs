import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildSyncInvocation,
  createUpgradeLogger,
  readHookSyncTimeoutMs,
  refreshBundledCcusageConfig,
  runCollectorProcess,
  runPreCollectUpgrade,
  runSyncInvocation,
  writeRedactedOutput
} from './sync.mjs'
import { buildDefaultSince, readSince } from './sync-options.mjs'
import { normalizeMemoryPath } from './coordinator-test-helpers.mjs'

test('buildDefaultSince returns compact local date for the lookback window', () => {
  assert.equal(
    buildDefaultSince({
      now: new Date('2026-05-09T08:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      lookbackDays: 7
    }),
    '20260502'
  )
})

test('buildDefaultSince handles timezone calendar dates without locale string parsing', () => {
  const RealDate = globalThis.Date
  class ThrowOnStringDate extends RealDate {
    constructor(...args) {
      if (typeof args[0] === 'string') {
        throw new Error('string date parsing is not allowed')
      }
      super(...args)
    }
  }

  globalThis.Date = ThrowOnStringDate
  try {
    assert.equal(
      buildDefaultSince({
        now: new RealDate('2026-01-01T00:30:00.000Z'),
        timezone: 'America/Los_Angeles',
        lookbackDays: 1
      }),
      '20251230'
    )

    assert.equal(
      buildDefaultSince({
        now: new RealDate('2026-01-01T00:30:00.000Z'),
        timezone: 'Pacific/Kiritimati',
        lookbackDays: 1
      }),
      '20251231'
    )
  } finally {
    globalThis.Date = RealDate
  }
})

test('readSince prefers CLI flag then environment then config then default', () => {
  assert.equal(
    readSince({
      flags: { since: '20260509' },
      env: { TOKENBOARD_SINCE: '20260508' },
      config: { since: '20260507', timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260509'
  )

  assert.equal(
    readSince({
      flags: {},
      env: { TOKENBOARD_SINCE: '20260508' },
      config: { since: '20260507', timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260508'
  )

  assert.equal(
    readSince({
      flags: {},
      env: {},
      config: { since: '20260507', timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260507'
  )

  assert.equal(
    readSince({
      flags: {},
      env: {},
      config: { timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260502'
  )
})

test('readSince keeps explicit all sentinel', () => {
  assert.equal(
    readSince({
      flags: { since: 'all' },
      env: {},
      config: { timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    'all'
  )
})

test('sync script forwards resolved since to all collectors', () => {
  const source = readFileSync(new URL('./sync.mjs', import.meta.url), 'utf8')

  assert.match(source, /TOKENBOARD_SINCE:\s*since/)
  assert.match(source, /TOKENBOARD_DEFAULT_SINCE:\s*since/)
  assert.match(source, /bundledCcusageConfig/)
})

test('sync invocation forwards the until flag and gives it precedence over the environment', () => {
  const invocation = buildSyncInvocation({
    flags: { until: '20260810' },
    env: { TOKENBOARD_UNTIL: '20260811' },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    fileExists: () => false
  })

  assert.equal(invocation.env.TOKENBOARD_UNTIL, '20260810')
  assert.deepEqual(invocation.args.slice(-2), ['--until', '20260810'])
})

test('sync invocation rejects a bare until flag instead of forwarding true', () => {
  assert.throws(
    () =>
      buildSyncInvocation({
        flags: { until: true },
        config: {
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          uploadToken: 'test-upload-token',
          timezone: 'Asia/Shanghai',
          collectorDir: '/repo'
        },
        fileExists: () => false
      }),
    /--until requires a date value/
  )
})

test('sync invocation rejects a boolean false until value instead of forwarding false', () => {
  assert.throws(
    () =>
      buildSyncInvocation({
        flags: { until: false },
        config: {
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          uploadToken: 'test-upload-token',
          timezone: 'Asia/Shanghai',
          collectorDir: '/repo'
        },
        fileExists: () => false
      }),
    /--until requires a date value/
  )
})

test('sync invocation preserves an environment until bound without a flag', () => {
  const invocation = buildSyncInvocation({
    env: { TOKENBOARD_UNTIL: '20260811' },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    fileExists: () => false
  })

  assert.equal(invocation.env.TOKENBOARD_UNTIL, '20260811')
})

test('preserves an explicit ccusage configuration when building the collector environment', () => {
  const invocation = buildSyncInvocation({
    env: { TOKENBOARD_CCUSAGE_CONFIG: '/custom/pricing.json' },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    fileExists: () => true
  })

  assert.equal(invocation.env.TOKENBOARD_CCUSAGE_CONFIG, '/custom/pricing.json')
})

test('does not inject a missing bundled ccusage configuration', () => {
  const invocation = buildSyncInvocation({
    env: {},
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    fileExists: () => false
  })

  assert.equal(invocation.env.TOKENBOARD_CCUSAGE_CONFIG, undefined)
})

test('refreshes the bundled ccusage configuration after automatic upgrade', () => {
  const bundledPath = join('/repo', 'packages', 'collector', 'ccusage.json')
  const invocation = buildSyncInvocation({
    env: {},
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    fileExists: () => false
  })

  const refreshed = refreshBundledCcusageConfig(invocation, (path) => path === bundledPath)

  assert.equal(invocation.env.TOKENBOARD_CCUSAGE_CONFIG, undefined)
  assert.equal(refreshed.env.TOKENBOARD_CCUSAGE_CONFIG, bundledPath)
})

test('refresh does not replace an explicit ccusage configuration', () => {
  const invocation = buildSyncInvocation({
    env: { TOKENBOARD_CCUSAGE_CONFIG: '/custom/pricing.json' },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    fileExists: () => false
  })

  assert.equal(
    refreshBundledCcusageConfig(invocation, () => true),
    invocation
  )
  assert.equal(invocation.env.TOKENBOARD_CCUSAGE_CONFIG, '/custom/pricing.json')
})

test('a binary client never inherits the checkout ccusage configuration', () => {
  // `upgrade.mjs --to-binary` keeps the checkout as the rollback, so it is
  // still on disk with whatever `ccusage.json` its last pull left. The Go
  // client ranks an explicit config above its own bundled baseline, so
  // injecting that file would price new usage with a frozen table.
  const invocation = buildSyncInvocation({
    env: {},
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      clientType: 'binary'
    },
    homeDir: '/home/user',
    fileExists: () => true
  })

  assert.equal(invocation.clientType, 'binary')
  assert.equal(invocation.env.TOKENBOARD_CCUSAGE_CONFIG, undefined)
  assert.equal(refreshBundledCcusageConfig(invocation, () => true).env.TOKENBOARD_CCUSAGE_CONFIG, undefined)
})

test('sync invocation forwards the configured Codex symlink roots as JSON', () => {
  const invocation = buildSyncInvocation({
    env: {},
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      codexSymlinkRoots: ['/srv/codex-archive', '/srv/codex-archive']
    },
    fileExists: () => false
  })

  assert.equal(invocation.env.TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON, '["/srv/codex-archive","/srv/codex-archive"]')
})

test('a binary client invocation runs the Go binary with the same env contract', () => {
  const invocation = buildSyncInvocation({
    flags: { mode: 'sync' },
    env: { TOKENBOARD_CCUSAGE_CONFIG: '/custom/pricing.json' },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      clientType: 'binary'
    },
    homeDir: '/home/user',
    nodePath: '/usr/local/bin/node',
    pathEnv: '/usr/bin',
    fileExists: () => true
  })

  // Same subcommand surface, no node and no tsx: the binary is the collector.
  assert.equal(invocation.command, normalizeMemoryPath('/home/user/.tokenboard/bin/tokenboard'))
  assert.deepEqual(invocation.args, ['sync', '--source', 'all'])
  assert.equal(invocation.clientType, 'binary')
  // A binary install has no checkout, so the working directory is the binary's
  // own directory — pointing it at the absent collector dir made spawn fail
  // with ENOENT on the command itself.
  assert.equal(invocation.cwd, normalizeMemoryPath('/home/user/.tokenboard/bin'))
  // The endpoint contract is identical to the git client's.
  assert.equal(invocation.env.TOKENBOARD_ENDPOINT, 'https://tokenboard.example.com/api/v1/ingest')
  assert.equal(invocation.env.TOKENBOARD_UPLOAD_TOKEN, 'test-upload-token')
  assert.equal(invocation.env.TOKENBOARD_TIMEZONE, 'Asia/Shanghai')
  assert.equal(invocation.env.TOKENBOARD_SOURCE, 'all')
  // The bundled ccusage config is the one thing a binary client does not get
  // injected (it materializes the baseline itself), but an explicitly set
  // value in the environment is forwarded untouched — the same passthrough
  // rule the git client follows.
  assert.equal(invocation.env.TOKENBOARD_CCUSAGE_CONFIG, '/custom/pricing.json')
})

test('the release source recorded in the config reaches the binary', () => {
  const invocation = buildSyncInvocation({
    flags: { mode: 'sync' },
    env: {},
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      clientType: 'binary',
      releaseRepo: 'other/TokenBoard',
      releaseBaseUrl: 'https://github.example'
    },
    homeDir: '/home/user',
    pathEnv: '/usr/bin',
    fileExists: () => true
  })

  assert.equal(invocation.env.TOKENBOARD_RELEASE_REPO, 'other/TokenBoard')
  assert.equal(invocation.env.TOKENBOARD_RELEASE_BASE_URL, 'https://github.example')
})

// An install that never recorded a feed has to stay unset: exporting an empty
// value would reach the Go side as an explicit, invalid repository.
test('an install without a recorded release source exports nothing', () => {
  const invocation = buildSyncInvocation({
    flags: { mode: 'sync' },
    env: {},
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      clientType: 'binary'
    },
    homeDir: '/home/user',
    pathEnv: '/usr/bin',
    fileExists: () => true
  })

  assert.equal('TOKENBOARD_RELEASE_REPO' in invocation.env, false)
  assert.equal('TOKENBOARD_RELEASE_BASE_URL' in invocation.env, false)
})

test('a binary client invocation keeps the git argument shape for until and source', () => {
  const invocation = buildSyncInvocation({
    flags: { mode: 'preview', source: 'codex', until: '20260810' },
    env: {},
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      clientType: 'binary'
    },
    homeDir: '/home/user',
    fileExists: () => false
  })

  assert.deepEqual(invocation.args, ['preview', '--source', 'codex', '--until', '20260810'])
  assert.equal(invocation.env.TOKENBOARD_UNTIL, '20260810')
})

test('the default client type stays git for an existing install', () => {
  const invocation = buildSyncInvocation({
    flags: {},
    env: {},
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    fileExists: () => false
  })

  assert.equal(invocation.clientType, 'git')
  assert.match(invocation.command, /node$/)
  assert.deepEqual(invocation.args.slice(0, 3), ['--import', 'tsx', 'src/cli.ts'])
})

test('the binary client flag wins over the config value', () => {
  const invocation = buildSyncInvocation({
    flags: { client: 'binary' },
    env: {},
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      clientType: 'git'
    },
    fileExists: () => false
  })

  assert.equal(invocation.clientType, 'binary')
})

test('an unknown client type is refused rather than silently run as git', () => {
  assert.throws(
    () =>
      buildSyncInvocation({
        flags: {},
        env: {},
        config: {
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          uploadToken: 'test-upload-token',
          timezone: 'Asia/Shanghai',
          collectorDir: '/repo',
          clientType: 'cargo-cult'
        },
        fileExists: () => false
      }),
    /Unsupported client type/
  )
})

test('sync invocation does not replace an explicitly supplied Codex symlink root environment', () => {
  const invocation = buildSyncInvocation({
    env: { TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON: '["/custom/archive"]' },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      codexSymlinkRoots: ['/profile/archive']
    },
    fileExists: () => false
  })

  assert.equal(invocation.env.TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON, '["/custom/archive"]')
})

test('sync invocation preserves an explicitly empty Codex symlink root environment', () => {
  const invocation = buildSyncInvocation({
    env: { TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON: '' },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      codexSymlinkRoots: ['/profile/archive']
    },
    fileExists: () => false
  })

  assert.equal(invocation.env.TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON, '')
})

test('hook sync forwards hook mode and state directory to the collector', () => {
  const invocation = buildSyncInvocation({
    flags: { hook: true, source: 'codex' },
    env: {
      TOKENBOARD_COORDINATOR_LOCK_HELD: '1',
      TOKENBOARD_COORDINATOR_LOCK_TOKEN: 'coordinator-token'
    },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    homeDir: '/home/user',
    nodePath: '/usr/local/bin/node',
    pathEnv: '/usr/bin'
  })

  assert.equal(invocation.env.TOKENBOARD_HOOK_MODE, '1')
  assert.equal(normalizeMemoryPath(invocation.env.TOKENBOARD_STATE_DIR), '/home/user/.tokenboard')
  assert.equal(invocation.env.TOKENBOARD_COORDINATOR_LOCK_HELD, undefined)
  assert.equal(invocation.env.TOKENBOARD_COORDINATOR_LOCK_TOKEN, undefined)
})

test('hook sync preserves an explicit TokenBoard state directory', () => {
  const invocation = buildSyncInvocation({
    flags: { hook: true, source: 'codex' },
    env: { TOKENBOARD_STATE_DIR: '/custom/tokenboard' },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    homeDir: '/home/user',
    nodePath: '/usr/local/bin/node',
    pathEnv: '/usr/bin'
  })

  assert.equal(invocation.env.TOKENBOARD_HOOK_MODE, '1')
  assert.equal(invocation.env.TOKENBOARD_STATE_DIR, '/custom/tokenboard')
})

test('scheduled sync enables strict source error reporting', () => {
  const invocation = buildSyncInvocation({
    flags: { scheduled: true, source: 'all' },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    homeDir: '/home/user',
    nodePath: '/usr/local/bin/node',
    pathEnv: '/usr/bin'
  })

  assert.equal(invocation.env.TOKENBOARD_FAIL_ON_SOURCE_ERROR, '1')
})

test('scheduled sync preserves an explicit source error policy override', () => {
  const invocation = buildSyncInvocation({
    flags: { scheduled: true, source: 'all' },
    env: { TOKENBOARD_FAIL_ON_SOURCE_ERROR: '0' },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo'
    },
    homeDir: '/home/user',
    nodePath: '/usr/local/bin/node',
    pathEnv: '/usr/bin'
  })

  assert.equal(invocation.env.TOKENBOARD_FAIL_ON_SOURCE_ERROR, '0')
})

test('scheduled upgrade diagnostics reach the scheduled log instead of the console', () => {
  const lines = []
  const runtime = { stdoutFd: 1 }
  const logger = createUpgradeLogger(runtime, {
    write: (fd, message) => {
      assert.equal(fd, 1)
      lines.push(message)
    },
    log: () => {
      throw new Error('scheduled upgrade output must not go to the console')
    }
  })

  logger('TokenBoard upgraded from https://example.invalid/repo')

  assert.deepEqual(lines, ['TokenBoard upgraded from https://example.invalid/repo\n'])
})

test('unscheduled upgrade diagnostics still go to the console', () => {
  const lines = []
  const logger = createUpgradeLogger(null, {
    write: () => {
      throw new Error('manual upgrade output must not go to the log sink')
    },
    log: (message) => lines.push(message)
  })

  logger('TokenBoard upgraded from https://example.invalid/repo')

  assert.deepEqual(lines, ['TokenBoard upgraded from https://example.invalid/repo'])
})

test('a failing scheduled log sink never changes the upgrade result', () => {
  const logger = createUpgradeLogger(
    { stdoutFd: 1 },
    {
      write: () => {
        const error = new Error('disk full')
        error.code = 'ENOSPC'
        throw error
      },
      log: () => {
        throw new Error('a failing sink must not fall back to the console')
      }
    }
  )

  assert.doesNotThrow(() => logger('TokenBoard upgraded from https://example.invalid/repo'))
})

test('scheduled upgrade diagnostics redact credentials embedded in URLs', () => {
  const lines = []
  const logger = createUpgradeLogger(
    { stdoutFd: 1 },
    {
      write: (_fd, message) => lines.push(message),
      log: () => {
        throw new Error('scheduled upgrade output must not go to the console')
      }
    }
  )

  logger('TokenBoard upgraded from https://ci-user:ci-token@example.invalid/repo#release')
  logger('TokenBoard upgraded from https://example.invalid/repo?token=ci-token&page=2')

  assert.deepEqual(lines, [
    'TokenBoard upgraded from https://example.invalid/repo#release\n',
    'TokenBoard upgraded from https://example.invalid/repo?token=<redacted>&page=2\n'
  ])
  assert.doesNotMatch(lines[0], /ci-user|ci-token/)
  assert.doesNotMatch(lines[1], /ci-token/)
})

test('a binary client honors the skip-upgrade switch', () => {
  for (const options of [
    { flags: { 'skip-upgrade': true }, env: {} },
    { flags: {}, env: { TOKENBOARD_SKIP_UPGRADE: '1' } },
    { flags: {}, env: { TOKENBOARD_AUTO_UPGRADE: '0' } }
  ]) {
    const selfUpdates = []
    runPreCollectUpgrade({
      ...options,
      invocation: { clientType: 'binary', command: '/home/user/.tokenboard/bin/tokenboard' },
      selfUpdate: (value) => selfUpdates.push(value),
      log: () => {},
      warn: () => {}
    })

    assert.deepEqual(selfUpdates, [], JSON.stringify(options))
  }
})

// The feed an install came from lives in the config, so an automatic update
// keeps using it instead of falling back to the default repository.
test('a binary client self-updates from the release source it was installed from', () => {
  const selfUpdates = []
  const upgrades = []
  const warnings = []
  runPreCollectUpgrade({
    flags: { scheduled: true },
    invocation: {
      clientType: 'binary',
      command: '/home/user/.tokenboard/bin/tokenboard',
      env: {
        PATH: '/usr/bin',
        TOKENBOARD_RELEASE_REPO: 'other/TokenBoard',
        TOKENBOARD_RELEASE_BASE_URL: 'https://github.example'
      }
    },
    selfUpdate: (options) => selfUpdates.push(options),
    upgrade: (options) => upgrades.push(options),
    log: () => {},
    warn: (message) => warnings.push(message)
  })

  assert.equal(selfUpdates.length, 1)
  assert.equal(selfUpdates[0].env.TOKENBOARD_RELEASE_REPO, 'other/TokenBoard')
  assert.equal(selfUpdates[0].env.TOKENBOARD_RELEASE_BASE_URL, 'https://github.example')
  assert.deepEqual(upgrades, [])
  assert.deepEqual(warnings, [])
})

test('a binary client upgrades through its own self-update, not the checkout', () => {
  const selfUpdates = []
  const upgrades = []
  const warnings = []
  runPreCollectUpgrade({
    flags: { scheduled: true },
    invocation: { clientType: 'binary', command: '/home/user/.tokenboard/bin/tokenboard' },
    selfUpdate: (options) => selfUpdates.push(options),
    upgrade: (options) => upgrades.push(options),
    log: () => {},
    warn: (message) => warnings.push(message)
  })

  // --scheduled is what keeps an offline machine from failing the run.
  assert.equal(selfUpdates.length, 1)
  assert.equal(selfUpdates[0].binaryPath, '/home/user/.tokenboard/bin/tokenboard')
  assert.equal(selfUpdates[0].scheduled, true)
  assert.deepEqual(upgrades, [])
  assert.deepEqual(warnings, [])
})

test('a binary hook sync never upgrades at all', () => {
  const selfUpdates = []
  runPreCollectUpgrade({
    flags: { hook: true },
    invocation: { clientType: 'binary', command: '/home/user/.tokenboard/bin/tokenboard' },
    selfUpdate: (options) => selfUpdates.push(options),
    log: () => {},
    warn: () => {}
  })

  assert.deepEqual(selfUpdates, [])
})

// A missing target is the recovery case, not a skip case: `runSelfUpdate` is what calls
// `recoverOrphanedBinary`, which restores a binary whose swap was interrupted between its two
// renames. Returning early here made that recovery unreachable from the automatic path, so an
// interrupted self-update left every later sync reporting "client is not installed".
test('a binary client whose binary is missing still reaches self-update so the swap can be recovered', () => {
  const selfUpdates = []
  runPreCollectUpgrade({
    flags: {},
    invocation: { clientType: 'binary', command: '/home/user/.tokenboard/bin/tokenboard' },
    selfUpdate: (options) => selfUpdates.push(options),
    log: () => {},
    warn: () => {}
  })

  assert.equal(selfUpdates.length, 1)
  assert.equal(selfUpdates[0].binaryPath, '/home/user/.tokenboard/bin/tokenboard')
})

test('a failed binary self-update warns instead of failing the sync', () => {
  const warnings = []
  assert.doesNotThrow(() =>
    runPreCollectUpgrade({
      flags: {},
      invocation: { clientType: 'binary', command: '/home/user/.tokenboard/bin/tokenboard' },
      selfUpdate: () => {
        throw new Error('dial https://api-user:api-secret@example.invalid: timeout')
      },
      log: () => {},
      warn: (message) => warnings.push(message)
    })
  )

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /self-update skipped/)
  // The URL may carry userinfo; the warning sink is a long-lived log.
  assert.doesNotMatch(warnings[0], /api-secret/)
})

test('a git client still upgrades the checkout before collection', () => {
  const upgrades = []
  runPreCollectUpgrade({
    flags: {},
    invocation: { clientType: 'git', command: 'node' },
    env: {},
    upgrade: (options) => upgrades.push(options),
    selfUpdate: () => {
      throw new Error('a git client must not self-update')
    },
    log: () => {},
    warn: () => {}
  })

  assert.equal(upgrades.length, 1)
  assert.equal(upgrades[0].automatic, true)
})

test('a git client honors the skip-upgrade switch', () => {
  const upgrades = []
  runPreCollectUpgrade({
    flags: { 'skip-upgrade': true },
    invocation: { clientType: 'git', command: 'node' },
    env: {},
    upgrade: (options) => upgrades.push(options),
    log: () => {},
    warn: () => {}
  })

  assert.deepEqual(upgrades, [])
})

test('scheduled sync records running and failed state without affecting manual sync', async () => {
  const states = []
  const result = await runSyncInvocation({
    flags: { scheduled: true },
    invocation: { source: 'all' },
    stateDir: '/state',
    now: () => Date.parse('2026-09-20T01:00:00.000Z'),
    writeState: (state) => states.push(state),
    runWithLock: () => 1,
    runRetry: () => ({ exitCode: 1 })
  })

  assert.equal(result, 1)
  assert.deepEqual(
    states.map((state) => state.status),
    ['running', 'failed']
  )
  assert.equal(states.at(-1).exitCode, 1)
  assert.equal(states.at(-1).source, 'all')
})

// Windows reports the untruncated 32-bit process status, so a crashed child arrives as
// something like 3221225477. The state writer only accepts 0-255 and throws otherwise, and
// that throw is swallowed — the state file stayed on `running` forever, which reads exactly
// like a sync still in progress. An out-of-range code must land as a recorded failure.
test('a Windows crash exit code is recorded as a failure instead of being dropped', async () => {
  const states = []
  const result = await runSyncInvocation({
    flags: { scheduled: true },
    invocation: { source: 'all' },
    stateDir: '/state',
    now: () => Date.parse('2026-09-20T01:00:00.000Z'),
    writeState: (state) => states.push(state),
    // 75 is the transient code, so the run takes the retry path — which is where a real
    // crash code arrives from (`runRetry`), not from the first attempt.
    runWithLock: () => 75,
    runRetry: () => ({ exitCode: 3221225477 })
  })

  // The return value stays the child's raw code — this test is about what reaches the
  // state file, which is the value that got the run stuck on `running`.
  assert.equal(states.at(-1).status, 'failed')
  assert.equal(states.at(-1).exitCode, 1)
  assert.equal(states.at(-1).completedAt !== undefined, true)
})

test('a deferred run never records the internal transient exit code', async () => {
  const states = []
  await runSyncInvocation({
    flags: { scheduled: true },
    invocation: { source: 'all' },
    stateDir: '/state',
    now: () => Date.parse('2026-09-20T01:00:00.000Z'),
    writeState: (state) => states.push(state),
    onStateError: () => {},
    runWithLock: () => 75,
    runRetry: () => ({ exitCode: 75 })
  })

  const deferred = states.find((state) => state.status === 'deferred')
  assert.ok(deferred, 'the run should be recorded as deferred')
  // 75 is an internal contract with the retry loop, not something the state file — which
  // `status.mjs` prints verbatim — should carry. The non-scheduled branch normalizes the
  // same code to 1 for the same reason.
  assert.equal(deferred.exitCode, undefined)
})

test('a skipped retry is deferred rather than failed', async () => {
  const states = []
  const result = await runSyncInvocation({
    flags: { scheduled: true },
    invocation: { source: 'all' },
    stateDir: '/state',
    now: () => Date.parse('2026-09-20T01:00:00.000Z'),
    writeState: (state) => states.push(state),
    onStateError: () => {},
    runWithLock: () => 75,
    // The shape every `skipped` return in scheduled-retry.mjs uses: no exitCode at all.
    runRetry: () => ({ skipped: true, skippedReason: 'active-retry' })
  })

  // Handing the work to the retry that already holds the lock is a deferral, not a
  // failure. The old ordering read the absent exit code as the fallback 1 and recorded
  // `failed`, contradicting both the message printed and the retry loop's own state row.
  assert.equal(states.at(-1).status, 'deferred')
  assert.equal(states.at(-1).exitCode, undefined)
  assert.equal(result, 1)
})

test('scheduled retry uses the normalized source and fails closed on a missing retry exit code', async () => {
  const states = []
  let retryOptions
  const result = await runSyncInvocation({
    flags: { scheduled: true, source: 'codex' },
    invocation: {},
    stateDir: '/state',
    now: () => Date.parse('2026-09-20T01:00:00.000Z'),
    writeState: (state) => states.push(state),
    runWithLock: () => {
      const error = new Error('lock timeout')
      error.code = 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
      throw error
    },
    runRetry: (options) => {
      retryOptions = options
      return {}
    }
  })

  assert.equal(result, 1)
  assert.equal(retryOptions.source, 'codex')
  assert.equal(states.at(-1).status, 'failed')
  assert.equal(states.at(-1).exitCode, 1)
})

test('scheduled state reporting cannot change the sync result or mask its primary error', async () => {
  const stateErrors = []
  const stateFailure = new Error('state directory unavailable')
  const success = await runSyncInvocation({
    flags: { scheduled: true },
    invocation: { source: 'all' },
    stateDir: '/state',
    writeState: () => {
      throw stateFailure
    },
    onStateError: (message) => stateErrors.push(message),
    runWithLock: () => 0
  })

  assert.equal(success, 0)
  assert.equal(stateErrors.length, 2)
  assert.match(stateErrors[0], /state directory unavailable/)

  const primaryError = new Error('collector failed')
  await assert.rejects(
    runSyncInvocation({
      flags: { scheduled: true },
      invocation: { source: 'all' },
      stateDir: '/state',
      writeState: () => {
        throw stateFailure
      },
      onStateError: (message) => stateErrors.push(message),
      runWithLock: () => {
        throw primaryError
      }
    }),
    (error) => error === primaryError
  )
})

// The entry guard runs `runCli()` at module top level, so every `const` the scheduled path
// reads must be initialized before the guard — a declaration further down the file is still in
// its temporal dead zone. This slipped through once: the collector-output buffer was declared
// below the guard, `--mode preview` took the no-log early return and never touched it, and only
// `--scheduled` threw `Cannot access '…' before initialization`. Every other sync test imports
// the module (fully evaluated by then) or injects its own `run`, so none of them executes the
// real top-level entry — the regression has to be caught by running the CLI as a subprocess.
test('scheduled sync runs the real top-level entry without a temporal dead zone', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-sync-entry-'))
  try {
    const collectorDir = join(root, 'collector')
    // The logged branch is only reached once the collector checkout exists; an absent one
    // returns early and would pass even with the broken declaration order.
    mkdirSync(join(collectorDir, 'packages', 'collector'), { recursive: true })
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        endpoint: 'http://127.0.0.1:1',
        uploadToken: 'entry-guard-token',
        timezone: 'Asia/Shanghai',
        source: 'claude-code',
        packageManager: 'pnpm',
        collectorDir
      })
    )

    const result = spawnSync(
      process.execPath,
      [new URL('./sync.mjs', import.meta.url).pathname, '--scheduled', '--source', 'claude-code', '--skip-upgrade'],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          TOKENBOARD_CONFIG_DIR: root,
          TOKENBOARD_COLLECTOR_DIR: collectorDir,
          TOKENBOARD_LOG_DIR: join(root, 'logs'),
          TOKENBOARD_SKIP_UPGRADE: '1'
        }
      }
    )

    // The scheduled path writes through the log runtime, not to the inherited stdio, so the
    // evidence is in the log files. A TDZ failure would surface on the parent's stderr too
    // (runCli catches and prints it), which is why both are checked.
    const errLog = readFileSync(join(root, 'logs', 'daily-sync.err.log'), 'utf8')
    const combined = `${result.stdout}${result.stderr}${errLog}`
    assert.doesNotMatch(combined, /before initialization/)
    assert.doesNotMatch(combined, /ReferenceError/)
    // The collector cannot actually run here (the checkout is a stub), so a non-zero exit is
    // expected; what matters is that the entry got far enough to reach it at all.
    assert.match(errLog, /collector/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A broken log directory (permissions, disk full) must not cancel the sync: the collector
// still runs and its output still matters. The subprocess drives the real top-level entry so
// the fallback in runCli itself is exercised, not a re-implementation.
test('a scheduled sync continues without logs when the log directory cannot be created', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-sync-logfb-'))
  try {
    const collectorDir = join(root, 'collector')
    mkdirSync(join(collectorDir, 'packages', 'collector'), { recursive: true })
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        endpoint: 'http://127.0.0.1:1',
        uploadToken: 'log-fallback-token',
        timezone: 'Asia/Shanghai',
        source: 'claude-code',
        packageManager: 'pnpm',
        collectorDir
      })
    )
    // A file where the log directory belongs: mkdirSync fails with EEXIST/ENOTDIR.
    writeFileSync(join(root, 'logs'), 'not a directory')

    const result = spawnSync(
      process.execPath,
      [new URL('./sync.mjs', import.meta.url).pathname, '--scheduled', '--source', 'claude-code', '--skip-upgrade'],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          TOKENBOARD_CONFIG_DIR: root,
          TOKENBOARD_COLLECTOR_DIR: collectorDir,
          TOKENBOARD_LOG_DIR: join(root, 'logs', 'nested'),
          TOKENBOARD_SKIP_UPGRADE: '1'
        }
      }
    )

    assert.ok(result.stderr.includes('continuing without them'), 'expected the log fallback warning')
    // The sync itself proceeded far enough to attempt the collector (which fails, since the
    // checkout is a stub), proving the log failure did not cancel the run.
    assert.ok(/collector/i.test(result.stderr))
    assert.notEqual(result.status, 0) // the stub collector fails, but not because of logs
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The scheduled log is the one artifact of a run that outlives its terminal, so the child's
// output has to pass through the same redaction as the parent's log lines: a provider or
// `ccusage` error echoing `tb_upload_…` or `https://user:token@host/…` would land there intact.
test('scheduled collector output reaches the log with credentials redacted', async () => {
  const written = []
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  child.stdout = new (await import('node:stream')).Readable({ read() {} })
  child.stderr = new (await import('node:stream')).Readable({ read() {} })
  const result = await runCollectorProcess(
    { command: 'collector', args: [], cwd: '/repo', env: {}, shell: false },
    { stdoutFd: 11, stderrFd: 12 },
    {
      spawn: () => {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('uploaded with tb_upload_abcdef123456\n'))
          child.stderr.emit('data', Buffer.from('POST https://ci-user:ci-token@example.invalid/upload failed\n'))
          child.stdout.push(null)
          child.stderr.push(null)
          child.emit('exit', 0, null)
        })
        return child
      },
      write: (fd, text) => written.push([fd, text])
    }
  )

  assert.equal(result.status, 0)
  assert.deepEqual(written, [
    [11, 'uploaded with tb_upload_<redacted>\n'],
    [12, 'POST https://example.invalid/upload failed\n']
  ])
  assert.ok(written.every(([_fd, text]) => !/ci-user|ci-token|tb_upload_abcdef/.test(text)))
})

// Without a scheduled log the child inherits the terminal, so nothing is captured and no log
// line is synthesized — the interactive run keeps its live output. The stub mimics the real
// node:child_process spawn contract (an EventEmitter child), not the old spawnSync result
// shape: an earlier stub returned `{ status: 3 }` directly and hid a regression where the
// child process object was returned un-awaited and the exit code was lost.
test('an unscheduled collector run inherits the terminal instead of capturing', async () => {
  const calls = []
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  const result = await runCollectorProcess(
    { command: 'collector', args: ['--sync'], cwd: '/repo', env: { A: '1' }, shell: false },
    null,
    {
      spawn: (command, args, options) => {
        calls.push({ command, args, options })
        queueMicrotask(() => child.emit('exit', 3, null))
        return child
      }
    }
  )

  assert.equal(result.status, 3)
  assert.equal(result.error, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.stdio, 'inherit')
})

// The hook path is exactly the unscheduled path: notify spawns sync.mjs with `--hook` and no
// scheduled-log environment, so `logs` is null and the child inherits the terminal. The
// wall-clock bound the hook mode advertises has to apply there too — a wedged ccusage scan on
// a hook run would otherwise hold the coordinator's sync lock forever, and no timer exists to
// kill it. This is the branch production hook traffic actually takes.
test('a hook run without a scheduled log is still bounded by hookTimeoutMs', async () => {
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  let killed = null
  child.kill = (signal) => {
    killed = signal
    child.emit('exit', null, signal)
    return true
  }
  const result = await runCollectorProcess(
    { command: 'collector', args: ['--hook'], cwd: '/repo', env: {}, shell: false },
    null,
    { spawn: () => child, hookTimeoutMs: 5 }
  )

  assert.equal(killed, 'SIGKILL')
  assert.equal(result.status, 1)
  assert.equal(result.error.code, 'ETIMEDOUT')
})

// A run that finishes inside the bound must clear the timer, or the parent's event loop stays
// alive for the full timeout after every successful hook.
test('a hook run that finishes in time is not killed and reports its exit code', async () => {
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  const killed = []
  child.kill = (signal) => {
    killed.push(signal)
    return true
  }
  const result = await runCollectorProcess(
    { command: 'collector', args: ['--hook'], cwd: '/repo', env: {}, shell: false },
    null,
    {
      spawn: () => {
        queueMicrotask(() => child.emit('exit', 0, null))
        return child
      },
      hookTimeoutMs: 50
    }
  )

  assert.deepEqual(killed, [])
  assert.equal(result.status, 0)
  assert.equal(result.error, null)
})

test('an unscheduled run reports a spawn failure and a zero exit as success', async () => {
  const { EventEmitter } = await import('node:events')
  const failed = new EventEmitter()
  const spawnFailure = await runCollectorProcess(
    { command: 'collector', args: [], cwd: '/repo', env: {}, shell: false },
    null,
    {
      spawn: () => {
        queueMicrotask(() => failed.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
        return failed
      }
    }
  )
  assert.equal(spawnFailure.status, 1)
  assert.match(spawnFailure.error.message, /ENOENT/)

  const child = new EventEmitter()
  const success = await runCollectorProcess(
    { command: 'collector', args: [], cwd: '/repo', env: {}, shell: false },
    null,
    {
      spawn: () => {
        queueMicrotask(() => child.emit('exit', 0, null))
        return child
      }
    }
  )
  assert.equal(success.status, 0)
})

test('writeRedactedOutput strips credentials before writing to the log', () => {
  const written = []
  const write = (fd, text) => written.push([fd, text])

  writeRedactedOutput(
    1,
    'POST https://ci-user:ci-token@example.invalid/upload failed with tb_upload_abcdef123456',
    write
  )
  writeRedactedOutput(2, 'second line', write)

  assert.deepEqual(written, [
    [1, 'POST https://example.invalid/upload failed with tb_upload_<redacted>\n'],
    [2, 'second line\n']
  ])
  assert.ok(written.every(([_fd, text]) => !/ci-user|ci-token|tb_upload_abcdef/.test(text)))
})

test('writeRedactedOutput treats missing output as nothing to write', () => {
  const written = []
  const write = (_fd, text) => written.push(text)

  writeRedactedOutput(1, '', write)
  writeRedactedOutput(1, null, write)
  writeRedactedOutput(1, undefined, write)

  assert.deepEqual(written, [])
})

// A diagnostic sink must never change the sync result, so a throwing write is swallowed.
test('writeRedactedOutput swallows a failing log sink', () => {
  assert.doesNotThrow(() =>
    writeRedactedOutput(1, 'line', () => {
      throw new Error('EBADF')
    })
  )
})

function capturingInvocation() {
  return { command: 'node', args: ['collector.ts'], cwd: '/tmp', env: {}, shell: false }
}

function capturingLogs() {
  return { stdoutFd: 9, stderrFd: 10 }
}

function spawnCapturingOptions(calls) {
  return (command, args, options) => {
    calls.push(options)
    const child = new EventEmitter()
    child.stdout = new Readable({ read() {} })
    child.stderr = new Readable({ read() {} })
    queueMicrotask(() => {
      child.stdout.push(null)
      child.stderr.push(null)
      child.emit('exit', 0, null)
    })
    return child
  }
}

function silenceStderr(run) {
  const stderr = []
  const original = console.error
  console.error = (line) => stderr.push(line)
  try {
    const exitCode = run()
    return { exitCode, stderr }
  } finally {
    console.error = original
  }
}

test('hook-mode logged spawns receive the hook timeout bound', async () => {
  const calls = []
  await runCollectorProcess(capturingInvocation(), capturingLogs(), {
    spawn: spawnCapturingOptions(calls),
    hookTimeoutMs: 30 * 60 * 1000
  })
  assert.equal('timeout' in calls[0], false) // the bound is enforced by the parent timer, not spawnSync
  assert.equal(calls[0].stdio[0], 'ignore')
})

test('runCollectorProcess without a hookTimeoutMs never receives a timeout option', async () => {
  const calls = []
  await runCollectorProcess(capturingInvocation(), capturingLogs(), { spawn: spawnCapturingOptions(calls) })
  assert.equal('timeout' in calls[0], false)
})

// Killing the direct child does not close the stdio pipes when an orphaned grandchild
// (ccusage, tsx) inherited them: the 'end' events never fire and the awaited streams would
// hang forever after the process is already gone. The parent must force the streams closed.
test('an exited child whose output streams never end has them destroyed by the parent', async () => {
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  child.stdout = new (await import('node:stream')).Readable({ read() {} })
  child.stderr = new (await import('node:stream')).Readable({ read() {} })
  const destroyed = []
  for (const stream of [child.stdout, child.stderr]) {
    const original = stream.destroy.bind(stream)
    stream.destroy = (error) => {
      destroyed.push(stream)
      original(error)
    }
  }
  const result = await runCollectorProcess(capturingInvocation(), capturingLogs(), {
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('partial line\n'))
        child.emit('exit', 0, null)
        // No push(null): the grandchild still holds the pipe open.
      })
      return child
    },
    streamDrainTimeoutMs: 50,
    write: () => {}
  })

  assert.equal(result.status, 0)
  assert.equal(destroyed.length, 2)
})

// readline destroys the underlying stream on natural 'end', so a destroy counter cannot
// distinguish the guard from normal shutdown; the observable contract for a healthy run is
// that it settles as soon as the pipes end, never waiting out the drain grace.
test('a normally draining run settles without waiting out the drain grace', async () => {
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  child.stdout = new (await import('node:stream')).Readable({ read() {} })
  child.stderr = new (await import('node:stream')).Readable({ read() {} })
  const startedAt = Date.now()
  const result = await runCollectorProcess(capturingInvocation(), capturingLogs(), {
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.push(null)
        child.stderr.push(null)
        child.emit('exit', 0, null)
      })
      return child
    },
    streamDrainTimeoutMs: 5_000,
    write: () => {}
  })

  assert.equal(result.status, 0)
  assert.ok(Date.now() - startedAt < 5_000, 'drain should not wait out the full grace period')
})

test('readHookSyncTimeoutMs parses the env override and rejects invalid values', () => {
  assert.equal(readHookSyncTimeoutMs({ TOKENBOARD_HOOK_SYNC_TIMEOUT_MS: '60000' }), 60_000)
  assert.equal(readHookSyncTimeoutMs({}), 30 * 60 * 1000)
  assert.throws(
    () => readHookSyncTimeoutMs({ TOKENBOARD_HOOK_SYNC_TIMEOUT_MS: 'soon' }),
    /TOKENBOARD_HOOK_SYNC_TIMEOUT_MS must be/
  )
  assert.throws(
    () => readHookSyncTimeoutMs({ TOKENBOARD_HOOK_SYNC_TIMEOUT_MS: '0' }),
    /TOKENBOARD_HOOK_SYNC_TIMEOUT_MS must be/
  )
  // setTimeout clamps a delay past 2^31-1 to 1ms, so an "effectively infinite" bound would
  // kill every hook run instantly — the opposite of what the operator asked for. Refuse it
  // at parse time rather than letting the timer silently invert the intent.
  assert.throws(() => readHookSyncTimeoutMs({ TOKENBOARD_HOOK_SYNC_TIMEOUT_MS: '2147483648' }), /at most 2147483647/)
  assert.equal(readHookSyncTimeoutMs({ TOKENBOARD_HOOK_SYNC_TIMEOUT_MS: '2147483647' }), 2_147_483_647)
})

test('a timed-out hook run resolves with an ETIMEDOUT error for runSync to report', async () => {
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  child.stdout = new (await import('node:stream')).Readable({ read() {} })
  child.stderr = new (await import('node:stream')).Readable({ read() {} })
  child.kill = (signal) => {
    child.emit('exit', null, signal)
    return true
  }
  const result = await runCollectorProcess(capturingInvocation(), capturingLogs(), {
    spawn: () => child,
    hookTimeoutMs: 5
  })
  assert.equal(result.status, 1)
  assert.equal(result.error.code, 'ETIMEDOUT')
  // runSync prints the operator-facing line when it sees this shape.
  assert.match(
    `TokenBoard hook sync timed out after 5 ms; the collector process was killed`,
    /hook sync timed out after/
  )
})

// The whole-buffer capture bound the run log to 64 MiB and lost everything if the process was
// killed mid-run. Streaming captures per line: the log survives a kill, memory stays flat, and
// redaction still applies per line.
test('streamed output lands in the log incrementally and survives a kill', async () => {
  const written = []
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  child.stdout = new (await import('node:stream')).Readable({ read() {} })
  child.stderr = new (await import('node:stream')).Readable({ read() {} })
  const spawn = (command, args, options) => {
    assert.equal(options.stdio[0], 'ignore')
    assert.equal(options.maxBuffer, undefined)
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('line-1 with tb_upload_abcdef123456\n'))
      child.stderr.emit('data', Buffer.from('POST https://ci-user:ci-token@example.invalid/x failed\n'))
      child.stdout.emit('data', Buffer.from('line-2\n'))
      child.stdout.push(null)
      child.stderr.push(null)
      child.emit('exit', 0, null)
    })
    return child
  }
  const result = await runCollectorProcess(
    { command: 'collector', args: [], cwd: '/repo', env: {}, shell: false },
    { stdoutFd: 11, stderrFd: 12 },
    { spawn, write: (fd, text) => written.push([fd, text]) }
  )
  assert.equal(result.status, 0)
  assert.deepEqual(written, [
    [11, 'line-1 with tb_upload_<redacted>\n'],
    [12, 'POST https://example.invalid/x failed\n'],
    [11, 'line-2\n']
  ])
})

test('streamed output with no trailing newline still ends with one in the log', async () => {
  const written = []
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  child.stdout = new (await import('node:stream')).Readable({ read() {} })
  child.stderr = new (await import('node:stream')).Readable({ read() {} })
  const spawn = () => {
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('no-newline-end'))
      child.stdout.push(null)
      child.stderr.push(null)
      child.emit('exit', 0, null)
    })
    return child
  }
  await runCollectorProcess(
    { command: 'collector', args: [], cwd: '/repo', env: {}, shell: false },
    { stdoutFd: 11, stderrFd: 12 },
    { spawn, write: (fd, text) => written.push([fd, text]) }
  )
  assert.deepEqual(written, [[11, 'no-newline-end\n']])
})

test('streamed spawn errors still produce exit 1', async () => {
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  child.stdout = new (await import('node:stream')).Readable({ read() {} })
  child.stderr = new (await import('node:stream')).Readable({ read() {} })
  const spawn = () => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
    return child
  }
  const result = await runCollectorProcess(
    { command: 'collector', args: [], cwd: '/repo', env: {}, shell: false },
    { stdoutFd: 11, stderrFd: 12 },
    { spawn, write: () => {} }
  )
  assert.equal(result.status, 1)
  assert.match(result.error.message, /ENOENT/)
})

test('hook timeout kills a streamed run and reports itself', async () => {
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  child.stdout = new (await import('node:stream')).Readable({ read() {} })
  child.stderr = new (await import('node:stream')).Readable({ read() {} })
  child.kill = (signal) => {
    child.emit('exit', null, signal)
    return true
  }
  const spawned = []
  const spawn = (command, args, options) => {
    spawned.push(options)
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('started\n')))
    return child
  }
  const result = await runCollectorProcess(
    { command: 'collector', args: [], cwd: '/repo', env: {}, shell: false },
    { stdoutFd: 11, stderrFd: 12 },
    { spawn, write: () => {}, hookTimeoutMs: 10 }
  )
  // The bound is enforced by the parent-side timer (which kills the child), not by spawn
  // options — the same contract the option-capturing test above pins down.
  assert.equal('timeoutMs' in spawned[0], false)
  assert.equal('timeout' in spawned[0], false)
  assert.equal(result.status, 1)
  assert.equal(result.error.code, 'ETIMEDOUT')
})

// An operator who exports the release feed for one run is overriding the
// recorded value; the config must not silently win over it. The other config
// exports in this block follow the same onlyWhenUnset rule.
test('an explicit release source in the environment wins over the config', () => {
  const invocation = buildSyncInvocation({
    flags: { mode: 'sync' },
    env: {
      TOKENBOARD_RELEASE_REPO: 'run/TokenBoard',
      TOKENBOARD_RELEASE_BASE_URL: 'https://run.example'
    },
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      clientType: 'binary',
      releaseRepo: 'installed/TokenBoard',
      releaseBaseUrl: 'https://installed.example'
    },
    homeDir: '/home/user',
    pathEnv: '/usr/bin',
    fileExists: () => true
  })

  assert.equal(invocation.env.TOKENBOARD_RELEASE_REPO, 'run/TokenBoard')
  assert.equal(invocation.env.TOKENBOARD_RELEASE_BASE_URL, 'https://run.example')
})

// perSource overrides the client for one source. An explicitly named source
// runs on the client its mapping names, so a machine can move source by source
// instead of flipping the whole install.
test('perSource runs a named source on the client it maps to', () => {
  for (const [mapped, expectedCommand] of [
    ['go', normalizeMemoryPath('/home/user/.tokenboard/bin/tokenboard')],
    ['binary', normalizeMemoryPath('/home/user/.tokenboard/bin/tokenboard')],
    ['ts', '/usr/local/bin/node']
  ]) {
    const invocation = buildSyncInvocation({
      flags: { source: 'pi' },
      env: {},
      config: {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'test-upload-token',
        timezone: 'Asia/Shanghai',
        collectorDir: '/repo',
        perSource: { pi: mapped }
      },
      homeDir: '/home/user',
      nodePath: '/usr/local/bin/node',
      pathEnv: '/usr/bin',
      fileExists: () => true
    })

    assert.equal(invocation.command, expectedCommand, `perSource pi=${mapped}`)
    assert.deepEqual(invocation.args.slice(-2), ['--source', 'pi'])
  }
})

// An all-source run cannot split itself across two clients: the TS collector
// has no "collect only these sources" flag, and the Go client would collect
// the rest. Refuse instead of silently running one client for everything.
test('perSource refuses an all-source run that maps to more than one client', () => {
  assert.throws(
    () =>
      buildSyncInvocation({
        flags: {},
        env: {},
        config: {
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          uploadToken: 'test-upload-token',
          timezone: 'Asia/Shanghai',
          collectorDir: '/repo',
          perSource: { pi: 'go', codex: 'ts' }
        },
        homeDir: '/home/user',
        nodePath: '/usr/local/bin/node',
        pathEnv: '/usr/bin',
        fileExists: () => true
      }),
    /perSource/
  )
})

// An all-source run whose mapping agrees with the machine clientType runs
// that client: the map names only sources that are already on it.
test('perSource runs an all-source request when the mapping agrees', () => {
  const invocation = buildSyncInvocation({
    flags: {},
    env: {},
    config: {
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'test-upload-token',
      timezone: 'Asia/Shanghai',
      collectorDir: '/repo',
      clientType: 'binary',
      perSource: { pi: 'go', codex: 'binary' }
    },
    homeDir: '/home/user',
    nodePath: '/usr/local/bin/node',
    pathEnv: '/usr/bin',
    fileExists: () => true
  })

  assert.equal(invocation.command, normalizeMemoryPath('/home/user/.tokenboard/bin/tokenboard'))
  assert.deepEqual(invocation.args, ['sync', '--source', 'all'])
})

// An unknown client name in the mapping is a configuration error, not a
// silent fallback to the global clientType.
test('perSource rejects an unknown client name', () => {
  assert.throws(
    () =>
      buildSyncInvocation({
        flags: { source: 'pi' },
        env: {},
        config: {
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          uploadToken: 'test-upload-token',
          timezone: 'Asia/Shanghai',
          collectorDir: '/repo',
          perSource: { pi: 'python' }
        },
        homeDir: '/home/user',
        pathEnv: '/usr/bin',
        fileExists: () => true
      }),
    /pi/
  )
})
