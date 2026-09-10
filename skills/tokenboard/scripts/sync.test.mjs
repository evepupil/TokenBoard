import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { buildSyncInvocation, refreshBundledCcusageConfig } from './sync.mjs'
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
