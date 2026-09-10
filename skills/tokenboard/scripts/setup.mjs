#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hostname, platform } from 'node:os'
import {
  configDir,
  configPath,
  parseArgs,
  readConfig,
  readPackageManager,
  serverOriginFromEndpoint,
  withServerProfile,
  writeConfig
} from './config.mjs'
import { withCredentialsLock } from './credentials-lock.mjs'
import { existsSync } from 'node:fs'
import { readDeviceLink, writeDeviceLink } from './device-link.mjs'
import { errorMessage } from './error-message.mjs'
import { dailyScheduleTimes, parseScheduleTimes } from './schedule.mjs'
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

const flags = parseArgs(process.argv.slice(2))
let pairingCode = flags['pairing-code'] || process.env.TOKENBOARD_PAIRING_CODE
const baseUrl = readSetupBaseUrl({ flags })
const timezone = flags.timezone || process.env.TOKENBOARD_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone
const deviceName = flags['device-name'] || `${hostname()} ${platform()}`

if (!baseUrl) {
  console.error('Missing --base-url or TOKENBOARD_BASE_URL')
  process.exit(1)
}
const currentConfig = existsSync(configPath()) ? readConfig() : {}
const serverOrigin = serverOriginFromEndpoint(baseUrl)
if (!serverOrigin) {
  console.error('Setup base URL did not include a valid endpoint.')
  process.exit(1)
}
const savedProfile = reusableServerProfile(currentConfig, serverOrigin)
const useDeviceLink = shouldUseDeviceLink(flags)
let activeProfile

if (!pairingCode && !useDeviceLink && savedProfile) {
  withSetupCredentialsLock(() => {
    const latestConfig = existsSync(configPath()) ? readConfig() : {}
    const latestProfile = reusableServerProfile(latestConfig, serverOrigin)
    if (!latestProfile) throw new Error('TokenBoard server profile changed during setup')
    const installOptions = resolveSetupInstallOptions({
      flags,
      profile: latestProfile,
      defaultScheduleTimes: dailyScheduleTimes
    })
    const profilePackageManager = readPackageManager({ 'package-manager': installOptions.packageManager })
    const profileScheduleTimes = parseScheduleTimes(installOptions.scheduleTimesInput)
    const nextConfig = withServerProfile(latestConfig, serverOrigin, {
      ...latestProfile,
      repoUrl: installOptions.repoUrl,
      repoRef: installOptions.repoRef,
      packageManager: profilePackageManager,
      scheduleTimes: profileScheduleTimes,
      ...(installOptions.codexSymlinkRoots === undefined
        ? {}
        : {
            codexSymlinkRoots: installOptions.codexSymlinkRoots
          })
    })
    writeConfig(nextConfig)
    activeProfile = nextConfig.servers[serverOrigin]
  })
  console.log('TokenBoard server profile activated.')
} else {
  if (!pairingCode && useDeviceLink) {
    try {
      pairingCode = await createPairingCodeFromDeviceLink({
        baseUrl,
        readDeviceLink,
        writeDeviceLink
      })
    } catch (error) {
      console.error(errorMessage(error))
      process.exit(1)
    }
  }
  if (!pairingCode) {
    console.error('Missing --pairing-code')
    process.exit(1)
  }

  const response = await fetch(`${baseUrl}/api/v1/device/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingCode,
      deviceName,
      platform: platform(),
      timezone
    })
  })

  if (!response.ok) {
    console.error(`Pairing failed with status ${response.status}: ${await response.text()}`)
    process.exit(1)
  }

  const paired = await response.json()
  const pairedServerOrigin = serverOriginFromEndpoint(paired.endpoint || baseUrl)
  if (!pairedServerOrigin) {
    console.error('Pairing response did not include a valid endpoint.')
    process.exit(1)
  }
  withSetupCredentialsLock(() => {
    const latestConfig = existsSync(configPath()) ? readConfig() : {}
    const existingProfile = latestConfig?.servers?.[pairedServerOrigin]
    const installOptions = resolveSetupInstallOptions({
      flags,
      profile: existingProfile,
      defaultScheduleTimes: dailyScheduleTimes
    })
    const pairedPackageManager = readPackageManager({ 'package-manager': installOptions.packageManager })
    const pairedScheduleTimes = parseScheduleTimes(installOptions.scheduleTimesInput)
    const nextConfig = withServerProfile(latestConfig, pairedServerOrigin, {
      endpoint: paired.endpoint,
      uploadToken: paired.uploadToken,
      deviceId: paired.deviceId,
      installationId: paired.installationId,
      ...(paired.installClaim ? { installClaim: paired.installClaim } : {}),
      timezone: paired.timezone,
      source: 'all',
      repoUrl: installOptions.repoUrl,
      repoRef: installOptions.repoRef,
      packageManager: pairedPackageManager,
      scheduleTimes: pairedScheduleTimes,
      ...(installOptions.codexSymlinkRoots === undefined
        ? {}
        : {
            codexSymlinkRoots: installOptions.codexSymlinkRoots
          }),
      createdAt: new Date().toISOString()
    })
    writeConfig(nextConfig)
    activeProfile = nextConfig.servers[pairedServerOrigin]
    if (paired.installClaim) {
      writeDeviceLink(
        {
          serverOrigin: pairedServerOrigin,
          deviceId: paired.deviceId,
          installationId: paired.installationId,
          installClaim: paired.installClaim
        },
        { lockHeld: true }
      )
    }
  })
  console.log('TokenBoard config written.')
}

const installOptions = resolveSetupInstallOptions({
  flags,
  profile: activeProfile,
  defaultScheduleTimes: dailyScheduleTimes
})
const packageManager = readPackageManager({ 'package-manager': installOptions.packageManager })
const scheduleTimes = parseScheduleTimes(installOptions.scheduleTimesInput)
const installFlags = {
  ...flags,
  ...(installOptions.repoUrl ? { 'repo-url': installOptions.repoUrl } : {}),
  ...(installOptions.repoRef ? { 'repo-ref': installOptions.repoRef } : {})
}

function reusableServerProfile(config, serverOrigin) {
  const profile = config?.servers?.[serverOrigin]
  if (!profile || typeof profile !== 'object') return null
  if (typeof profile.endpoint !== 'string' || !profile.endpoint.trim()) return null
  if (typeof profile.uploadToken !== 'string' || !profile.uploadToken.trim()) return null
  return profile
}

function withSetupCredentialsLock(callback) {
  try {
    return withCredentialsLock(configDir(), callback)
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}

function scriptPath(name) {
  return fileURLToPath(new URL(name, import.meta.url))
}

if (!flags['skip-collector']) {
  const installCollector = spawnSync(
    process.execPath,
    buildInstallCollectorArgs({
      flags: installFlags,
      packageManager,
      installCollectorScript: scriptPath('./install-collector.mjs')
    }),
    {
      stdio: 'inherit'
    }
  )
  if (installCollector.status !== 0) process.exit(installCollector.status ?? 1)
}

if (!flags['skip-schedule']) {
  const schedule = spawnSync(
    process.execPath,
    [scriptPath('./install-schedule.mjs'), '--schedule-times', scheduleTimes.join(',')],
    {
      stdio: 'inherit'
    }
  )
  if (schedule.status !== 0) process.exit(schedule.status ?? 1)
}

if (!flags['skip-initial-sync']) {
  const sync = spawnSync(
    process.execPath,
    [scriptPath('./sync.mjs'), ...buildInitialSyncArgs({ flags, packageManager })],
    {
      stdio: 'inherit'
    }
  )
  if (sync.status !== 0) process.exit(sync.status ?? 1)
}

if (shouldWarmHookCursorsBeforeInstall(flags)) {
  const warm = spawnSync(process.execPath, [scriptPath('./sync.mjs'), ...buildWarmHookCursorArgs({ packageManager })], {
    stdio: 'inherit'
  })
  if (warm.status !== 0) process.exit(warm.status ?? 1)
}

if (!flags['skip-hook']) {
  const hook = spawnSync(process.execPath, [scriptPath('./install-hook.mjs')], {
    stdio: 'inherit'
  })
  if (hook.status !== 0) process.exit(hook.status ?? 1)
}
