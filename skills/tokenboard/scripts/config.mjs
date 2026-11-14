import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertCredentialsLockOwnership, withCredentialsLock } from './credentials-lock.mjs'
import { usageSources } from './usage-sources.mjs'

export function configDir() {
  return process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

// Only touches a directory, and only when its mode is not already private, so a directory the
// user owns and has already locked down is left exactly as-is.
function chmodConfigDirPrivate(dir) {
  // Windows has no POSIX permission bits: Go synthesizes them (every non-readonly entry reads as
  // 0666, see Go's os/types_windows.go), so testing `mode & 0o077` would call every directory
  // world-accessible and chmod here is a no-op anyway. Access is governed by the ACLs the state
  // directory inherits from the user profile, which is private by default. Mirrors Go's
  // internal/state/perm_windows.go.
  if (process.platform === 'win32') return
  try {
    const stats = statSync(dir)
    if (!stats.isDirectory()) return
    if ((stats.mode & 0o077) !== 0) chmodSync(dir, 0o700)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
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

// Which collector implementation this machine runs: the git checkout (the
// original install, and still the default) or the released Go binary. The
// default is 'git' so every existing install keeps working untouched; a
// machine only moves to 'binary' when the user asks for it, and moving back is
// the same flag.
export function readClientType({ flags = {}, env = process.env, config = {} } = {}) {
  const value = flags.client || env.TOKENBOARD_CLIENT || config.clientType || 'git'
  if (value === 'git' || value === 'binary') {
    return value
  }
  throw new Error(`Unsupported client type: ${value}. Expected git or binary.`)
}

// The per-source rollout map from spec §7: {pi: 'go', codex: 'ts', ...}. A
// mapping is the operator's explicit choice for that source and outranks the
// machine-wide clientType, so a migration can move one source at a time
// instead of flipping the whole install.
//
// 'go' and 'binary' both mean the released Go binary; 'ts' and 'git' both mean
// the checkout. Keeping both spellings means the map can echo the language of
// whichever side it is describing.
const sourceClientAliases = new Map([
  ['go', 'binary'],
  ['binary', 'binary'],
  ['ts', 'git'],
  ['git', 'git']
])

export function readPerSource(config = {}) {
  const mapping = config.perSource
  if (mapping === undefined) return {}
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new Error('Invalid perSource: expected an object mapping source names to git or binary.')
  }
  const resolved = {}
  for (const [source, value] of Object.entries(mapping)) {
    // A misspelled source is not harmless: it never matches a real run, so the
    // operator believes the migration is staged while every run stays on the
    // machine-wide client. Refuse the name instead, the way the source list
    // itself is a closed set.
    if (!usageSources.includes(source)) {
      throw new Error(`Invalid perSource entry for ${source}: unknown usage source.`)
    }
    if (typeof value !== 'string') {
      throw new Error(`Invalid perSource entry for ${source}: expected git, ts, go or binary.`)
    }
    const client = sourceClientAliases.get(value)
    if (!client) {
      throw new Error(`Invalid perSource entry for ${source}: ${value}. Expected git, ts, go or binary.`)
    }
    resolved[source] = client
  }
  return resolved
}

// resolveClientForSource picks the client for one invocation. A named source
// uses its perSource entry when it has one; 'all' is the case that cannot be
// split, so it requires every mapped source to agree with the machine-wide
// client and refuses a mixed map rather than silently running one client for
// everything.
export function resolveClientForSource({ flags = {}, env = process.env, config = {}, source }) {
  const defaultClient = readClientType({ flags, env, config })
  const perSource = readPerSource(config)
  const mapped = perSource[source]
  if (mapped !== undefined) {
    return mapped
  }
  if (source !== 'all') {
    return defaultClient
  }
  // An all-source run collects everything with one client. A map that names a
  // different client for any source cannot be honored, and picking either side
  // would silently collect the other's sources incorrectly.
  const conflicting = Object.entries(perSource).filter(([, client]) => client !== defaultClient)
  if (conflicting.length > 0) {
    const detail = conflicting.map(([name, client]) => `${name}=${client === 'binary' ? 'go' : 'ts'}`).join(', ')
    throw new Error(
      `perSource maps ${detail}, which differs from the machine clientType (${defaultClient === 'binary' ? 'go' : 'ts'}). ` +
        'An all-source run needs one client; sync each source separately or set perSource to a single client.'
    )
  }
  return defaultClient
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

export function readConfig() {
  return normalizeActiveServerConfig(readRawConfig())
}

function readRawConfig() {
  const file = configPath()
  if (!existsSync(file)) {
    throw new Error(`TokenBoard config not found: ${file}`)
  }

  const raw = stripUtf8Bom(readFileSync(file, 'utf8'))
  try {
    return JSON.parse(raw)
  } catch (error) {
    // `JSON.parse` embeds the offending source text in its message, and Node prints that
    // message (and, for a syntax error, the source line itself) when it reaches an
    // uncaught handler. The config file holds the upload token, so a truncated or
    // hand-edited file would put the token on stderr — exactly what SKILL.md forbids.
    // Re-throwing without the parse detail keeps the diagnosis useful and the secret out.
    throw new Error(
      `TokenBoard config is not valid JSON: ${file}. Fix or remove it, then retry. (${jsonErrorLocation(error)})`
    )
  }
}

// Only the position is carried over: `SyntaxError.message` also contains a snippet of the
// offending text, which is the part that can hold a secret.
export function jsonErrorLocation(error) {
  if (!(error instanceof SyntaxError)) return 'unparseable'
  const match = /position (\d+)/.exec(error.message)
  return match ? `parse error at position ${match[1]}` : 'parse error'
}

export function writeConfig(config) {
  // 0700 up front rather than waiting for the first sync to tighten it: the directory holds the
  // upload token in `config.json`, and between `setup` and the first sync it would otherwise sit
  // at the umask default. `recursive: true` does not change an existing directory's mode, so a
  // directory the user created themselves (or one that has since been loosened) is tightened here
  // as well — same guarantee `sync.mjs`'s `ensurePrivateStateDir` gives it on every run.
  const dir = configDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodConfigDirPrivate(dir)
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
  'clientType',
  'perSource',
  'scheduleTimes',
  'codexSymlinkRoots',
  'createdAt',
  'updatedAt'
])

// Flags may be written as `--key value` or `--key=value`. The inline form is
// what this project writes into its own hook commands (`--source=codex`), so a
// user copying that spelling into sync.mjs must get the same result instead of
// a flag literally named `source=codex` that every reader ignores.
export function parseArgs(args) {
  const flags = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const [key, inlineValue] = arg.slice(2).split(/=(.*)/s, 2)
    if (inlineValue !== undefined) {
      flags[key] = inlineValue
      continue
    }
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
