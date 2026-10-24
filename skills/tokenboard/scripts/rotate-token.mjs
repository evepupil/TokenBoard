#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { isMainModule } from './is-main.mjs'
import {
  configDir,
  configPath,
  parseArgs,
  readConfig,
  serverOriginFromEndpoint,
  withUpdatedServerProfile,
  writeConfig
} from './config.mjs'
import { withCredentialsLock } from './credentials-lock.mjs'
import { writeDeviceLink } from './device-link.mjs'
import { errorMessage } from './error-message.mjs'
import { printHelpIfRequested } from './cli-help.mjs'

export function applyRotatedToken({
  currentConfig,
  serverOrigin,
  uploadToken,
  deviceId,
  installationId,
  installClaim,
  writeConfigFn = writeConfig,
  writeDeviceLinkFn = writeDeviceLink
}) {
  const currentProfile = readCurrentServerProfile(currentConfig, serverOrigin)
  const nextConfig = withUpdatedServerProfile(currentConfig, serverOrigin, {
    ...currentProfile,
    uploadToken,
    deviceId,
    installationId,
    ...(installClaim ? { installClaim } : {})
  })
  writeConfigFn(nextConfig)
  if (installClaim) {
    writeDeviceLinkFn({
      serverOrigin,
      deviceId,
      installationId,
      installClaim
    })
  }
  return nextConfig
}

function readCurrentServerProfile(config, serverOrigin) {
  if (!config || typeof config !== 'object') {
    throw new Error('TokenBoard config is invalid')
  }
  const profile = config.servers?.[serverOrigin]
  if (profile && typeof profile === 'object') return profile
  if (config.activeServer === serverOrigin) return config
  if (!config.activeServer && serverOriginFromEndpoint(config.endpoint) === serverOrigin) {
    return config
  }
  throw new Error('TokenBoard config does not contain this server profile')
}

function requiredFlag(flags, name) {
  const value = flags[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing --${name}`)
  }
  return value
}

function readServerOrigin(flags) {
  const serverOrigin = flags['server-origin'] || serverOriginFromEndpoint(flags.endpoint)
  if (typeof serverOrigin !== 'string' || serverOrigin.trim() === '') {
    throw new Error('Missing --server-origin or --endpoint')
  }
  return new URL(serverOrigin).origin
}

function runCli() {
  if (
    printHelpIfRequested(
      process.argv.slice(2),
      'Usage: rotate-token.mjs [--upload-token TOKEN] --device-id ID --installation-id ID [--endpoint URL | --server-origin ORIGIN] [--install-claim CLAIM]\n' +
        'The token may also come from TOKENBOARD_UPLOAD_TOKEN, which keeps it out of the process table and shell history.'
    )
  ) {
    return
  }
  try {
    if (!existsSync(configPath())) {
      throw new Error(`TokenBoard config not found: ${configPath()}`)
    }
    const flags = parseArgs(process.argv.slice(2))
    // A rotated upload token is long-lived and authorizes uploads as this device. Passing it
    // as `--upload-token` writes it into the process table (`/proc/<pid>/cmdline` is readable
    // by every local user for the process lifetime on Linux) and into shell history. The
    // environment channel is the fallback, mirroring how setup.mjs takes its pairing code.
    const uploadToken = flags['upload-token'] || process.env.TOKENBOARD_UPLOAD_TOKEN
    if (typeof uploadToken !== 'string' || uploadToken.trim() === '') {
      throw new Error('Missing --upload-token or TOKENBOARD_UPLOAD_TOKEN')
    }
    withCredentialsLock(configDir(), () => {
      applyRotatedToken({
        currentConfig: readConfig(),
        serverOrigin: readServerOrigin(flags),
        uploadToken: uploadToken.trim(),
        deviceId: requiredFlag(flags, 'device-id'),
        installationId: requiredFlag(flags, 'installation-id'),
        installClaim: flags['install-claim'] ? String(flags['install-claim']) : null,
        writeDeviceLinkFn: (link) => writeDeviceLink(link, { lockHeld: true })
      })
    })
    console.log('TokenBoard rotated token written.')
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}

if (isMainModule(import.meta.url)) {
  runCli()
}
