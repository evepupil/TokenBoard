import { randomBytes } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { acquireLock, lockHasToken, releaseLock } from './coordinator-lock.mjs'
import { errorMessage } from './error-message.mjs'
import { currentProcessStartIdentity } from './process-liveness.mjs'
import {
  acquireLegacyRetryFence,
  prepareLegacyRetryFenceForAll,
  releaseLegacyRetryFence
} from './scheduled-retry-legacy-fence.mjs'
import { usageSources } from './usage-sources.mjs'

export const scheduledRetryStateFileName = 'scheduled-sync-retry.json'
export const scheduledRetryLockFileName = 'scheduled-sync-retry.lock'
export const defaultScheduledRetryMaxAttempts = 5
export const defaultScheduledRetryDelayMs = 60_000
// Mirrors `transientSyncExitCode` in packages/collector/src/cli.ts: the collector
// reports a transient upload failure with this code instead of a plain failure,
// because its snapshots stay pending in the cursor and a later run can send
// them. This is the single definition the skill scripts share; a cross-language
// constant cannot be imported from the TypeScript package, so the collector test
// suite asserts both sides still agree.
export const transientSyncExitCode = 75
// An all-source retry has to hold every per-source retry lock, or a concurrent
// single-source retry could collect at the same time as the all-source pass and
// double-count the same snapshots. Deriving the list from the closed source set
// is what keeps it complete: a hand-written copy went stale once already, and
// the failure is silent — the new sources simply kept the mutual exclusion the
// collector needs but not the retry layer.
const scheduledRetryGuardSources = usageSources
const scheduledRetryTransitionLockFileName = 'scheduled-sync-retry.transition.lock'

export async function runScheduledRetry(options = {}) {
  if (typeof options.runAttempt !== 'function') {
    throw new Error('runScheduledRetry requires runAttempt')
  }

  const runtime = retryRuntime(options)
  const source = readRequiredString(options.source, 'TokenBoard scheduled retry source is required')
  const maxAttempts = readMaxAttempts(options.maxAttempts)
  const delayMs = readDelayMs(options.delayMs)
  const lockPath = scheduledRetryLockPath(runtime.stateDir, source)
  runtime.mkdir(runtime.stateDir, { recursive: true })
  const prepared = prepareRetryLocks({ source, runtime, lockPath })
  if (prepared.skipped) {
    return { exitCode: 0, skipped: true, skippedReason: prepared.skippedReason, attempts: 0 }
  }
  const { owner, legacyOwner, guardOwners } = prepared

  const progress = { retryAttempt: 0 }
  let result
  let primaryError
  try {
    result = await executeScheduledRetry({
      source,
      maxAttempts,
      delayMs,
      runAttempt: options.runAttempt,
      runtime,
      progress
    })
  } catch (error) {
    primaryError = error
  }

  let cleanupError
  try {
    releaseRetryLock(lockPath, runtime, owner)
  } catch (error) {
    cleanupError = recordRetryLockReleaseFailure({
      source,
      maxAttempts,
      retryAttempt: progress.retryAttempt,
      runtime,
      error
    })
  }
  try {
    releaseLegacyRetryFence({
      runtime,
      lockPath: scheduledRetryLegacyLockPath(runtime.stateDir),
      transitionPath: scheduledRetryTransitionLockPath(runtime.stateDir),
      owner: legacyOwner
    })
  } catch (error) {
    const legacyCleanupError = recordRetryLockReleaseFailure({
      source,
      maxAttempts,
      retryAttempt: progress.retryAttempt,
      runtime,
      error
    })
    cleanupError = cleanupError
      ? new AggregateError(
          [cleanupError, legacyCleanupError],
          `${errorMessage(cleanupError)}; ${errorMessage(legacyCleanupError)}`
        )
      : legacyCleanupError
  }
  try {
    releaseRetryGuardLocks({ runtime, guardOwners, primaryPath: lockPath })
  } catch (error) {
    const guardCleanupError = recordRetryLockReleaseFailure({
      source,
      maxAttempts,
      retryAttempt: progress.retryAttempt,
      runtime,
      error
    })
    cleanupError = cleanupError
      ? new AggregateError(
          [cleanupError, guardCleanupError],
          `${errorMessage(cleanupError)}; ${errorMessage(guardCleanupError)}`
        )
      : guardCleanupError
  }

  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `${errorMessage(primaryError)}; ${errorMessage(cleanupError)}`
    )
  }
  if (cleanupError) throw cleanupError
  if (primaryError) throw primaryError
  return result
}

async function executeScheduledRetry({ source, maxAttempts, delayMs, runAttempt, runtime, progress }) {
  writeRetryState(
    retryState({
      source,
      status: 'deferred',
      retryAttempt: 0,
      maxAttempts,
      now: runtime.now(),
      nextRetryAt: new Date(runtime.now()).toISOString()
    }),
    runtime
  )

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    progress.retryAttempt = attempt
    writeRetryState(
      retryState({
        source,
        status: 'retrying',
        retryAttempt: attempt,
        maxAttempts,
        now: runtime.now()
      }),
      runtime
    )

    try {
      const exitCode = readExitCode(await runAttempt({ attempt }))
      if (exitCode !== transientSyncExitCode) {
        writeRetryState(
          retryState({
            source,
            status: exitCode === 0 ? 'completed' : 'failed',
            retryAttempt: attempt,
            maxAttempts,
            now: runtime.now(),
            ...(exitCode === 0 ? {} : { error: `sync exited with code ${exitCode}` })
          }),
          runtime
        )
        return { exitCode, skipped: false, attempts: attempt }
      }
      if (attempt === maxAttempts) {
        writeRetryState(
          retryState({
            source,
            status: 'exhausted',
            retryAttempt: attempt,
            maxAttempts,
            now: runtime.now(),
            error: `sync exited with transient code ${exitCode}`
          }),
          runtime
        )
        return { exitCode: 1, skipped: false, attempts: attempt, exhausted: true }
      }
      const retryAt = runtime.now()
      writeRetryState(
        retryState({
          source,
          status: 'deferred',
          retryAttempt: attempt,
          maxAttempts,
          now: retryAt,
          nextRetryAt: new Date(retryAt + delayMs).toISOString(),
          error: `sync exited with transient code ${exitCode}`
        }),
        runtime
      )
      // A failing sleep is not a lock timeout, so the catch below records it as a plain
      // failure with the same shape this block used to write. Handling it here as well
      // wrote the same state twice and, when the second write also failed, replaced the
      // sleep error with the state-write error — losing the cause the operator needs.
      runtime.sleep(delayMs)
    } catch (error) {
      if (!isSyncLockTimeout(error)) {
        writeRetryState(
          retryState({
            source,
            status: 'failed',
            retryAttempt: attempt,
            maxAttempts,
            now: runtime.now(),
            error: errorMessage(error)
          }),
          runtime
        )
        throw error
      }

      if (attempt === maxAttempts) {
        writeRetryState(
          retryState({
            source,
            status: 'exhausted',
            retryAttempt: attempt,
            maxAttempts,
            now: runtime.now(),
            error: errorMessage(error)
          }),
          runtime
        )
        return { exitCode: 1, skipped: false, attempts: attempt, exhausted: true }
      }

      const now = runtime.now()
      writeRetryState(
        retryState({
          source,
          status: 'deferred',
          retryAttempt: attempt,
          maxAttempts,
          now,
          nextRetryAt: new Date(now + delayMs).toISOString(),
          error: errorMessage(error)
        }),
        runtime
      )
      try {
        runtime.sleep(delayMs)
      } catch (sleepError) {
        writeRetryState(
          retryState({
            source,
            status: 'failed',
            retryAttempt: attempt,
            maxAttempts,
            now: runtime.now(),
            error: errorMessage(sleepError)
          }),
          runtime
        )
        throw sleepError
      }
    }
  }

  throw new Error('TokenBoard scheduled retry reached an unreachable state')
}

function releaseRetryLock(lockPath, runtime, owner) {
  const released = releaseLock(lockPath, runtime, owner)
  if (released || !lockHasToken(lockPath, owner.token, runtime)) return
  throw new Error('TokenBoard scheduled retry lock release was not confirmed')
}

function recordRetryLockReleaseFailure({ source, maxAttempts, retryAttempt, runtime, error }) {
  const releaseError = new Error(`TokenBoard scheduled retry lock release failed: ${errorMessage(error)}`, {
    cause: error
  })
  try {
    writeRetryState(
      retryState({
        source,
        status: 'failed',
        retryAttempt,
        maxAttempts,
        now: runtime.now(),
        error: errorMessage(releaseError)
      }),
      runtime
    )
    return releaseError
  } catch (stateError) {
    return new AggregateError(
      [releaseError, stateError],
      `${errorMessage(releaseError)}; retry state write failed: ${errorMessage(stateError)}`
    )
  }
}

export function scheduledRetryStatePath(stateDir, source = 'all') {
  return join(stateDir, scheduledRetryFileName(scheduledRetryStateFileName, source))
}

export function scheduledRetryLockPath(stateDir, source = 'all') {
  return join(stateDir, scheduledRetryFileName(scheduledRetryLockFileName, source))
}

export function scheduledRetryLegacyStatePath(stateDir) {
  return join(stateDir, scheduledRetryStateFileName)
}

export function scheduledRetryLegacyLockPath(stateDir) {
  return join(stateDir, scheduledRetryLockFileName)
}

export function scheduledRetryTransitionLockPath(stateDir) {
  return join(stateDir, scheduledRetryTransitionLockFileName)
}

function scheduledRetryFileName(fileName, source = 'all') {
  const sourceValue = readRequiredString(source, 'TokenBoard scheduled retry source is required')
  if (sourceValue === 'all') return fileName
  const extensionIndex = fileName.lastIndexOf('.')
  const stem = fileName.slice(0, extensionIndex)
  const extension = fileName.slice(extensionIndex)
  const sourceKey = Buffer.from(sourceValue, 'utf8').toString('hex')
  return `${stem}.${sourceKey}${extension}`
}

function prepareRetryLocks({ source, runtime, lockPath }) {
  const guardSources = source === 'all' ? scheduledRetryGuardSources : [source]
  const guardOwners = []
  let legacyOwner = null
  const transitionPath = scheduledRetryTransitionLockPath(runtime.stateDir)
  const transitionOwner = acquireLock(transitionPath, runtime)
  if (!transitionOwner) return { skipped: true, skippedReason: 'active-retry' }
  try {
    for (const guardSource of guardSources) {
      const guardPath = scheduledRetryLockPath(runtime.stateDir, guardSource)
      const guardOwner = acquireLock(guardPath, runtime)
      if (!guardOwner) {
        releasePreparedRetryLocks({ runtime, guardOwners, legacyOwner, transitionPath, transitionOwner })
        return { skipped: true, skippedReason: 'active-retry' }
      }
      guardOwners.push({ path: guardPath, owner: guardOwner })
    }

    if (source === 'all') {
      if (
        prepareLegacyRetryFenceForAll({
          runtime,
          lockPath: scheduledRetryLegacyLockPath(runtime.stateDir)
        })
      ) {
        releasePreparedRetryLocks({ runtime, guardOwners, legacyOwner, transitionPath, transitionOwner })
        return { skipped: true, skippedReason: 'active-legacy-retry' }
      }
      const owner = acquireLock(lockPath, runtime)
      if (!owner) {
        releasePreparedRetryLocks({ runtime, guardOwners, legacyOwner, transitionPath, transitionOwner })
        return { skipped: true, skippedReason: 'active-retry' }
      }
      guardOwners.push({ path: lockPath, owner })
      releaseRetryLock(transitionPath, runtime, transitionOwner)
      return { owner, legacyOwner, guardOwners }
    }

    legacyOwner = acquireLegacyRetryFence({
      runtime,
      lockPath: scheduledRetryLegacyLockPath(runtime.stateDir)
    })
    if (legacyOwner === false) {
      releasePreparedRetryLocks({ runtime, guardOwners, legacyOwner, transitionPath, transitionOwner })
      return { skipped: true, skippedReason: 'active-legacy-retry' }
    }
    releaseRetryLock(transitionPath, runtime, transitionOwner)
    return { owner: guardOwners[0].owner, legacyOwner, guardOwners }
  } catch (error) {
    try {
      releasePreparedRetryLocks({ runtime, guardOwners, legacyOwner, transitionPath, transitionOwner })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${errorMessage(error)}; retry lock cleanup failed: ${errorMessage(cleanupError)}`
      )
    }
    throw error
  }
}

function releasePreparedRetryLocks({ runtime, guardOwners, legacyOwner, transitionPath, transitionOwner }) {
  const errors = []
  if (legacyOwner && legacyOwner !== false) {
    try {
      releaseLegacyRetryFence({
        runtime,
        lockPath: scheduledRetryLegacyLockPath(runtime.stateDir),
        transitionPath,
        owner: legacyOwner,
        transitionOwner
      })
    } catch (error) {
      errors.push(error)
    }
  }
  for (const { path, owner } of [...guardOwners].reverse()) {
    try {
      releaseRetryLock(path, runtime, owner)
    } catch (error) {
      errors.push(error)
    }
  }
  if (transitionOwner) {
    try {
      releaseRetryLock(transitionPath, runtime, transitionOwner)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, errors.map(errorMessage).join('; '))
}

function releaseRetryGuardLocks({ runtime, guardOwners, primaryPath }) {
  const ownedGuards = guardOwners.filter(({ path }) => path !== primaryPath)
  if (ownedGuards.length === 0) return
  releasePreparedRetryLocks({ runtime, guardOwners: ownedGuards, legacyOwner: null })
}

function retryState({ source, status, retryAttempt, maxAttempts, now, nextRetryAt, error }) {
  return {
    schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
    source,
    status,
    retryAttempt,
    maxAttempts,
    updatedAt: new Date(now).toISOString(),
    ...(nextRetryAt ? { nextRetryAt } : {}),
    ...(error ? { error } : {})
  }
}

function writeRetryState(state, runtime) {
  runtime.mkdir(runtime.stateDir, { recursive: true })
  const statePath = scheduledRetryStatePath(runtime.stateDir, state.source)
  const tempPath = `${statePath}.tmp-${runtime.process.pid}-${runtime.now()}-${randomBytes(8).toString('hex')}`
  try {
    runtime.writeFile(tempPath, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 })
    runtime.rename(tempPath, statePath)
  } catch (error) {
    try {
      runtime.unlink(tempPath)
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw new AggregateError(
          [error, cleanupError],
          `TokenBoard scheduled retry state write failed: ${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`
        )
      }
    }
    throw error
  }
}

function isSyncLockTimeout(error) {
  return error && typeof error === 'object' && error.code === 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
}

function readExitCode(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`TokenBoard scheduled retry received invalid sync exit code: ${String(value)}`)
  }
  return value
}

function readMaxAttempts(value) {
  if (value === undefined) return defaultScheduledRetryMaxAttempts
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('TokenBoard scheduled retry maxAttempts must be a positive integer')
  }
  return value
}

function readDelayMs(value) {
  if (value === undefined) return defaultScheduledRetryDelayMs
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('TokenBoard scheduled retry delayMs must be a nonnegative integer')
  }
  return value
}

function readRequiredString(value, message) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(message)
  }
  return value
}

function retryRuntime(options) {
  const provided = options.runtime || {}
  const stateDir = readRequiredString(
    options.stateDir || provided.stateDir,
    'TokenBoard scheduled retry stateDir is required'
  )
  const processValue = options.process || provided.process || process
  const platform = options.platform || provided.platform || process.platform
  const nodeVersion = options.nodeVersion || provided.nodeVersion || process.versions.node
  const readProcessStartIdentity = options.readProcessStartIdentity || provided.readProcessStartIdentity
  const runProcessIdentity = options.runProcessIdentity || provided.runProcessIdentity
  return {
    stateDir,
    now: options.now || provided.now || Date.now,
    process: processValue,
    platform,
    nodeVersion,
    processStartIdentity:
      options.processStartIdentity ||
      provided.processStartIdentity ||
      currentProcessStartIdentity({
        pid: processValue.pid,
        platform,
        nodeVersion,
        readProcessStartIdentity,
        runProcessIdentity,
        kill: processValue.kill?.bind(processValue)
      }),
    readProcessStartIdentity,
    runProcessIdentity,
    runTasklist: options.runTasklist || provided.runTasklist,
    mkdir: options.mkdir || provided.mkdir || mkdirSync,
    readFile: options.readFile || provided.readFile || ((path) => readFileSync(path, 'utf8')),
    readdir: options.readdir || provided.readdir || readdirSync,
    writeFile: options.writeFile || provided.writeFile || writeFileSync,
    rename: options.rename || provided.rename || renameSync,
    link: options.link || provided.link || linkSync,
    rmdir: options.rmdir || provided.rmdir || rmdirSync,
    unlink: options.unlink || provided.unlink || unlinkSync,
    sleep: options.sleep || provided.sleep || sleepSync
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}
