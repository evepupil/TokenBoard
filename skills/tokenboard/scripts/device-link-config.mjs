import { configDir, configPath, mergeConfig, readConfig } from './config.mjs'
import { existsSync } from 'node:fs'

export function syncDeviceLinkToConfig(link, root, options = {}) {
  if (options.fs || root !== configDir() || !existsSync(configPath())) return
  mergeConfig(
    {
      servers: {
        [link.serverOrigin]: {
          deviceId: link.deviceId,
          installationId: link.installationId,
          installClaim: link.installClaim
        }
      }
    },
    { lockHeld: options.lockHeld }
  )
}

export function readCanonicalDeviceLink(root, requestedOrigin, options = {}) {
  if (options.fs || root !== configDir() || !existsSync(configPath())) return null
  return readConfigDeviceLink(readConfig(), requestedOrigin)
}

function readConfigDeviceLink(config, requestedOrigin) {
  const profiles = config?.servers
  if (!profiles || typeof profiles !== 'object') return null
  const origins = requestedOrigin ? [requestedOrigin] : Object.keys(profiles)
  const matches = origins
    .map((origin) => [origin, profiles[origin]])
    .filter(
      ([, profile]) =>
        profile &&
        typeof profile === 'object' &&
        typeof profile.deviceId === 'string' &&
        profile.deviceId.trim() &&
        typeof profile.installationId === 'string' &&
        profile.installationId.trim() &&
        typeof profile.installClaim === 'string' &&
        profile.installClaim.trim()
    )
  if (matches.length === 0) return null
  if (!requestedOrigin && matches.length > 1) {
    throw new Error('Invalid TokenBoard device link: serverOrigin is required')
  }
  const [serverOrigin, profile] = matches[0]
  return {
    version: 1,
    serverOrigin,
    deviceId: profile.deviceId,
    installationId: profile.installationId,
    installClaim: profile.installClaim
  }
}
