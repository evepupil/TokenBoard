import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { acquireLock, releaseLock, waitForLock } from './coordinator-lock.mjs'
import { acknowledgeSignalSource, appendSignal, drainSignalSources, readSignalSources } from './coordinator-signal.mjs'
import { errorMessage } from './error-message.mjs'
import { currentProcessStartIdentity } from './process-liveness.mjs'

const defaultLockTimeoutMs = 60_000
const defaultLockTimeoutRetryDelayMs = 60_000
const defaultMaxFollowUps = 0
const defaultMaxRunLogs = 1_024

class SuccessfulSyncCheckpointError extends Error {
  constructor(cause, completedResult) {
    super(errorMessage(cause))
    this.name = 'SuccessfulSyncCheckpointError'
    this.cause = cause
    this.completedResult = completedResult
  }

  withCleanupFailure(cleanupError) {
    const combined = new AggregateError(
      [this.cause, cleanupError],
      `${this.message}; sync lock release failed: ${errorMessage(cleanupError)}`
    )
    return new SuccessfulSyncCheckpointError(combined, this.completedResult)
  }
}

class CompletedSyncPostProcessError extends Error {
  constructor(cause, completedResult) {
    super(errorMessage(cause))
    this.name = 'CompletedSyncPostProcessError'
    this.cause = cause
    this.completedResult = completedResult
  }

  withCleanupFailure(cleanupError) {
    return new CompletedSyncPostProcessError(
      new AggregateError(
        [this.cause, cleanupError],
        `${this.message}; sync lock release failed: ${errorMessage(cleanupError)}`
      ),
      this.completedResult
    )
  }
}

class CompletedSyncCleanupError extends CompletedSyncPostProcessError {
  constructor(cause, completedResult) {
    super(cause, completedResult)
    this.name = 'CompletedSyncCleanupError'
  }
}

export function coordinatedSync(trigger, options) {
  const runtime = buildRuntime(options)
  const startedAtMs = runtime.now()
  const result = baseResult(trigger, startedAtMs)
  runtime.mkdir(runtime.stateDir, { recursive: true })

  let completed
  let checkpointError
  let hasCheckpointError = false
  try {
    completed = runCoordinator(trigger, runtime, result)
  } catch (error) {
    const failedResult =
      error instanceof SuccessfulSyncCheckpointError || error instanceof CompletedSyncPostProcessError
        ? error.completedResult
        : result
    completed = { ...failedResult, error: errorMessage(error) }
    if (error instanceof SuccessfulSyncCheckpointError) {
      hasCheckpointError = true
      checkpointError = error.cause instanceof Error ? error.cause : error
    }
  }
  writeRunLog(completed, startedAtMs, runtime)
  if (hasCheckpointError) throw checkpointError
  return completed
}

function runCoordinator(trigger, runtime, result) {
  const lockPath = join(runtime.stateDir, 'sync.lock')
  const lock = acquireCoordinatorLock(lockPath, trigger, runtime, result)
  if (lock.result) {
    if (lock.acquired) releaseLock(lockPath, runtime, lock.owner)
    return lock.result
  }

  let coordinatorError
  let completedResult
  try {
    const pendingSources = readSignalSources(runtime)
    if (lock.waited && pendingSources.length === 0) {
      return { ...result, waitedForLock: true, skippedSync: true }
    }
    let syncSources = mergeSources(pendingSources, [trigger.source])
    const remainingMs = cooldownRemainingMs(runtime)
    if (remainingMs > 0) {
      return skipForCooldown({ trigger, runtime, result, pendingSources, syncSources, remainingMs, lock })
    }

    const completed = {
      ...result,
      ...runLockedCycles(trigger, runtime, syncSources, lock.owner.token),
      waitedForLock: lock.waited
    }
    completedResult = completed
    writeSuccessfulSyncCheckpoint(completed, runtime)
    return scheduleDeferredFollowUps(trigger, runtime, completed)
  } catch (error) {
    coordinatorError =
      completedResult && !(error instanceof SuccessfulSyncCheckpointError)
        ? new CompletedSyncPostProcessError(error, completedResult)
        : error
    throw coordinatorError
  } finally {
    if (lock.acquired) {
      try {
        releaseLock(lockPath, runtime, lock.owner)
      } catch (error) {
        if (coordinatorError instanceof SuccessfulSyncCheckpointError) {
          throw coordinatorError.withCleanupFailure(error)
        }
        if (coordinatorError instanceof CompletedSyncPostProcessError) {
          throw coordinatorError.withCleanupFailure(error)
        }
        if (completedResult) throw new CompletedSyncCleanupError(error, completedResult)
        throw error
      }
    }
  }
}

function acquireCoordinatorLock(lockPath, trigger, runtime, result) {
  const owner = acquireLock(lockPath, runtime)
  if (owner) {
    return { acquired: true, owner, waited: false, result: null }
  }

  appendSignal(runtime, trigger)
  const wait = waitForLock(lockPath, runtime)
  if (!wait.acquired) {
    const trailingSources = [trigger.source]
    const trailingDelayMs = lockTimeoutRetryDelayMs(runtime)
    const trailingScheduled = scheduleTrailingSources(trigger, trailingSources, runtime, trailingDelayMs)
    return {
      acquired: false,
      waited: true,
      result: {
        ...result,
        waitedForLock: true,
        skippedSync: true,
        skippedReason: 'lock-timeout',
        error: wait.error || 'lock timeout',
        trailingScheduled,
        ...(trailingScheduled ? { trailingDelayMs } : {}),
        trailingSources
      }
    }
  }

  return {
    acquired: true,
    owner: wait.owner,
    waited: true,
    result: null
  }
}

function skipForCooldown({ trigger, runtime, result, pendingSources, syncSources, remainingMs, lock }) {
  if (pendingSources.length === 0 && runtime.trailingProcess) {
    return cooldownResult({ result, lock, remainingMs, trailingScheduled: false, trailingSources: [] })
  }
  const trailingSources = keepCooldownTrigger(trigger, runtime, pendingSources, syncSources)
  return cooldownResult({
    result,
    lock,
    remainingMs,
    trailingScheduled: scheduleTrailingSources(trigger, trailingSources, runtime, remainingMs),
    trailingSources
  })
}

function keepCooldownTrigger(trigger, runtime, pendingSources, syncSources) {
  if (pendingSources.length === 0) {
    appendSignal(runtime, trigger)
    return syncSources
  }
  if (!pendingSources.includes(trigger.source)) {
    appendSignal(runtime, trigger)
    return mergeSources(syncSources, [trigger.source])
  }
  return syncSources
}

function cooldownResult({ result, lock, remainingMs, trailingScheduled, trailingSources }) {
  return {
    ...result,
    waitedForLock: lock.waited,
    skippedSync: true,
    skippedReason: 'cooldown',
    cooldownRemainingMs: remainingMs,
    trailingScheduled,
    ...(trailingScheduled ? { trailingDelayMs: remainingMs } : {}),
    trailingSources
  }
}

function runLockedCycles(trigger, runtime, initialSources, lockToken) {
  const cycles = []
  let followUpCount = 0
  let hadFollowUp = false
  let error
  let deferredSources = []
  const failedSources = new Set()
  let sources = initialSources.length > 0 ? initialSources : [trigger.source]

  while (true) {
    sources = mergeSources(sources, drainSignalSources(runtime))
    for (const source of sources) {
      const sourceTrigger = { ...trigger, source }
      try {
        const syncResult = runtime.executeSync(sourceTrigger, lockToken)
        acknowledgeSignalSource(runtime, source)
        cycles.push({
          source,
          result: syncResult
        })
        failedSources.delete(source)
      } catch (cause) {
        error ||= errorMessage(cause)
        failedSources.add(source)
        cycles.push({ source, error: errorMessage(cause) })
      }
    }

    try {
      sources = readSignalSources(runtime)
    } catch (cause) {
      restoreFailedSources(trigger, runtime, failedSources)
      throw cause
    }
    if (sources.length === 0) break
    if (followUpCount >= runtime.maxFollowUps) {
      deferredSources = sources
      break
    }
    hadFollowUp = true
    followUpCount += 1
  }

  restoreFailedSources(trigger, runtime, failedSources)

  return {
    hadFollowUp,
    followUpCount,
    skippedSync: false,
    cycles,
    ...(deferredSources.length > 0 ? { deferredSources } : {}),
    ...(error ? { error } : {})
  }
}

function restoreFailedSources(trigger, runtime, failedSources) {
  for (const source of failedSources) {
    appendSignal(runtime, { ...trigger, source })
  }
}

function mergeSources(left, right) {
  const merged = []
  const seen = new Set()
  for (const source of [...left, ...right]) {
    if (seen.has(source)) continue
    merged.push(source)
    seen.add(source)
  }
  return merged
}

function buildRuntime(options = {}) {
  if (typeof options.executeSync !== 'function') {
    throw new Error('coordinatedSync requires executeSync')
  }
  const processValue = options.process || process
  const platform = options.platform || process.platform
  const nodeVersion = options.nodeVersion || process.versions.node
  const readProcessStartIdentity = options.readProcessStartIdentity
  const runProcessIdentity = options.runProcessIdentity
  const configuredProcessStartIdentity =
    typeof options.processStartIdentity === 'string' && options.processStartIdentity
      ? options.processStartIdentity
      : undefined
  let processStartIdentity
  const getProcessStartIdentity = () => {
    if (processStartIdentity) return processStartIdentity
    processStartIdentity =
      configuredProcessStartIdentity ||
      (processValue === process || readProcessStartIdentity || runProcessIdentity
        ? currentProcessStartIdentity({
            pid: processValue.pid,
            platform,
            nodeVersion,
            readFile: options.readFile,
            readProcessStartIdentity,
            runProcessIdentity,
            ...(processValue === process
              ? {}
              : {
                  kill: processValue.kill?.bind(processValue)
                })
          })
        : undefined)
    return processStartIdentity
  }
  const hasCustomFileOps = Boolean(
    options.readFile || options.writeFile || options.unlink || options.exists || options.rename || options.link
  )
  return {
    stateDir: readStateDir(options),
    executeSync: options.executeSync,
    cooldownMs: numberOrDefault(options.cooldownMs, 300_000),
    lockTimeoutMs: numberOrDefault(options.lockTimeoutMs, defaultLockTimeoutMs),
    maxFollowUps: numberOrDefault(options.maxFollowUps, defaultMaxFollowUps),
    maxRunLogs: positiveIntegerOrDefault(options.maxRunLogs, defaultMaxRunLogs),
    trailingProcess: options.trailingProcess === true,
    version: options.version || 'unknown',
    now: options.now || Date.now,
    nodeVersion,
    platform,
    runTasklist: options.runTasklist,
    sleep: options.sleep || sleepSync,
    process: processValue,
    processStartIdentity: configuredProcessStartIdentity,
    getProcessStartIdentity,
    readProcessStartIdentity,
    runProcessIdentity,
    scheduleTrailing: options.scheduleTrailing || (() => false),
    mkdir: options.mkdir || mkdirSync,
    readFile: options.readFile || ((path) => readFileSync(path, 'utf8')),
    writeFile: options.writeFile || writeFileSync,
    readdir: options.readdir || (hasCustomFileOps ? undefined : readdirSync),
    listRunLogs: options.listRunLogs || (hasCustomFileOps ? undefined : readdirSync),
    rename: options.rename || (hasCustomFileOps ? undefined : renameSync),
    link: options.link || (hasCustomFileOps ? undefined : linkSync),
    unlink: options.unlink || unlinkSync,
    exists: options.exists || existsSync
  }
}

function readStateDir(options) {
  if (typeof options.stateDir === 'string' && options.stateDir.trim()) {
    return options.stateDir
  }
  throw new Error('coordinatedSync stateDir is required')
}

function baseResult(trigger, startedAtMs) {
  return {
    runId: `${safeRunIdPart(new Date(startedAtMs).toISOString())}-${Math.random().toString(36).slice(2, 8)}`,
    triggers: [trigger],
    hadFollowUp: false,
    followUpCount: 0,
    waitedForLock: false,
    skippedSync: false,
    cycles: []
  }
}

function safeRunIdPart(value) {
  return value.replace(/[<>:"\\|?*]/g, '-')
}

function readTimestamp(path, runtime) {
  const raw = runtime.readFile(path).trim()
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed : ''
  } catch {
    return raw
  }
}

function cooldownRemainingMs(runtime) {
  if (runtime.cooldownMs <= 0) return 0
  const path = join(runtime.stateDir, 'last-success.json')
  if (!runtime.exists(path)) return 0
  const timestamp = new Date(readTimestamp(path, runtime)).getTime()
  if (Number.isNaN(timestamp)) return 0
  return Math.max(0, runtime.cooldownMs - (runtime.now() - timestamp))
}

function scheduleTrailingSources(trigger, sources, runtime, remainingMs) {
  return sources.reduce(
    (scheduled, source) => runtime.scheduleTrailing({ ...trigger, source }, remainingMs) || scheduled,
    false
  )
}

function lockTimeoutRetryDelayMs(runtime) {
  return defaultLockTimeoutRetryDelayMs
}

function scheduleDeferredFollowUps(trigger, runtime, result) {
  if (deriveStatus(result) !== 'success' || !result.deferredSources?.length) return result
  const remainingMs = cooldownRemainingMs(runtime)
  const trailingScheduled = scheduleTrailingSources(trigger, result.deferredSources, runtime, remainingMs)
  return {
    ...result,
    trailingScheduled,
    ...(trailingScheduled ? { trailingDelayMs: remainingMs } : {}),
    trailingSources: result.deferredSources
  }
}

function writeSuccessfulSyncCheckpoint(result, runtime) {
  if (deriveStatus(result) !== 'success') return
  try {
    runtime.writeFile(join(runtime.stateDir, 'last-success.json'), new Date(runtime.now()).toISOString())
  } catch (error) {
    throw new SuccessfulSyncCheckpointError(error, result)
  }
}

function writeRunLog(result, startedAtMs, runtime) {
  const lockPath = join(runtime.stateDir, 'run-logs.lock')
  const owner = acquireRunLogLock(lockPath, runtime)
  try {
    writeRunLogEntry(result, startedAtMs, runtime)
  } finally {
    releaseLock(lockPath, runtime, owner)
  }
}

function acquireRunLogLock(lockPath, runtime) {
  const owner = acquireLock(lockPath, runtime)
  if (owner) return owner
  const wait = waitForLock(lockPath, runtime)
  if (!wait.acquired) {
    throw new Error(`run log ${wait.error || 'lock timeout'}`)
  }
  return wait.owner
}

function writeRunLogEntry(result, startedAtMs, runtime) {
  const completedAtMs = runtime.now()
  const status = deriveStatus(result)
  const entry = {
    runId: result.runId,
    version: runtime.version,
    triggers: result.triggers,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs - startedAtMs,
    coordination: {
      waitedForLock: result.waitedForLock,
      skippedSync: result.skippedSync,
      ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
      ...(result.cooldownRemainingMs != null ? { cooldownRemainingMs: result.cooldownRemainingMs } : {}),
      ...(result.trailingScheduled != null ? { trailingScheduled: result.trailingScheduled } : {}),
      ...(result.trailingDelayMs != null ? { trailingDelayMs: result.trailingDelayMs } : {}),
      ...(result.trailingSources ? { trailingSources: result.trailingSources } : {}),
      ...(result.deferredSources ? { deferredSources: result.deferredSources } : {}),
      hadFollowUp: result.hadFollowUp,
      followUpCount: result.followUpCount
    },
    cycles: result.cycles,
    status,
    ...(result.error ? { error: result.error } : {})
  }
  const runsDir = prepareRunLogDirectory(result.runId, runtime)
  const json = `${JSON.stringify(entry, null, 2)}\n`
  runtime.writeFile(join(runsDir, `${result.runId}.json`), json)
  pruneRunLogs(runsDir, runtime)
  runtime.writeFile(join(runtime.stateDir, 'last-run.json'), json)
}

function prepareRunLogDirectory(runId, runtime) {
  const runsDir = join(runtime.stateDir, 'runs')
  const markerPath = join(runsDir, '.bounded-v1')
  if (runtime.rename && runtime.exists(runsDir) && !runtime.exists(markerPath)) {
    try {
      runtime.rename(runsDir, join(runtime.stateDir, `runs.unbounded-${runId}`))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  runtime.mkdir(runsDir, { recursive: true })
  if (!runtime.exists(markerPath)) {
    runtime.writeFile(markerPath, 'TokenBoard bounded run logs v1\n')
  }
  return runsDir
}

function pruneRunLogs(runsDir, runtime) {
  if (!runtime.listRunLogs) return
  const names = runtime.listRunLogs(runsDir).filter((name) => name.endsWith('.json'))
  if (names.length <= runtime.maxRunLogs) return
  names.sort((left, right) => right.localeCompare(left))
  for (const name of names.slice(runtime.maxRunLogs)) {
    try {
      runtime.unlink(join(runsDir, name))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

function deriveStatus(result) {
  if (result.error) return 'error'
  if (result.skippedSync) return 'skipped'
  const hasCycleError = result.cycles.some((cycle) => cycle && cycle.error)
  return hasCycleError ? 'error' : 'success'
}

function numberOrDefault(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positiveIntegerOrDefault(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function sleepSync(ms) {
  const timeout = Math.max(0, ms)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout)
}
