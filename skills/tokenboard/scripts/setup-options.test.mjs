import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildInitialSyncArgs,
  buildInstallCollectorArgs,
  buildWarmHookCursorArgs,
  createPairingCodeFromDeviceLink,
  readSetupBaseUrl,
  resolveSetupInstallOptions,
  shouldUseDeviceLink,
  shouldWarmHookCursorsBeforeInstall
} from './setup-options.mjs'

test('setup install options inherit saved server profile values', () => {
  assert.deepEqual(
    resolveSetupInstallOptions({
      flags: {},
      env: {},
      profile: {
        repoUrl: 'https://github.com/example/private.git',
        repoRef: 'release-branch',
        packageManager: 'bun',
        scheduleTimes: ['07:15', '19:45'],
        codexSymlinkRoots: ['/Volumes/Work/CodexArchive/archived_sessions']
      },
      defaultScheduleTimes: ['00:00']
    }),
    {
      repoUrl: 'https://github.com/example/private.git',
      repoRef: 'release-branch',
      packageManager: 'bun',
      scheduleTimesInput: '07:15,19:45',
      codexSymlinkRoots: ['/Volumes/Work/CodexArchive/archived_sessions']
    }
  )
})

test('explicit setup flags override saved server profile values', () => {
  assert.deepEqual(
    resolveSetupInstallOptions({
      flags: {
        'repo-url': 'https://github.com/example/override.git',
        'repo-ref': 'override-branch',
        'package-manager': 'npm',
        'schedule-times': '08:30,20:30',
        'codex-symlink-roots-json': '["/srv/codex-archive"]'
      },
      env: {},
      profile: {
        repoUrl: 'https://github.com/example/private.git',
        repoRef: 'release-branch',
        packageManager: 'bun',
        scheduleTimes: ['07:15', '19:45']
      },
      defaultScheduleTimes: ['00:00']
    }),
    {
      repoUrl: 'https://github.com/example/override.git',
      repoRef: 'override-branch',
      packageManager: 'npm',
      scheduleTimesInput: '08:30,20:30',
      codexSymlinkRoots: ['/srv/codex-archive']
    }
  )
})

test('setup rejects malformed or empty Codex symlink root configuration', () => {
  assert.throws(
    () =>
      resolveSetupInstallOptions({
        flags: { 'codex-symlink-roots-json': '{"path":"/srv/archive"}' },
        env: {},
        profile: {}
      }),
    /Invalid --codex-symlink-roots-json: expected a non-empty JSON array of paths/
  )
  assert.throws(
    () =>
      resolveSetupInstallOptions({
        flags: { 'codex-symlink-roots-json': '[]' },
        env: {},
        profile: {}
      }),
    /Invalid --codex-symlink-roots-json: expected a non-empty JSON array of paths/
  )
  assert.throws(
    () =>
      resolveSetupInstallOptions({
        flags: { 'codex-symlink-roots-json': '' },
        env: {},
        profile: { codexSymlinkRoots: ['/old/archive'] }
      }),
    /Invalid --codex-symlink-roots-json: expected a JSON array of paths/
  )

  assert.throws(
    () =>
      resolveSetupInstallOptions({
        flags: {},
        env: { TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON: '' },
        profile: {}
      }),
    /Invalid TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON: expected a JSON array of paths/
  )

  assert.throws(
    () =>
      resolveSetupInstallOptions({
        flags: {},
        env: {},
        profile: { codexSymlinkRoots: '' }
      }),
    /Invalid profile codexSymlinkRoots: expected a JSON array of paths/
  )
})

test('initial setup sync uses a full history scan by default', () => {
  assert.deepEqual(buildInitialSyncArgs({ flags: {} }), ['--mode', 'sync', '--source', 'all', '--since', 'all'])
})

test('initial setup sync forwards an explicit since value', () => {
  assert.deepEqual(buildInitialSyncArgs({ flags: { since: '20260501' } }), [
    '--mode',
    'sync',
    '--source',
    'all',
    '--since',
    '20260501'
  ])
})

test('setup warms hook cursors before installing hooks when initial sync is skipped', () => {
  assert.equal(shouldWarmHookCursorsBeforeInstall({ 'skip-initial-sync': true }), true)
})

test('setup warms hook cursors before installing hooks when initial sync is bounded', () => {
  assert.equal(shouldWarmHookCursorsBeforeInstall({ since: '20260501' }), true)
})

test('setup does not warm hook cursors after a full initial sync', () => {
  assert.equal(shouldWarmHookCursorsBeforeInstall({}), false)
  assert.equal(shouldWarmHookCursorsBeforeInstall({ since: 'all' }), false)
})

test('setup hook cursor warm command uses all sources', () => {
  assert.deepEqual(buildWarmHookCursorArgs({ packageManager: 'pnpm' }), [
    '--mode',
    'warm-hooks',
    '--source',
    'all',
    '--skip-upgrade',
    '--package-manager',
    'pnpm'
  ])
})

test('setup base url must come from flags or environment', () => {
  assert.equal(readSetupBaseUrl({ flags: {}, env: {} }), null)
  assert.equal(
    readSetupBaseUrl({ flags: {}, env: { TOKENBOARD_BASE_URL: 'https://tokenboard.example.com/' } }),
    'https://tokenboard.example.com'
  )
  assert.equal(
    readSetupBaseUrl({
      flags: { 'base-url': 'https://install.tokenboard.example.com/' },
      env: { TOKENBOARD_BASE_URL: 'https://tokenboard.example.com' }
    }),
    'https://install.tokenboard.example.com'
  )
})

test('device-link reconnect setup is explicit opt-in', () => {
  assert.equal(shouldUseDeviceLink({}, {}), false)
  assert.equal(shouldUseDeviceLink({ 'use-device-link': true }, {}), true)
  assert.equal(shouldUseDeviceLink({ 'use-device-link': 'false' }, { TOKENBOARD_USE_DEVICE_LINK: '1' }), false)
  assert.equal(shouldUseDeviceLink({}, { TOKENBOARD_USE_DEVICE_LINK: '1' }), true)
})

test('device-link reconnect exchanges local claim for a pairing code', async () => {
  const requests = []
  const writes = []
  let requestedServerOrigin = null
  const pairingCode = await createPairingCodeFromDeviceLink({
    baseUrl: 'https://tokenboard.example.com',
    readDeviceLink: (options) => {
      requestedServerOrigin = options?.serverOrigin
      return {
        serverOrigin: 'https://tokenboard.example.com',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret'
      }
    },
    writeDeviceLink: (link) => writes.push(link),
    fetcher: async (url, init) => {
      requests.push({ url, init })
      return Response.json({ pairingCode: 'pairing-code' })
    }
  })

  assert.equal(pairingCode, 'pairing-code')
  assert.equal(requestedServerOrigin, 'https://tokenboard.example.com')
  assert.deepEqual(writes, [])
  assert.equal(requests[0].url, 'https://tokenboard.example.com/api/v1/device/reconnect-pairing-codes')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    deviceId: 'dev_1',
    installationId: 'inst_1',
    installClaim: 'claim-secret'
  })
})

test('device-link reconnect supports legacy rotated claim responses before pairing', async () => {
  const writes = []
  const pairingCode = await createPairingCodeFromDeviceLink({
    baseUrl: 'https://tokenboard.example.com',
    readDeviceLink: () => ({
      serverOrigin: 'https://tokenboard.example.com',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaim: 'claim-secret'
    }),
    writeDeviceLink: (link) => writes.push(link),
    fetcher: async () =>
      Response.json({
        pairingCode: 'pairing-code',
        installClaim: 'claim-rotated'
      })
  })

  assert.equal(pairingCode, 'pairing-code')
  assert.deepEqual(writes, [
    {
      serverOrigin: 'https://tokenboard.example.com',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaim: 'claim-rotated'
    }
  ])
})

test('device-link reconnect fails when a legacy rotated claim cannot be written', async () => {
  await assert.rejects(
    createPairingCodeFromDeviceLink({
      baseUrl: 'https://tokenboard.example.com',
      readDeviceLink: () => ({
        serverOrigin: 'https://tokenboard.example.com',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret'
      }),
      writeDeviceLink: () => {
        throw new Error('permission denied')
      },
      fetcher: async () =>
        Response.json({
          pairingCode: 'pairing-code',
          installClaim: 'claim-rotated'
        })
    }),
    (error) => {
      assert(error instanceof Error)
      assert.equal(error.message, 'Failed to refresh TokenBoard device link after reconnect')
      assert.equal(error.message.includes('claim-secret'), false)
      assert.equal(error.message.includes('claim-rotated'), false)
      return true
    }
  )
})

test('device-link reconnect fails when a legacy rotated claim has no writer', async () => {
  await assert.rejects(
    createPairingCodeFromDeviceLink({
      baseUrl: 'https://tokenboard.example.com',
      readDeviceLink: () => ({
        serverOrigin: 'https://tokenboard.example.com',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret'
      }),
      fetcher: async () =>
        Response.json({
          pairingCode: 'pairing-code',
          installClaim: 'claim-rotated'
        })
    }),
    (error) => {
      assert(error instanceof Error)
      assert.equal(error.message, 'Failed to refresh TokenBoard device link after reconnect')
      assert.equal(error.message.includes('claim-secret'), false)
      assert.equal(error.message.includes('claim-rotated'), false)
      return true
    }
  )
})

test('device-link reconnect fails when an async legacy rotated claim write rejects', async () => {
  await assert.rejects(
    createPairingCodeFromDeviceLink({
      baseUrl: 'https://tokenboard.example.com',
      readDeviceLink: () => ({
        serverOrigin: 'https://tokenboard.example.com',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret'
      }),
      writeDeviceLink: async () => {
        throw new Error('permission denied')
      },
      fetcher: async () =>
        Response.json({
          pairingCode: 'pairing-code',
          installClaim: 'claim-rotated'
        })
    }),
    (error) => {
      assert(error instanceof Error)
      assert.equal(error.message, 'Failed to refresh TokenBoard device link after reconnect')
      assert.equal(error.message.includes('claim-secret'), false)
      assert.equal(error.message.includes('claim-rotated'), false)
      return true
    }
  )
})

test('device-link reconnect writes a legacy rotated claim before rejecting a missing pairing code', async () => {
  const writes = []
  await assert.rejects(
    createPairingCodeFromDeviceLink({
      baseUrl: 'https://tokenboard.example.com',
      readDeviceLink: () => ({
        serverOrigin: 'https://tokenboard.example.com',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret'
      }),
      writeDeviceLink: (link) => writes.push(link),
      fetcher: async () =>
        Response.json({
          installClaim: 'claim-rotated'
        })
    }),
    /Device-link reconnect response did not include a pairing code/
  )
  assert.deepEqual(writes, [
    {
      serverOrigin: 'https://tokenboard.example.com',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaim: 'claim-rotated'
    }
  ])
})

test('device-link reconnect fails when a rotated claim without a pairing code has no writer', async () => {
  await assert.rejects(
    createPairingCodeFromDeviceLink({
      baseUrl: 'https://tokenboard.example.com',
      readDeviceLink: () => ({
        serverOrigin: 'https://tokenboard.example.com',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret'
      }),
      fetcher: async () =>
        Response.json({
          installClaim: 'claim-rotated'
        })
    }),
    (error) => {
      assert(error instanceof Error)
      assert.equal(error.message, 'Failed to refresh TokenBoard device link after reconnect')
      assert.equal(error.message.includes('claim-secret'), false)
      assert.equal(error.message.includes('claim-rotated'), false)
      return true
    }
  )
})

test('device-link reconnect fails when a rotated claim without a pairing code throws during write', async () => {
  await assert.rejects(
    createPairingCodeFromDeviceLink({
      baseUrl: 'https://tokenboard.example.com',
      readDeviceLink: () => ({
        serverOrigin: 'https://tokenboard.example.com',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret'
      }),
      writeDeviceLink: () => {
        throw new Error('permission denied')
      },
      fetcher: async () =>
        Response.json({
          installClaim: 'claim-rotated'
        })
    }),
    (error) => {
      assert(error instanceof Error)
      assert.equal(error.message, 'Failed to refresh TokenBoard device link after reconnect')
      assert.equal(error.message.includes('claim-secret'), false)
      assert.equal(error.message.includes('claim-rotated'), false)
      return true
    }
  )
})

test('device-link reconnect fails when a rotated claim without a pairing code rejects during async write', async () => {
  await assert.rejects(
    createPairingCodeFromDeviceLink({
      baseUrl: 'https://tokenboard.example.com',
      readDeviceLink: () => ({
        serverOrigin: 'https://tokenboard.example.com',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret'
      }),
      writeDeviceLink: async () => {
        throw new Error('permission denied')
      },
      fetcher: async () =>
        Response.json({
          installClaim: 'claim-rotated'
        })
    }),
    (error) => {
      assert(error instanceof Error)
      assert.equal(error.message, 'Failed to refresh TokenBoard device link after reconnect')
      assert.equal(error.message.includes('claim-secret'), false)
      assert.equal(error.message.includes('claim-rotated'), false)
      return true
    }
  )
})

test('device-link reconnect rejects a different server origin before sending the claim', async () => {
  const requests = []
  await assert.rejects(
    createPairingCodeFromDeviceLink({
      baseUrl: 'https://tokenboard.example.com',
      readDeviceLink: () => ({
        serverOrigin: 'https://private-tokenboard.example.com',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret'
      }),
      fetcher: async (url, init) => {
        requests.push({ url, init })
        return Response.json({ pairingCode: 'pairing-code' })
      }
    }),
    /TokenBoard device link belongs to a different server/
  )
  assert.equal(requests.length, 0)
})

test('device-link reconnect accepts matching origin with a path-like base url', async () => {
  const requests = []
  const pairingCode = await createPairingCodeFromDeviceLink({
    baseUrl: 'https://tokenboard.example.com/install/',
    readDeviceLink: () => ({
      serverOrigin: 'https://tokenboard.example.com',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaim: 'claim-secret'
    }),
    fetcher: async (url, init) => {
      requests.push({ url, init })
      return Response.json({ pairingCode: 'pairing-code' })
    }
  })

  assert.equal(pairingCode, 'pairing-code')
  assert.equal(requests[0].url, 'https://tokenboard.example.com/api/v1/device/reconnect-pairing-codes')
})

test('device-link reconnect fails visibly without leaking the claim', async () => {
  await assert.rejects(
    createPairingCodeFromDeviceLink({
      baseUrl: 'https://tokenboard.example.com',
      readDeviceLink: () => ({
        serverOrigin: 'https://tokenboard.example.com',
        deviceId: 'dev_1',
        installationId: 'inst_1',
        installClaim: 'claim-secret'
      }),
      fetcher: async () => new Response('claim-secret', { status: 401 })
    }),
    (error) => {
      assert.equal(error.message, 'Device-link reconnect failed with status 401')
      assert.equal(error.message.includes('claim-secret'), false)
      return true
    }
  )
})

test('setup passes repo-url override to install collector', () => {
  assert.deepEqual(
    buildInstallCollectorArgs({
      flags: {
        'repo-url': 'https://github.com/example/TokenBoard.git',
        'repo-ref': 'research/agy-token-support-plan'
      },
      installCollectorScript: '/repo/scripts/install-collector.mjs'
    }),
    [
      '/repo/scripts/install-collector.mjs',
      '--repo-url',
      'https://github.com/example/TokenBoard.git',
      '--repo-ref',
      'research/agy-token-support-plan'
    ]
  )
})
