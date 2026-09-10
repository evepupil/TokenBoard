#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readConfig, parseArgs, collectorDir, readPackageManager } from './config.mjs'
import { normalizePathEnv } from './schedule.mjs'
import { readSince } from './sync-options.mjs'
import { closeScheduledLogRuntime, createScheduledLogRuntime } from './logs.mjs'
import { runUpgrade } from './upgrade.mjs'
import { errorMessage } from './error-message.mjs'
import { acquireLock, lockHasToken, releaseLock, waitForLock } from './coordinator-lock.mjs'
import { runScheduledRetry } from './scheduled-retry.mjs'
import { currentProcessStartIdentity } from './process-liveness.mjs'

const defaultSyncLockTimeoutMs = 60_000

if (isMain()) {
  process.exit(runCli())
}

function runCli() {
  let logs
  try {
    const flags = parseArgs(process.argv.slice(2))
    const config = readConfig()
    const homeDir = homedir()
    const invocation = buildSyncInvocation({
      flags,
      config,
      pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      homeDir,
      nodePath: process.execPath,
      platform: process.platform
    })
    logs = createScheduledLogRuntime({
      env: process.env,
      homeDir,
      scheduled: flags.scheduled === true
    })

    return runSyncInvocation({
      flags,
      invocation,
      logs,
      stateDir: configDirFromInvocation(invocation, homeDir)
    })
  } catch (error) {
    console.error(`TokenBoard sync failed: ${errorMessage(error)}`)
    return 1
  } finally {
    closeScheduledLogRuntime(logs)
  }
}

export function runSyncInvocation({
  flags = {},
  invocation,
  logs,
  stateDir,
  runWithLock = runWithSyncLock,
  runRetry = runScheduledRetry
}) {
  const run = (runFlags = flags) =>
    runWithLock({
      flags: runFlags,
      stateDir,
      run: () => runSync({ flags: runFlags, invocation, logs })
    })

  try {
    return run()
  } catch (error) {
    if (!shouldDeferScheduledSync(flags, error)) throw error
    const retryFlags = { ...flags, 'skip-upgrade': true }
    const result = runRetry({
      stateDir,
      source: invocation.source,
      runAttempt: () => run(retryFlags)
    })
    if (result.skipped) {
      console.error('TokenBoard scheduled sync deferred because another scheduled retry is active.')
    } else if (result.exhausted) {
      console.error(`TokenBoard scheduled sync retry exhausted after ${result.attempts} lock-timeout attempts.`)
    }
    return result.exitCode
  }
}

function runSync({ flags, invocation, logs }) {
  if (shouldRunUpgrade({ flags, env: process.env })) {
    try {
      runUpgrade({
        flags,
        automatic: true,
        log: (line) => {
          if (!logs) console.log(line)
        }
      })
    } catch (error) {
      console.error(`TokenBoard upgrade skipped: ${errorMessage(error)}`)
    }
  }

  const effectiveInvocation = refreshBundledCcusageConfig(invocation)

  if (!existsSync(effectiveInvocation.repoDir)) {
    console.error(`TokenBoard collector is not installed: ${effectiveInvocation.repoDir}`)
    console.error('Run setup.mjs again or run install-collector.mjs.')
    return 1
  }

  const result = spawnSync(effectiveInvocation.command, effectiveInvocation.args, {
    cwd: effectiveInvocation.cwd,
    env: effectiveInvocation.env,
    stdio: logs ? ['ignore', logs.stdoutFd, logs.stderrFd] : 'inherit',
    shell: effectiveInvocation.shell
  })

  if (result.error) {
    console.error(`Failed to run ${effectiveInvocation.command}: ${errorMessage(result.error)}`)
    return 1
  }

  return result.status ?? 1
}

export function refreshBundledCcusageConfig(invocation, fileExists = existsSync) {
  if (invocation.env?.TOKENBOARD_CCUSAGE_CONFIG?.trim()) return invocation

  const bundledCcusageConfig = join(invocation.repoDir, 'packages', 'collector', 'ccusage.json')
  if (!fileExists(bundledCcusageConfig)) return invocation

  return {
    ...invocation,
    env: {
      ...invocation.env,
      TOKENBOARD_CCUSAGE_CONFIG: bundledCcusageConfig
    }
  }
}

export function shouldRunUpgrade({ flags = {}, env = process.env } = {}) {
  if (flags.hook === true) {
    return false
  }
  if (flags['skip-upgrade'] === true) {
    return false
  }
  if (env.TOKENBOARD_SKIP_UPGRADE === '1') {
    return false
  }
  if (env.TOKENBOARD_AUTO_UPGRADE === '0') {
    return false
  }
  return true
}

export function buildSyncInvocation({
  flags = {},
  config,
  env = process.env,
  pathEnv = env.PATH || '/usr/local/bin:/usr/bin:/bin',
  homeDir = homedir(),
  nodePath = process.execPath,
  platform = process.platform,
  fileExists = existsSync
}) {
  const mode = flags.mode || 'sync'
  const source = flags.source || config.source || 'all'
  const repoDir = config.collectorDir || collectorDir()
  const packageManager = readPackageManager(flags, config)
  const since = readSince({ flags, config, env })
  const delimiter = platform === 'win32' ? ';' : ':'
  const {
    TOKENBOARD_COORDINATOR_LOCK_HELD: _coordinatorLockHeld,
    TOKENBOARD_COORDINATOR_LOCK_TOKEN: _coordinatorLockToken,
    ...collectorEnv
  } = env
  const bundledCcusageConfig = join(repoDir, 'packages', 'collector', 'ccusage.json')
  const ccusageConfig = collectorEnv.TOKENBOARD_CCUSAGE_CONFIG?.trim()
    ? undefined
    : fileExists(bundledCcusageConfig)
      ? bundledCcusageConfig
      : undefined
  const until = normalizeUntilFlag(flags.until)
  const codexSymlinkRoots =
    Array.isArray(config.codexSymlinkRoots) && config.codexSymlinkRoots.length > 0
      ? Object.prototype.hasOwnProperty.call(collectorEnv, 'TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON')
        ? undefined
        : JSON.stringify(config.codexSymlinkRoots)
      : undefined
  const untilArgs = until === undefined ? [] : ['--until', until]
  return {
    command: nodePath,
    args: ['--import', 'tsx', 'src/cli.ts', mode, '--source', source, ...untilArgs],
    source,
    cwd: join(repoDir, 'packages', 'collector'),
    repoDir,
    shell: false,
    env: {
      ...collectorEnv,
      PATH: normalizePathEnv({
        pathEnv,
        homeDir,
        nodePath,
        delimiter
      }),
      TOKENBOARD_ENDPOINT: config.endpoint,
      TOKENBOARD_UPLOAD_TOKEN: config.uploadToken,
      TOKENBOARD_TIMEZONE: config.timezone,
      TOKENBOARD_SOURCE: source,
      TOKENBOARD_PACKAGE_MANAGER: packageManager,
      ...(ccusageConfig ? { TOKENBOARD_CCUSAGE_CONFIG: ccusageConfig } : {}),
      ...(codexSymlinkRoots ? { TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON: codexSymlinkRoots } : {}),
      ...(until !== undefined ? { TOKENBOARD_UNTIL: until } : {}),
      TOKENBOARD_SINCE: since,
      TOKENBOARD_DEFAULT_SINCE: since,
      ...(flags.scheduled === true &&
      !Object.prototype.hasOwnProperty.call(collectorEnv, 'TOKENBOARD_FAIL_ON_SOURCE_ERROR')
        ? {
            TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
          }
        : {}),
      ...(flags.hook === true
        ? {
            TOKENBOARD_HOOK_MODE: '1',
            TOKENBOARD_STATE_DIR: env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR || join(homeDir, '.tokenboard')
          }
        : {})
    }
  }
}

function normalizeUntilFlag(value) {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') throw new Error('--until requires a date value')
  const normalized = String(value).trim()
  if (!normalized) throw new Error('--until requires a date value')
  return normalized
}

export function runWithSyncLock({ flags = {}, env = process.env, stateDir, runtime = syncLockRuntime(), run }) {
  if (typeof run !== 'function') {
    throw new Error('runWithSyncLock requires run')
  }
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    throw new Error('runWithSyncLock requires stateDir')
  }
  ensurePrivateStateDir(runtime, stateDir)
  const lockPath = join(stateDir, 'sync.lock')
  if (isCoordinatorLockHeld({ flags, env, lockPath, runtime })) {
    return run()
  }

  let owner = acquireLock(lockPath, runtime)
  if (!owner) {
    const wait = waitForLock(lockPath, runtime)
    if (!wait.acquired) {
      throw syncLockTimeoutError(lockPath)
    }
    owner = wait.owner
  }
  let result
  let primaryError
  let primaryFailed = false
  try {
    result = run()
  } catch (error) {
    primaryFailed = true
    primaryError = error
  }

  let releaseError
  try {
    const released = releaseLock(lockPath, runtime, owner)
    if (!released && lockHasToken(lockPath, owner.token, runtime)) {
      releaseError = new Error(`TokenBoard sync lock release was not confirmed: ${lockPath}`)
    }
  } catch (error) {
    releaseError = new Error(`TokenBoard sync lock release failed: ${errorMessage(error)}`, { cause: error })
  }

  if (primaryFailed && releaseError) {
    const combined = new AggregateError(
      [primaryError, releaseError],
      `${errorMessage(primaryError)}; ${errorMessage(releaseError)}`
    )
    if (primaryError && typeof primaryError === 'object' && 'code' in primaryError) {
      combined.code = primaryError.code
    }
    throw combined
  }
  if (primaryFailed) throw primaryError
  if (releaseError) throw releaseError
  return result
}

function shouldDeferScheduledSync(flags, error) {
  return (
    flags.scheduled === true &&
    flags.hook !== true &&
    (flags.mode || 'sync') === 'sync' &&
    error?.code === 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
  )
}

function syncLockTimeoutError(lockPath) {
  const error = new Error(`Timed out waiting for TokenBoard sync lock: ${lockPath}`)
  error.code = 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
  return error
}

function ensurePrivateStateDir(runtime, stateDir) {
  if (typeof runtime.mkdir !== 'function' || typeof runtime.chmod !== 'function') {
    throw new Error('TokenBoard sync state directory setup requires mkdir and chmod operations')
  }
  const inspect = typeof runtime.lstat === 'function' ? () => runtime.lstat(stateDir) : null
  const before = inspectDirectory(inspect)
  if (before?.isSymbolicLink?.()) {
    throw new Error(`TokenBoard sync state directory must not be a symbolic link: ${stateDir}`)
  }

  runtime.mkdir(stateDir, { recursive: true, mode: 0o700 })

  const after = inspectDirectory(inspect)
  if (after?.isSymbolicLink?.()) {
    throw new Error(`TokenBoard sync state directory must not be a symbolic link: ${stateDir}`)
  }
  if (after && typeof after.isDirectory === 'function' && !after.isDirectory()) {
    throw new Error(`TokenBoard sync state path is not a directory: ${stateDir}`)
  }
  runtime.chmod(stateDir, 0o700)
}

function inspectDirectory(inspect) {
  if (!inspect) return null
  try {
    return inspect()
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function isCoordinatorLockHeld({ flags, env, lockPath, runtime }) {
  return (
    flags.hook === true &&
    env.TOKENBOARD_COORDINATOR_LOCK_HELD === '1' &&
    lockHasToken(lockPath, env.TOKENBOARD_COORDINATOR_LOCK_TOKEN, runtime)
  )
}

function configDirFromInvocation(invocation, homeDir) {
  return invocation.env.TOKENBOARD_STATE_DIR || invocation.env.TOKENBOARD_CONFIG_DIR || join(homeDir, '.tokenboard')
}

function syncLockRuntime() {
  let processStartIdentity
  return {
    lockTimeoutMs: defaultSyncLockTimeoutMs,
    chmod: (path, mode) => chmodSync(path, mode),
    lstat: (path) => lstatSync(path),
    mkdir: (path, options) => mkdirSync(path, options),
    now: Date.now,
    process,
    getProcessStartIdentity: () => {
      if (processStartIdentity) return processStartIdentity
      processStartIdentity = currentProcessStartIdentity()
      return processStartIdentity
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    rename: renameSync,
    link: linkSync,
    sleep: sleepSync,
    unlink: unlinkSync,
    writeFile: writeFileSync
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}
