import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './config.mjs'
import { assertCredentialsLockOwnership, withCredentialsLock } from './credentials-lock.mjs'
import { readCanonicalDeviceLink, syncDeviceLinkToConfig } from './device-link-config.mjs'

const deviceLinkStoreVersion = 2
const defaultFs = {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
}

export function deviceLinkPath(root = configDir()) {
  return join(root, 'device-link.json')
}

export function writeDeviceLink(link, options = {}) {
  const root = options.configDir || configDir()
  const path = options.path || deviceLinkPath(root)
  const fs = options.fs || defaultFs
  const normalized = normalizeDeviceLink(link)
  fs.mkdirSync(root, { recursive: true })
  const update = () => {
    syncDeviceLinkToConfig(normalized, root, { ...options, lockHeld: true })
    const store = readDeviceLinkStore(path, fs)
    store.servers[normalized.serverOrigin] = storedDeviceLink(normalized)
    writeDeviceLinkStore(path, store, fs, root)
  }
  if (options.fs || options.lockHeld) update()
  else withCredentialsLock(root, update)
  return path
}

export function readDeviceLink(options = {}) {
  const path = options.path || deviceLinkPath(options.configDir || configDir())
  const fs = options.fs || { existsSync, readFileSync }
  const root = options.configDir || configDir()
  const requestedOrigin = options.serverOrigin ? normalizeServerOrigin(options.serverOrigin) : null
  const configLink = readCanonicalDeviceLink(root, requestedOrigin, options)
  if (configLink) return configLink
  if (!fs.existsSync(path)) return null
  const store = normalizeDeviceLinkStore(JSON.parse(fs.readFileSync(path, 'utf8')))
  if (requestedOrigin) {
    return store.servers[requestedOrigin] ? deviceLinkFromStored(requestedOrigin, store.servers[requestedOrigin]) : null
  }
  const entries = Object.entries(store.servers)
  if (entries.length === 0) return null
  if (entries.length > 1) {
    throw new Error('Invalid TokenBoard device link: serverOrigin is required')
  }
  return deviceLinkFromStored(entries[0][0], entries[0][1])
}

export function deviceLinkStatus(options = {}) {
  const path = options.path || deviceLinkPath(options.configDir || configDir())
  const fs = options.fs || { existsSync }
  return {
    path,
    present: fs.existsSync(path)
  }
}

function normalizeDeviceLink(link) {
  if (!link || typeof link !== 'object' || Array.isArray(link)) {
    throw new Error('Invalid TokenBoard device link: expected object')
  }
  const normalized = {
    version: 1,
    serverOrigin: normalizeServerOrigin(link.serverOrigin),
    deviceId: requiredString(link.deviceId, 'deviceId'),
    installationId: requiredString(link.installationId, 'installationId'),
    installClaim: requiredString(link.installClaim, 'installClaim')
  }
  return normalized
}

function readDeviceLinkStore(path, fs) {
  if (!fs.existsSync(path)) {
    return { version: deviceLinkStoreVersion, servers: {} }
  }
  return normalizeDeviceLinkStore(JSON.parse(fs.readFileSync(path, 'utf8')))
}

function writeDeviceLinkStore(path, store, fs, root) {
  const content = `${JSON.stringify(store, null, 2)}\n`
  if (!fs.renameSync || !fs.rmSync) {
    fs.writeFileSync(path, content, { mode: 0o600 })
    fs.chmodSync?.(path, 0o600)
    return
  }
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    fs.writeFileSync(tempPath, content, { mode: 0o600 })
    assertCredentialsLockOwnership(root)
    fs.renameSync(tempPath, path)
    fs.chmodSync?.(path, 0o600)
  } catch (error) {
    fs.rmSync(tempPath, { force: true })
    throw error
  }
}

function normalizeDeviceLinkStore(value) {
  if (value?.version === 1) {
    const legacy = normalizeDeviceLink(value)
    return {
      version: deviceLinkStoreVersion,
      servers: { [legacy.serverOrigin]: storedDeviceLink(legacy) }
    }
  }
  if (value?.version !== deviceLinkStoreVersion) {
    throw new Error(`Invalid TokenBoard device link: unsupported store version ${String(value?.version)}`)
  }
  if (!value.servers || typeof value.servers !== 'object' || Array.isArray(value.servers)) {
    throw new Error('Invalid TokenBoard device link: expected servers object')
  }
  const servers = {}
  for (const [serverOrigin, link] of Object.entries(value.servers)) {
    const normalized = normalizeDeviceLink({ ...link, serverOrigin })
    servers[normalized.serverOrigin] = storedDeviceLink(normalized)
  }
  return { version: deviceLinkStoreVersion, servers }
}

function storedDeviceLink(link) {
  return {
    deviceId: link.deviceId,
    installationId: link.installationId,
    installClaim: link.installClaim
  }
}

function deviceLinkFromStored(serverOrigin, link) {
  return normalizeDeviceLink({ ...link, serverOrigin })
}

function normalizeServerOrigin(value) {
  const raw = requiredString(value, 'serverOrigin')
  try {
    return new URL(raw).origin
  } catch {
    throw new Error('Invalid TokenBoard device link: invalid serverOrigin')
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid TokenBoard device link: missing ${name}`)
  }
  return value.trim()
}
