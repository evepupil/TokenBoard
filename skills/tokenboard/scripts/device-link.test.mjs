import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig, writeConfig } from './config.mjs'
import { normalizeMemoryPath } from './coordinator-test-helpers.mjs'
import { deviceLinkPath, deviceLinkStatus, readDeviceLink, writeDeviceLink } from './device-link.mjs'

test('writes device-link.json with private file mode', () => {
  const writes = []
  const chmods = []
  const mkdirs = []
  const files = new Map()
  const fs = {
    mkdirSync(path, options) {
      mkdirs.push({ path, options })
    },
    writeFileSync(path, value, options) {
      writes.push({ path, value, options })
      files.set(path, value)
    },
    chmodSync(path, mode) {
      chmods.push({ path, mode })
    },
    existsSync(path) {
      return files.has(path)
    },
    readFileSync(path) {
      return files.get(path)
    }
  }

  const path = writeDeviceLink(
    {
      serverOrigin: 'https://tokenboard.example',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaim: 'claim-secret'
    },
    { configDir: '/home/user/.tokenboard', fs }
  )

  assert.equal(normalizeMemoryPath(path), '/home/user/.tokenboard/device-link.json')
  assert.deepEqual(mkdirs, [{ path: '/home/user/.tokenboard', options: { recursive: true } }])
  assert.equal(writes[0].options.mode, 0o600)
  assert.deepEqual(
    chmods.map(({ path: chmodPath, mode }) => ({ path: normalizeMemoryPath(chmodPath), mode })),
    [{ path: '/home/user/.tokenboard/device-link.json', mode: 0o600 }]
  )
  assert.deepEqual(readDeviceLink({ path, fs }), {
    version: 1,
    serverOrigin: 'https://tokenboard.example',
    deviceId: 'dev_1',
    installationId: 'inst_1',
    installClaim: 'claim-secret'
  })
})

test('trims device link identity fields before persistence', () => {
  const files = new Map()
  const fs = {
    mkdirSync() {},
    writeFileSync(path, value) {
      files.set(path, value)
    },
    chmodSync() {},
    existsSync(path) {
      return files.has(path)
    },
    readFileSync(path) {
      return files.get(path)
    }
  }
  const path = writeDeviceLink(
    {
      serverOrigin: ' https://tokenboard.example/path ',
      deviceId: ' device-1 ',
      installationId: ' installation-1 ',
      installClaim: ' claim-1 '
    },
    { configDir: '/home/user/.tokenboard', fs }
  )

  assert.deepEqual(readDeviceLink({ path, fs }), {
    version: 1,
    serverOrigin: 'https://tokenboard.example',
    deviceId: 'device-1',
    installationId: 'installation-1',
    installClaim: 'claim-1'
  })
})

test('reports only device link presence and path', () => {
  assert.deepEqual(
    deviceLinkStatus({
      path: '/home/user/.tokenboard/device-link.json',
      fs: { existsSync: () => true }
    }),
    {
      path: '/home/user/.tokenboard/device-link.json',
      present: true
    }
  )
})

test('builds device link path under config directory', () => {
  assert.equal(normalizeMemoryPath(deviceLinkPath('/tmp/tokenboard')), '/tmp/tokenboard/device-link.json')
})

test('preserves and selects device links by server origin', () => {
  const files = new Map()
  const fs = {
    mkdirSync() {},
    writeFileSync(path, value) {
      files.set(path, value)
    },
    chmodSync() {},
    existsSync(path) {
      return files.has(path)
    },
    readFileSync(path) {
      return files.get(path)
    }
  }
  const path = '/home/user/.tokenboard/device-link.json'
  files.set(
    path,
    `${JSON.stringify({
      version: 1,
      serverOrigin: 'https://prod.example.com',
      deviceId: 'dev_prod',
      installationId: 'inst_prod',
      installClaim: 'claim-prod'
    })}\n`
  )

  writeDeviceLink(
    {
      serverOrigin: 'https://private.example.com',
      deviceId: 'dev_private',
      installationId: 'inst_private',
      installClaim: 'claim-private'
    },
    { configDir: '/home/user/.tokenboard', path, fs }
  )

  const stored = JSON.parse(files.get(path))
  assert.equal(stored.version, 2)
  assert.deepEqual(Object.keys(stored.servers).sort(), ['https://private.example.com', 'https://prod.example.com'])

  assert.deepEqual(readDeviceLink({ path, fs, serverOrigin: 'https://prod.example.com' }), {
    version: 1,
    serverOrigin: 'https://prod.example.com',
    deviceId: 'dev_prod',
    installationId: 'inst_prod',
    installClaim: 'claim-prod'
  })
  assert.deepEqual(readDeviceLink({ path, fs, serverOrigin: 'https://private.example.com' }), {
    version: 1,
    serverOrigin: 'https://private.example.com',
    deviceId: 'dev_private',
    installationId: 'inst_private',
    installClaim: 'claim-private'
  })
})

test('rejects unsupported device-link store versions without overwriting them', () => {
  const path = '/home/user/.tokenboard/device-link.json'
  const futureStore = `${JSON.stringify({ version: 3, servers: {} })}\n`
  const files = new Map([[path, futureStore]])
  const fs = {
    mkdirSync() {},
    writeFileSync(filePath, value) {
      files.set(filePath, value)
    },
    chmodSync() {},
    existsSync(filePath) {
      return files.has(filePath)
    },
    readFileSync(filePath) {
      return files.get(filePath)
    }
  }

  assert.throws(
    () =>
      writeDeviceLink(
        {
          serverOrigin: 'https://tokenboard.example',
          deviceId: 'dev_1',
          installationId: 'inst_1',
          installClaim: 'claim-new'
        },
        { configDir: '/home/user/.tokenboard', path, fs }
      ),
    /unsupported store version 3/
  )
  assert.equal(files.get(path), futureStore)
})

test('preserves all server links across concurrent writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-device-link-concurrent-'))
  try {
    const script = [
      "import { writeDeviceLink } from './device-link.mjs'",
      'writeDeviceLink(JSON.parse(process.env.TOKENBOARD_DEVICE_LINK), { configDir: process.env.TOKENBOARD_DEVICE_ROOT })'
    ].join('\n')
    const writers = Array.from({ length: 12 }, (_, index) =>
      spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: new URL('.', import.meta.url),
        env: {
          ...process.env,
          TOKENBOARD_DEVICE_ROOT: root,
          TOKENBOARD_DEVICE_LINK: JSON.stringify({
            serverOrigin: `https://server-${index}.example.com`,
            deviceId: `dev_${index}`,
            installationId: `inst_${index}`,
            installClaim: `claim_${index}`
          })
        },
        stdio: ['ignore', 'ignore', 'pipe']
      })
    )
    const errors = await Promise.all(writers.map((writer) => collectExit(writer)))
    assert.deepEqual(errors, Array(12).fill(''))

    const raw = JSON.parse(await readFile(join(root, 'device-link.json'), 'utf8'))
    assert.equal(Object.keys(raw.servers).length, 12)
    for (let index = 0; index < 12; index += 1) {
      assert.equal(raw.servers[`https://server-${index}.example.com`].installClaim, `claim_${index}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('does not reclaim an old device-link lock while its owner pid is alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-device-link-reused-pid-'))
  const lockPath = join(root, 'device-link.json.lock')
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'stale-owner' }))
    const expiredAt = new Date(Date.now() - 120_000)
    await utimes(lockPath, expiredAt, expiredAt)

    assert.throws(
      () =>
        writeDeviceLink(
          {
            serverOrigin: 'https://tokenboard.example',
            deviceId: 'dev_1',
            installationId: 'inst_1',
            installClaim: 'claim-new'
          },
          { configDir: root }
        ),
      /Timed out waiting for TokenBoard credentials lock/
    )
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), {
      pid: process.pid,
      token: 'stale-owner'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('uses config profile as the canonical recovery credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-device-link-canonical-'))
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  process.env.TOKENBOARD_CONFIG_DIR = root
  try {
    writeConfig({
      activeServer: 'https://prod.example.com',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'token-new',
          deviceId: 'device-new',
          installationId: 'installation-new',
          installClaim: 'claim-new'
        }
      }
    })
    await writeFile(
      deviceLinkPath(root),
      `${JSON.stringify({
        version: 2,
        servers: {
          'https://prod.example.com': {
            version: 1,
            deviceId: 'device-old',
            installationId: 'installation-old',
            installClaim: 'claim-old'
          }
        }
      })}\n`,
      { mode: 0o600 }
    )

    assert.deepEqual(readDeviceLink({ serverOrigin: 'https://prod.example.com' }), {
      version: 1,
      serverOrigin: 'https://prod.example.com',
      deviceId: 'device-new',
      installationId: 'installation-new',
      installClaim: 'claim-new'
    })
  } finally {
    if (previousConfigDir === undefined) delete process.env.TOKENBOARD_CONFIG_DIR
    else process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    await rm(root, { recursive: true, force: true })
  }
})

test('updates the canonical config together with the compatibility mirror', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-device-link-config-'))
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  process.env.TOKENBOARD_CONFIG_DIR = root
  try {
    writeConfig({
      activeServer: 'https://prod.example.com',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'token-new',
          deviceId: 'device-old',
          installationId: 'installation-old',
          installClaim: 'claim-old'
        }
      }
    })

    writeDeviceLink({
      serverOrigin: 'https://prod.example.com',
      deviceId: 'device-new',
      installationId: 'installation-new',
      installClaim: 'claim-new'
    })

    const profile = readConfig().servers['https://prod.example.com']
    assert.equal(profile.deviceId, 'device-new')
    assert.equal(profile.installationId, 'installation-new')
    assert.equal(profile.installClaim, 'claim-new')
  } finally {
    if (previousConfigDir === undefined) delete process.env.TOKENBOARD_CONFIG_DIR
    else process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    await rm(root, { recursive: true, force: true })
  }
})

function collectExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => resolve(status === 0 ? '' : stderr || `exit ${status}`))
  })
}
