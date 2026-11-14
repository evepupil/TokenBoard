import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { applyRotatedToken } from './rotate-token.mjs'

test('applies a rotated token to the matching server profile only', () => {
  const writes = []
  const deviceLinks = []
  const nextConfig = applyRotatedToken({
    currentConfig: {
      activeServer: 'https://prod.example.com',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-old',
          deviceId: 'dev_prod',
          installationId: 'inst_prod',
          timezone: 'UTC'
        },
        'https://private.example.com': {
          endpoint: 'https://private.example.com/api/v1/ingest',
          uploadToken: 'private-token',
          deviceId: 'dev_private',
          installationId: 'inst_private',
          timezone: 'Asia/Shanghai'
        }
      }
    },
    serverOrigin: 'https://prod.example.com',
    uploadToken: 'prod-new',
    deviceId: 'dev_prod',
    installationId: 'inst_prod',
    installClaim: 'claim-new',
    writeConfigFn: (config) => writes.push(config),
    writeDeviceLinkFn: (link) => deviceLinks.push(link)
  })

  assert.equal(nextConfig.uploadToken, 'prod-new')
  assert.equal(nextConfig.servers['https://prod.example.com'].uploadToken, 'prod-new')
  assert.equal(nextConfig.servers['https://prod.example.com'].installClaim, 'claim-new')
  assert.equal(nextConfig.servers['https://private.example.com'].uploadToken, 'private-token')
  assert.equal(writes.length, 1)
  assert.deepEqual(deviceLinks, [
    {
      serverOrigin: 'https://prod.example.com',
      deviceId: 'dev_prod',
      installationId: 'inst_prod',
      installClaim: 'claim-new'
    }
  ])
})

test('keeps the active server when rotating a saved inactive profile', () => {
  const writes = []
  const nextConfig = applyRotatedToken({
    currentConfig: {
      activeServer: 'https://prod.example.com',
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'prod-old',
      deviceId: 'dev_prod',
      installationId: 'inst_prod',
      timezone: 'UTC',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-old',
          deviceId: 'dev_prod',
          installationId: 'inst_prod',
          timezone: 'UTC'
        },
        'https://private.example.com': {
          endpoint: 'https://private.example.com/api/v1/ingest',
          uploadToken: 'private-old',
          deviceId: 'dev_private',
          installationId: 'inst_private',
          timezone: 'Asia/Shanghai'
        }
      }
    },
    serverOrigin: 'https://private.example.com',
    uploadToken: 'private-new',
    deviceId: 'dev_private',
    installationId: 'inst_private',
    installClaim: null,
    writeConfigFn: (config) => writes.push(config),
    writeDeviceLinkFn: () => {}
  })

  assert.equal(nextConfig.activeServer, 'https://prod.example.com')
  assert.equal(nextConfig.endpoint, 'https://prod.example.com/api/v1/ingest')
  assert.equal(nextConfig.uploadToken, 'prod-old')
  assert.equal(nextConfig.deviceId, 'dev_prod')
  assert.equal(nextConfig.installationId, 'inst_prod')
  assert.equal(nextConfig.servers['https://private.example.com'].uploadToken, 'private-new')
  assert.equal(nextConfig.servers['https://prod.example.com'].uploadToken, 'prod-old')
  assert.deepEqual(writes, [nextConfig])
})

test('rejects a server origin that is not present in config', () => {
  assert.throws(
    () =>
      applyRotatedToken({
        currentConfig: {
          activeServer: 'https://prod.example.com',
          servers: {
            'https://prod.example.com': {
              endpoint: 'https://prod.example.com/api/v1/ingest',
              uploadToken: 'prod-old',
              deviceId: 'dev_prod',
              installationId: 'inst_prod'
            }
          }
        },
        serverOrigin: 'https://private.example.com',
        uploadToken: 'private-new',
        deviceId: 'dev_private',
        installationId: 'inst_private',
        installClaim: 'claim-new',
        writeConfigFn: () => {},
        writeDeviceLinkFn: () => {}
      }),
    /does not contain this server profile/
  )
})

test('updates legacy active config when profiles are not present', () => {
  const writes = []
  const nextConfig = applyRotatedToken({
    currentConfig: {
      activeServer: 'https://prod.example.com',
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'prod-old',
      deviceId: 'dev_prod',
      installationId: 'inst_prod',
      timezone: 'UTC'
    },
    serverOrigin: 'https://prod.example.com',
    uploadToken: 'prod-new',
    deviceId: 'dev_prod',
    installationId: 'inst_prod',
    installClaim: null,
    writeConfigFn: (config) => writes.push(config),
    writeDeviceLinkFn: () => {
      throw new Error('device link should not be written without install claim')
    }
  })

  assert.equal(nextConfig.uploadToken, 'prod-new')
  assert.equal(nextConfig.servers['https://prod.example.com'].uploadToken, 'prod-new')
  assert.equal(writes.length, 1)
})

test('updates legacy config by endpoint origin when active server is absent', () => {
  const nextConfig = applyRotatedToken({
    currentConfig: {
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'prod-old',
      deviceId: 'dev_prod',
      installationId: 'inst_prod',
      timezone: 'UTC'
    },
    serverOrigin: 'https://prod.example.com',
    uploadToken: 'prod-new',
    deviceId: 'dev_prod',
    installationId: 'inst_prod',
    installClaim: null,
    writeConfigFn: () => {},
    writeDeviceLinkFn: () => {
      throw new Error('device link should not be written without install claim')
    }
  })

  assert.equal(nextConfig.activeServer, 'https://prod.example.com')
  assert.equal(nextConfig.uploadToken, 'prod-new')
  assert.equal(nextConfig.servers['https://prod.example.com'].uploadToken, 'prod-new')
})

// The rotated token is a long-lived credential. The CLI resolves it from the environment when
// the flag is absent so an operator can keep it out of the process table and shell history;
// without either channel it must refuse rather than rotate with an empty value.
test('the CLI takes the upload token from TOKENBOARD_UPLOAD_TOKEN when the flag is absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-rotate-env-'))
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const previousToken = process.env.TOKENBOARD_UPLOAD_TOKEN
  process.env.TOKENBOARD_CONFIG_DIR = root
  delete process.env.TOKENBOARD_UPLOAD_TOKEN
  try {
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        activeServer: 'https://prod.example.com',
        servers: {
          'https://prod.example.com': {
            endpoint: 'https://prod.example.com/api/v1/ingest',
            uploadToken: 'old-token',
            deviceId: 'dev_old',
            installationId: 'inst_old',
            timezone: 'UTC'
          }
        }
      })
    )

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./rotate-token.mjs', import.meta.url)),
        '--server-origin',
        'https://prod.example.com',
        '--device-id',
        'dev_new',
        '--installation-id',
        'inst_new'
      ],
      { env: { ...process.env, TOKENBOARD_UPLOAD_TOKEN: 'rotated-token-value' }, encoding: 'utf8' }
    )

    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    assert.equal(config.servers['https://prod.example.com'].uploadToken, 'rotated-token-value')
  } finally {
    if (previousConfigDir === undefined) delete process.env.TOKENBOARD_CONFIG_DIR
    else process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    if (previousToken === undefined) delete process.env.TOKENBOARD_UPLOAD_TOKEN
    else process.env.TOKENBOARD_UPLOAD_TOKEN = previousToken
    rmSync(root, { recursive: true, force: true })
  }
})

test('the CLI refuses to rotate without a token on either channel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-rotate-none-'))
  const previousConfigDir = process.env.TOKENBOARD_CONFIG_DIR
  const previousToken = process.env.TOKENBOARD_UPLOAD_TOKEN
  process.env.TOKENBOARD_CONFIG_DIR = root
  delete process.env.TOKENBOARD_UPLOAD_TOKEN
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ activeServer: 'https://x.example.com' }))

    // No flag and no env: the run fails instead of writing an empty token.
    const missing = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./rotate-token.mjs', import.meta.url)),
        '--device-id',
        'dev',
        '--installation-id',
        'inst'
      ],
      { env: { ...process.env }, encoding: 'utf8' }
    )
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /Missing --upload-token or TOKENBOARD_UPLOAD_TOKEN/)
  } finally {
    if (previousConfigDir === undefined) delete process.env.TOKENBOARD_CONFIG_DIR
    else process.env.TOKENBOARD_CONFIG_DIR = previousConfigDir
    if (previousToken === undefined) delete process.env.TOKENBOARD_UPLOAD_TOKEN
    else process.env.TOKENBOARD_UPLOAD_TOKEN = previousToken
    rmSync(root, { recursive: true, force: true })
  }
})
