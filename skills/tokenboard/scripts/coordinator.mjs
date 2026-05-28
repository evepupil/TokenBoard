import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock, releaseLock, waitForLock } from './coordinator-lock.mjs'
import { appendSignal, drainSignalSources, readSignalSources } from './coordinator-signal.mjs'

const defaultLockTimeoutMs = 60_000
const defaultMaxFollowUps = 3

export function coordinatedSync(trigger, options) {
  const runtime = buildRuntime(options)
  const startedAtMs = runtime.now()
  const result = baseResult(trigger, startedAtMs)
  runtime.mkdir(runtime.stateDir, { recursive: true })

  let completed
  try {
    completed = runCoordinator(trigger, runtime, result)
  } catch (error) {
    completed = { ...result, error: errorMessage(error) }
  }
  writeRunLog(completed, startedAtMs, runtime)
  return completed
}

function runCoordinator(trigger, runtime, result) {
  const lockPath = join(runtime.stateDir, 'sync.lock')
  const lock = acquireCoordinatorLock(lockPath, trigger, runtime, result)
  if (lock.result) {
    if (lock.acquired) releaseLock(lockPath, runtime)
    return lock.result
  }

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

    return { ...result, ...runLockedCycles(trigger, runtime, syncSources), waitedForLock: lock.waited }
  } finally {
    if (lock.acquired) releaseLock(lockPath, runtime)
  }
}

function acquireCoordinatorLock(lockPath, trigger, runtime, result) {
  if (acquireLock(lockPath, runtime)) {
    return { acquired: true, waited: false, result: null }
  }

  appendSignal(runtime, trigger)
  const wait = waitForLock(lockPath, runtime)
  if (!wait.acquired) {
    return {
      acquired: false,
      waited: true,
      result: { ...result, waitedForLock: true, skippedSync: true, error: wait.error || 'lock timeout' }
    }
  }

  return {
    acquired: true,
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
    trailingSources
  }
}

function runLockedCycles(trigger, runtime, initialSources) {
  const cycles = []
  let followUpCount = 0
  let hadFollowUp = false
  let error
  const failedSources = new Set()
  let sources = initialSources.length > 0 ? initialSources : [trigger.source]

  while (true) {
    sources = mergeSources(sources, drainSignalSources(runtime))
    for (const source of sources) {
      const sourceTrigger = { ...trigger, source }
      try {
        cycles.push({
          source,
          result: runtime.executeSync(sourceTrigger)
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
    if (followUpCount >= runtime.maxFollowUps) break
    hadFollowUp = true
    followUpCount += 1
  }

  restoreFailedSources(trigger, runtime, failedSources)

  return {
    hadFollowUp,
    followUpCount,
    skippedSync: false,
    cycles,
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
  const hasCustomFileOps = Boolean(options.readFile || options.writeFile || options.unlink || options.exists)
  return {
    stateDir: readStateDir(options),
    executeSync: options.executeSync,
    cooldownMs: numberOrDefault(options.cooldownMs, 300_000),
    lockTimeoutMs: numberOrDefault(options.lockTimeoutMs, defaultLockTimeoutMs),
    maxFollowUps: numberOrDefault(options.maxFollowUps, defaultMaxFollowUps),
    trailingProcess: options.trailingProcess === true,
    version: options.version || 'unknown',
    now: options.now || Date.now,
    sleep: options.sleep || sleepSync,
    process: options.process || process,
    scheduleTrailing: options.scheduleTrailing || (() => false),
    mkdir: options.mkdir || mkdirSync,
    readFile: options.readFile || ((path) => readFileSync(path, 'utf8')),
    writeFile: options.writeFile || writeFileSync,
    readdir: options.readdir || (hasCustomFileOps ? undefined : readdirSync),
    rename: options.rename || (hasCustomFileOps ? undefined : renameSync),
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
  return sources.reduce((scheduled, source) =>
    runtime.scheduleTrailing({ ...trigger, source }, remainingMs) || scheduled, false)
}

function writeRunLog(result, startedAtMs, runtime) {
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
      ...(result.trailingSources ? { trailingSources: result.trailingSources } : {}),
      hadFollowUp: result.hadFollowUp,
      followUpCount: result.followUpCount
    },
    cycles: result.cycles,
    status,
    ...(result.error ? { error: result.error } : {})
  }
  const runsDir = join(runtime.stateDir, 'runs')
  runtime.mkdir(runsDir, { recursive: true })
  const json = `${JSON.stringify(entry, null, 2)}\n`
  runtime.writeFile(join(runsDir, `${result.runId}.json`), json)
  runtime.writeFile(join(runtime.stateDir, 'last-run.json'), json)
  if (status === 'success') {
    runtime.writeFile(join(runtime.stateDir, 'last-success.json'), entry.completedAt)
  }
}

function deriveStatus(result) {
  if (result.error) return 'error'
  if (result.skippedSync) return 'skipped'
  const hasCycleError = result.cycles.some((cycle) => cycle && cycle.error)
  return hasCycleError ? 'error' : 'success'
}

function numberOrDefault(value, fallback) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }

function sleepSync(ms) {
  const timeout = Math.max(0, ms)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout)
}

function errorMessage(error) { return error instanceof Error ? error.message : String(error) }
