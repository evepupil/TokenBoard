import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertCredentialsLockOwnership, withCredentialsLock } from './credentials-lock.mjs'

export function configDir() {
  return process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

export function configPath() {
  return join(configDir(), 'config.json')
}

export function collectorDir() {
  return process.env.TOKENBOARD_COLLECTOR_DIR || join(configDir(), 'TokenBoard')
}

export function readPackageManager(flags = {}, config = {}) {
  const value = flags['package-manager'] || process.env.TOKENBOARD_PACKAGE_MANAGER || config.packageManager || 'pnpm'

  if (value === 'pnpm' || value === 'bun' || value === 'npm') {
    return value
  }

  throw new Error(`Unsupported package manager: ${value}. Expected pnpm, bun, or npm.`)
}

export function packageManagerCommand(packageManager, platform = process.platform) {
  if (platform !== 'win32') {
    return packageManager
  }

  if (packageManager === 'bun' || packageManager === 'pnpm') {
    return `${packageManager}.exe`
  }

  return 'npm.cmd'
}

export function packageManagerRunArgs(packageManager, scriptName, scriptArgs = []) {
  if (packageManager === 'npm') {
    return ['run', scriptName, '--', ...scriptArgs]
  }

  return ['run', scriptName, ...scriptArgs]
}

export function readConfig() {
  return normalizeActiveServerConfig(readRawConfig())
}

function readRawConfig() {
  const file = configPath()
  if (!existsSync(file)) {
    throw new Error(`TokenBoard config not found: ${file}`)
  }

  return JSON.parse(stripUtf8Bom(readFileSync(file, 'utf8')))
}

export function writeConfig(config) {
  mkdirSync(configDir(), { recursive: true })
  const file = configPath()
  const tempFile = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    assertCredentialsLockOwnership(configDir())
    renameSync(tempFile, file)
  } catch (error) {
    rmSync(tempFile, { force: true })
    throw error
  }
}

export function stripUtf8Bom(value) {
  if (value.charCodeAt(0) === 0xfeff) {
    return value.slice(1)
  }
  return value
}

export function mergeConfig(patch, options = {}) {
  const transform = (current) => mergeConfigPatch(current, patch)
  if (options.lockHeld) {
    const current = existsSync(configPath()) ? readRawConfig() : {}
    const next = transform(current)
    writeConfig(next)
    return next
  }
  return updateConfig(transform)
}

export function updateConfig(transform) {
  return withCredentialsLock(configDir(), () => {
    const current = existsSync(configPath()) ? readRawConfig() : {}
    const next = transform(current)
    writeConfig(next)
    return next
  })
}

export function serverOriginFromEndpoint(value) {
  if (!value) return null
  const url = new URL(value)
  return url.origin
}

export function normalizeActiveServerConfig(config) {
  if (!config || typeof config !== 'object') {
    return config
  }
  if (!config.activeServer || !config.servers || typeof config.servers !== 'object') {
    return config
  }

  const activeProfile = config.servers[config.activeServer]
  if (!activeProfile || typeof activeProfile !== 'object') {
    return config
  }

  return rootConfigFromProfile(config, activeProfile)
}

function mergeConfigPatch(current, patch) {
  const definedPatch = withoutUndefinedFields(patch)
  if (!hasActiveServerProfile(current)) {
    const next = { ...current, ...definedPatch }
    if (definedPatch.servers !== undefined || current.servers !== undefined) {
      const servers = definedPatch.servers !== undefined ? definedPatch.servers : current.servers
      next.servers = persistedServerProfiles(servers)
    }
    return next
  }

  const activeServer = patchActiveServer(definedPatch) || current.activeServer
  const profilePatch = serverProfilePatch(definedPatch)
  const servers = mergeServerProfiles(current.servers, definedPatch.servers)
  const activeProfile = {
    ...persistedServerProfile(servers[activeServer]),
    ...profilePatch
  }
  servers[activeServer] = activeProfile

  return rootConfigFromProfile({ ...current, ...definedPatch, activeServer, servers }, activeProfile)
}

function hasActiveServerProfile(config) {
  if (!config || typeof config !== 'object') return false
  if (!config.activeServer || !config.servers || typeof config.servers !== 'object') return false
  return Boolean(config.servers[config.activeServer] && typeof config.servers[config.activeServer] === 'object')
}

function mergeServerProfiles(currentServers, patchServers) {
  const servers = persistedServerProfiles(currentServers)
  if (!patchServers || typeof patchServers !== 'object') return servers

  for (const [serverOrigin, profile] of Object.entries(patchServers)) {
    if (profile === undefined) continue
    if (profile && typeof profile === 'object') {
      const nextProfile = persistedServerProfile(profile)
      if (servers[serverOrigin] && typeof servers[serverOrigin] === 'object') {
        servers[serverOrigin] = { ...persistedServerProfile(servers[serverOrigin]), ...nextProfile }
      } else {
        servers[serverOrigin] = nextProfile
      }
    } else {
      servers[serverOrigin] = profile
    }
  }
  return servers
}

function patchActiveServer(patch) {
  if (typeof patch.activeServer !== 'string') return null
  const activeServer = patch.activeServer.trim()
  return activeServer || null
}

function serverProfilePatch(patch) {
  const profilePatch = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'activeServer' || key === 'servers') continue
    if (value === undefined) continue
    if (!profileScopedRootKeys.has(key)) continue
    profilePatch[key] = value
  }
  return profilePatch
}

export function withServerProfile(current, serverOrigin, profile) {
  const { servers, nextProfile } = mergedServerProfile(current, serverOrigin, profile)
  return rootConfigFromProfile({ ...current, activeServer: serverOrigin, servers }, nextProfile)
}

export function withUpdatedServerProfile(current, serverOrigin, profile) {
  const { servers, nextProfile } = mergedServerProfile(current, serverOrigin, profile)
  const activeServer = current.activeServer
  if (!activeServer || activeServer === serverOrigin) {
    return rootConfigFromProfile({ ...current, activeServer: serverOrigin, servers }, nextProfile)
  }
  const activeProfile = servers[activeServer]
  if (!activeProfile || typeof activeProfile !== 'object') {
    return { ...current, servers }
  }
  return rootConfigFromProfile({ ...current, servers }, activeProfile)
}

function mergedServerProfile(current, serverOrigin, profile) {
  const servers = serverProfilesWithLegacyRoot(current)
  const definedProfile = persistedServerProfile(profile)
  const nextProfile = {
    ...persistedServerProfile(servers[serverOrigin]),
    ...definedProfile
  }
  servers[serverOrigin] = nextProfile
  return { servers, nextProfile }
}

function serverProfilesWithLegacyRoot(current) {
  const servers = persistedServerProfiles(current.servers)
  if (hasActiveServerProfile(current) || !current?.endpoint) return servers
  const legacyOrigin = serverOriginFromEndpoint(current.endpoint)
  const legacyProfile = persistedServerProfile(current)
  servers[legacyOrigin] = {
    ...legacyProfile,
    ...persistedServerProfile(servers[legacyOrigin])
  }
  return servers
}

function withoutUndefinedFields(value) {
  const next = {}
  for (const [key, fieldValue] of Object.entries(value || {})) {
    if (fieldValue !== undefined) next[key] = fieldValue
  }
  return next
}

function rootConfigFromProfile(config, profile) {
  const root = {}
  for (const [key, value] of Object.entries(config || {})) {
    if (key === 'activeServer' || key === 'servers') {
      continue
    }
    if (!profileScopedRootKeys.has(key)) {
      root[key] = value
    }
  }

  return {
    ...root,
    ...profileScopedFields(profile),
    activeServer: config.activeServer,
    servers: persistedServerProfiles(config.servers)
  }
}

function profileScopedFields(profile) {
  const fields = {}
  for (const [key, value] of Object.entries(profile || {})) {
    if (profileScopedRootKeys.has(key)) {
      fields[key] = value
    }
  }
  return fields
}

function persistedServerProfile(profile) {
  return profileScopedFields(withoutUndefinedFields(profile))
}

function persistedServerProfiles(servers) {
  const next = {}
  for (const [serverOrigin, profile] of Object.entries(servers || {})) {
    next[serverOrigin] = profile && typeof profile === 'object' ? persistedServerProfile(profile) : profile
  }
  return next
}

const profileScopedRootKeys = new Set([
  'endpoint',
  'uploadToken',
  'deviceId',
  'installationId',
  'installClaim',
  'timezone',
  'source',
  'collectorDir',
  'repoUrl',
  'repoRef',
  'packageManager',
  'scheduleTimes',
  'codexSymlinkRoots',
  'createdAt',
  'updatedAt'
])

export function parseArgs(args) {
  const flags = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[index + 1]
    if (!next || next.startsWith('--')) {
      flags[key] = true
      continue
    }
    flags[key] = next
    index += 1
  }
  return flags
}
