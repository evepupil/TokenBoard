import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { acquireLock, releaseLock, waitForLock } from './coordinator-lock.mjs'
import { acknowledgeSignalSource, appendSignal, drainSignalSources, readSignalSources } from './coordinator-signal.mjs'
import { errorMessage } from './error-message.mjs'
import { currentProcessStartIdentity, probeProcessStartIdentity } from './process-liveness.mjs'
import { isWithinScheduleWindow } from './schedule.mjs'

const defaultLockTimeoutMs = 60_000
const defaultLockTimeoutRetryDelayMs = 60_000
// A transient failure is retried out of process, and each retry is itself a hook-style run that
// can fail the same way. A collector lock held by a long scan (a full claude scan runs 20-68s on
// a large history) is released before the first retry lands, so one retry is the normal case;
// this cap is for the pathological one — a live process that keeps the lock for far longer — so
// the chain stops instead of pacing a failing sync every ~95s forever. The sources stay in the
// signal queue and the scheduled sync covers them.
const defaultMaxTransientRetries = 3
const defaultMaxFollowUps = 0
const defaultMaxRunLogs = 1_024

// The cooldown exists to stop a burst of triggers from turning into a burst of syncs.
// Its input is a checkpoint another process wrote, so it can be missing, truncated, or
// otherwise unreadable. Treating that as "no cooldown" silently disables debouncing
// exactly when the state directory is already suspect, and the run then syncs on every
// trigger. Every other unreadable-state path here (lock release, checkpoint write,
// state directory symlink) raises, so this one does too rather than degrading quietly.
class UnreadableCooldownCheckpointError extends Error {
  constructor(cause, path) {
    super(errorMessage(cause))
    this.name = 'UnreadableCooldownCheckpointError'
    this.cause = cause
    this.path = path
  }

  withCleanupFailure(cleanupError) {
    const combined = new AggregateError(
      [this.cause, cleanupError],
      `${this.message}; sync lock release failed: ${errorMessage(cleanupError)}`
    )
    return new UnreadableCooldownCheckpointError(combined, this.path)
  }
}

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
  // Private from the start. The mode is pinned rather than left to the umask: the hook path
  // runs from an interactive shell, where the umask is normally 022, and everything written
  // below here — the run logs, the sync checkpoint, the lock — belongs to this user alone.
  // (`sync.mjs` also chmods this directory, but only once a sync actually runs, which is too
  // late for a run that fails before reaching it.)
  ensurePrivateDirectory(runtime, runtime.stateDir)

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
    if (error instanceof SuccessfulSyncCheckpointError || error instanceof UnreadableCooldownCheckpointError) {
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
    // Checked after the cooldown because it is the same decision: a skipped
    // trigger has to leave its source queued, and that is what `keepCooldownTrigger`
    // already does. The scheduled run scans `config.source` — `all` by default — so it
    // collects the same usage the skipped hook would have; the queued signal is left
    // for the next hook run to acknowledge. Skipping here only avoids a second full
    // ccusage scan minutes before or after the scheduled one.
    if (isInsideScheduledWindow(runtime)) {
      keepCooldownTrigger(trigger, runtime, pendingSources, syncSources)
      return { ...result, waitedForLock: lock.waited, skippedSync: true, skippedReason: 'scheduled-window' }
    }
    // A scan costs 4.6-7.6 GB of resident memory. On a machine that is already out of memory
    // or swapping, it runs many times longer and can still fail on the way out (2026-11-24:
    // a 26.4-minute hook run died on a TLS handshake timeout under 37.9 GB compressed memory,
    // with the upload unacknowledged). The source is queued exactly like a cooldown skip and
    // the scheduled sync — which never passes through here — is the backstop. No trailing
    // retry is scheduled: under sustained pressure it would only re-probe and re-skip, and the
    // next real trigger re-evaluates anyway.
    const pressure = runtime.resourcePressure ? runtime.resourcePressure() : null
    if (pressure?.pressured) {
      keepCooldownTrigger(trigger, runtime, pendingSources, syncSources)
      return {
        ...result,
        waitedForLock: lock.waited,
        skippedSync: true,
        skippedReason: 'resource-pressure',
        resourcePressure: pressure.detail
      }
    }
    // The cooldown above is scoped to the last *success*. Without this check a failing upload
    // endpoint means every session-end trigger starts a fresh scan that fails again — on
    // 2026-11-24 one such run spent 26.4 minutes scanning and then timed out at upload, with
    // the cursor unacknowledged, and the next trigger would have repeated it. The source is
    // queued like every other skip. A run whose failures were all transient (a busy collector
    // lock) never writes this checkpoint, so the retry chain those schedule keeps its own
    // cadence; a mixed run does write it, and the transient retry waits with everything else
    // rather than re-scanning a source that just failed permanently.
    const failureRemainingMs = failureBackoffRemainingMs(runtime)
    if (failureRemainingMs > 0) {
      keepCooldownTrigger(trigger, runtime, pendingSources, syncSources)
      return {
        ...result,
        waitedForLock: lock.waited,
        skippedSync: true,
        skippedReason: 'failure-backoff',
        failureBackoffRemainingMs: failureRemainingMs
      }
    }

    const completed = {
      ...result,
      ...runLockedCycles(trigger, runtime, syncSources, lock.owner.token),
      waitedForLock: lock.waited
    }
    completedResult = completed
    writeFailureCheckpoint(completed, runtime)
    writeSuccessfulSyncCheckpoint(completed, runtime)
    return scheduleTransientRetries(trigger, runtime, scheduleDeferredFollowUps(trigger, runtime, completed))
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
        // The release runs on the way out of *every* failure, so a cleanup error here is a
        // secondary symptom and must never displace the primary one. It must not change the
        // outcome either: `coordinatedSync` decides whether to rethrow the hook's fail-closed
        // error by testing the thrown error's class, so replacing an
        // `UnreadableCooldownCheckpointError` with a bare cleanup error turned a failing hook
        // into a successful one — fail-closed became fail-open.
        if (coordinatorError) throw withCleanupFailure(coordinatorError, error)
        // Reached only when the run itself returned: the sync succeeded and only the release
        // failed, so there is no primary error to keep.
        if (completedResult) throw new CompletedSyncCleanupError(error, completedResult)
        throw error
      }
    }
  }
}

// Errors that carry a completed result — and the cooldown checkpoint error, whose class is
// what `coordinatedSync` tests — have their own `withCleanupFailure`, which rebuilds the same
// type. Anything else is combined generically; the message leads with the primary so a log
// line still says what actually failed.
function withCleanupFailure(primary, cleanupError) {
  if (typeof primary.withCleanupFailure === 'function') return primary.withCleanupFailure(cleanupError)
  return new AggregateError(
    [primary, cleanupError],
    `${errorMessage(primary)}; sync lock release failed: ${errorMessage(cleanupError)}`
  )
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
  // Sources whose sync ended in a transient state (the collector could not take
  // `collector-run.lock` inside its window). They are failures for this run — nothing was
  // collected — but they are retryable, so the source also goes here and the caller schedules a
  // trailing retry instead of waiting for the next unrelated trigger to cover it. A provider that
  // genuinely failed never lands here: re-running it would fail identically and chain retries.
  const transientSources = new Set()
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
        transientSources.delete(source)
      } catch (cause) {
        error ||= errorMessage(cause)
        failedSources.add(source)
        const transient = cause?.transient === true
        if (transient) transientSources.add(source)
        cycles.push({
          source,
          error: errorMessage(cause),
          ...(transient ? { transient: true } : {}),
          ...(cause?.diagnostics ? { diagnostics: cause.diagnostics } : {})
        })
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

  const transient = [...transientSources]
  return {
    hadFollowUp,
    followUpCount,
    skippedSync: false,
    cycles,
    ...(deferredSources.length > 0 ? { deferredSources } : {}),
    ...(transient.length > 0 ? { transientSources: transient } : {}),
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
    // Zero disables it; `notify.mjs` resolves the env/config value and the validator there
    // allows an explicit 0 for exactly this.
    failureBackoffMs: numberOrDefault(options.failureBackoffMs, 0),
    scheduleWindow: options.scheduleWindow,
    lockTimeoutMs: numberOrDefault(options.lockTimeoutMs, defaultLockTimeoutMs),
    maxFollowUps: numberOrDefault(options.maxFollowUps, defaultMaxFollowUps),
    transientAttempts: numberOrDefault(options.transientAttempts, 0),
    maxTransientRetries: numberOrDefault(options.maxTransientRetries, defaultMaxTransientRetries),
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
    // Tests inject their own reader; in production this falls back to the real probe so
    // the orphan scan can tell a reused pid from the writer it was named for. The probe is
    // only reached for a pid that is already alive, which keeps it off the common path.
    readProcessStartIdentity:
      readProcessStartIdentity ||
      ((pid) =>
        probeProcessStartIdentity(pid, {
          platform,
          nodeVersion,
          readFile: options.readFile,
          runProcessIdentity
        })),
    runProcessIdentity,
    scheduleTrailing: options.scheduleTrailing || (() => false),
    // Only a caller that supplies a probe pays for one. `notify.mjs` wires the real probe in
    // its main block; tests and any other embedder get the pre-guard behaviour by default.
    resourcePressure: typeof options.resourcePressure === 'function' ? options.resourcePressure : null,
    mkdir: options.mkdir || mkdirSync,
    chmod: options.chmod || (hasCustomFileOps ? undefined : chmodSync),
    lstat: options.lstat || (hasCustomFileOps ? undefined : lstatSync),
    stat: options.stat || (hasCustomFileOps ? undefined : statSync),
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

// `mkdir(..., { mode })` only applies the mode to a directory it actually creates. The state
// directory is created earlier by `writeConfig`, which passes no mode and so leaves it at the
// umask's default — 0755 under the interactive shell the hook path runs from. Chmodding after
// the mkdir is what makes the pinning hold for an already-existing directory, the same reason
// `sync.mjs` chmods rather than relying on the mode alone.
//
// A symlinked path is rejected the way `sync.mjs`'s `ensurePrivateStateDir` rejects it, for
// the same two reasons: chmod follows the link and would change the permissions of whatever
// it points at — a directory this same run then refuses to use — and a link substituted
// between checks is a write through an unexpected path. When `lstat` is unavailable (tests
// that inject custom file ops), the chmod is skipped along with it, matching how `readdir`
// and `rename` are already gated.
function ensurePrivateDirectory(runtime, path) {
  const inspect = typeof runtime.lstat === 'function' ? runtime.lstat : null
  if (inspect) {
    const before = safeLstat(inspect, path)
    if (before?.isSymbolicLink()) {
      throw new Error(`TokenBoard state directory must not be a symbolic link: ${path}`)
    }
  }
  runtime.mkdir(path, { recursive: true, mode: 0o700 })
  if (inspect) {
    const after = safeLstat(inspect, path)
    if (after?.isSymbolicLink()) {
      throw new Error(`TokenBoard state directory must not be a symbolic link: ${path}`)
    }
    if (after && typeof after.isDirectory === 'function' && !after.isDirectory()) {
      throw new Error(`TokenBoard state path is not a directory: ${path}`)
    }
    runtime.chmod(path, 0o700)
  }
}

// Only a missing path is expected (the first run, before `mkdir` creates it). Any other
// failure — EACCES, ELOOP — means the inspection itself broke, and skipping the symlink
// checks on an unreadable path is the fail-open this rejects. `sync.mjs`'s
// `inspectDirectory` draws the same line.
function safeLstat(inspect, path) {
  try {
    return inspect(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
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
  // No checkpoint yet means the very first run: nothing to debounce against.
  if (!runtime.exists(path)) return 0
  let raw
  try {
    raw = readTimestamp(path, runtime)
  } catch (error) {
    throw new UnreadableCooldownCheckpointError(error, path)
  }
  const timestamp = new Date(raw).getTime()
  // A checkpoint with no parseable timestamp is damaged, but it must not fail closed.
  // This value only decides whether to debounce, and the sync itself is what rewrites the
  // checkpoint — so refusing to run leaves the damaged file in place forever, with no way
  // out but deleting it by hand. Treating it like an absent checkpoint costs at most one
  // extra sync, after which a successful run has replaced it. (A read *error* is different
  // and still propagates: that is an environment problem a sync cannot repair, and it was
  // already fatal before this branch existed.)
  if (Number.isNaN(timestamp)) return 0
  // A checkpoint in the future is as unusable as an unparseable one, and worse: it makes the
  // remaining cooldown larger than the cooldown itself, without bound. The value is handed
  // to `notify.mjs` as the continuation delay, and a delay past `setTimeout`'s 32-bit range
  // is silently clamped to 1ms there — so the continuation loop would re-run the coordinator
  // every millisecond, holding the lock and rewriting its run log, until the clock caught
  // up. Treating it like a damaged checkpoint costs at most one extra sync, which is what
  // rewrites the file.
  const elapsedMs = runtime.now() - timestamp
  if (elapsedMs < 0) return 0
  return Math.max(0, runtime.cooldownMs - elapsedMs)
}

function isInsideScheduledWindow(runtime) {
  const window = runtime.scheduleWindow
  if (!window) return false
  return isWithinScheduleWindow({ times: window.times, windowMs: window.windowMs, now: runtime.now() })
}

// Mirrors `cooldownRemainingMs` for the other direction: how long to wait after a run that
// failed for a reason a rerun would repeat. A success newer than the failure supersedes it,
// which is what makes the checkpoint self-clearing without a delete (and without a window
// where a crash between the two writes could drop the success record).
function failureBackoffRemainingMs(runtime) {
  if (!(runtime.failureBackoffMs > 0)) return 0
  const failurePath = join(runtime.stateDir, 'last-failure.json')
  if (!runtime.exists(failurePath)) return 0
  let raw
  try {
    raw = readTimestamp(failurePath, runtime)
  } catch (error) {
    // Unlike the cooldown checkpoint this is best-effort bookkeeping: an unreadable failure
    // record can only cost an extra scan, so it fails open rather than failing the hook.
    return 0
  }
  const failedAt = new Date(raw).getTime()
  if (Number.isNaN(failedAt)) return 0
  const elapsedMs = runtime.now() - failedAt
  if (elapsedMs < 0) return 0
  const successPath = join(runtime.stateDir, 'last-success.json')
  if (runtime.exists(successPath)) {
    try {
      const succeededAt = new Date(readTimestamp(successPath, runtime)).getTime()
      // A success record in the future is unusable, exactly as in `cooldownRemainingMs`:
      // after a clock rollback it would outrank every failure written at the old reading
      // and keep cancelling the backoff, re-running the failing scan on every trigger —
      // the loop this checkpoint exists to stop. Treating it as absent costs one scan.
      const successElapsed = runtime.now() - succeededAt
      if (!Number.isNaN(succeededAt) && successElapsed >= 0 && succeededAt >= failedAt) return 0
    } catch {
      // An unreadable success checkpoint is already fatal in `cooldownRemainingMs`; there is
      // no need to fail twice.
    }
  }
  return Math.max(0, runtime.failureBackoffMs - elapsedMs)
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

// A transient cycle failure is retried outside this run: the hook loop cannot wait 35s for a lock
// it just lost, and a full retry inside the hook would blow its window. The delay is the same one
// the coordinator-lock timeout uses, because the cause is the same — the collector was busy.
//
// This runs even though the run is recorded as failed, deliberately: the failure is real (nothing
// was collected), but it is also retryable, and the scheduling decision is independent of the
// status the run reports. Scheduled after `scheduleDeferredFollowUps` so a successful run's own
// deferral bookkeeping is not overwritten.
function scheduleTransientRetries(trigger, runtime, result) {
  if (!result.transientSources?.length) return result
  const attempt = numberOrDefault(runtime.transientAttempts, 0) + 1
  if (attempt > numberOrDefault(runtime.maxTransientRetries, defaultMaxTransientRetries)) {
    // Out of attempts: report it as such rather than scheduling another link in the chain. The
    // sources are already back in the signal queue (restoreFailedSources), so the next trigger
    // — the scheduled sync at the latest — still covers them.
    return { ...result, transientRetriesExhausted: true, transientSources: result.transientSources }
  }
  const delayMs = lockTimeoutRetryDelayMs(runtime)
  // The attempt number rides on the trigger to the spawned worker (`scheduleTrailingNotify`
  // turns it into TOKENBOARD_NOTIFY_TRANSIENT_ATTEMPTS), which is what gives the chain a length.
  const trailingScheduled = scheduleTrailingSources(
    { ...trigger, transientAttempts: attempt },
    result.transientSources,
    runtime,
    delayMs
  )
  return {
    ...result,
    trailingScheduled: result.trailingScheduled === true || trailingScheduled,
    ...(trailingScheduled && result.trailingDelayMs === undefined ? { trailingDelayMs: delayMs } : {}),
    trailingSources: [...(result.trailingSources || []), ...result.transientSources],
    transientAttempt: attempt
  }
}

// Written atomically — to a temp file, then renamed into place — so a process that dies
// mid-write cannot leave a truncated or empty checkpoint behind. This is defence in depth
// rather than the only thing preventing a stuck coordinator: the reader tolerates a damaged
// file (an unparseable timestamp is treated like an absent checkpoint, costing at most one
// extra sync — see `cooldownRemainingMs`), so a half-written file would not wedge the loop.
// `rename` is not available under the custom file-op runtimes some tests inject; there the
// direct write is the only option, and those runtimes do not crash mid-write.
function writeSuccessfulSyncCheckpoint(result, runtime) {
  if (deriveStatus(result) !== 'success') return
  const path = join(runtime.stateDir, 'last-success.json')
  const value = new Date(runtime.now()).toISOString()
  try {
    if (typeof runtime.rename !== 'function') {
      runtime.writeFile(path, value, { mode: 0o600 })
      return
    }
    const temporaryPath = `${path}.tmp-${randomBytes(8).toString('hex')}`
    try {
      runtime.writeFile(temporaryPath, value, { flag: 'wx', mode: 0o600 })
      runtime.rename(temporaryPath, path)
    } catch (error) {
      try {
        runtime.unlink(temporaryPath)
      } catch {
        // The temp file may not exist yet, or cleanup may itself fail; the original error
        // is the one worth reporting.
      }
      throw error
    }
  } catch (error) {
    throw new SuccessfulSyncCheckpointError(error, result)
  }
}

// Records a run whose failure a retry would repeat (an unreachable endpoint, a broken
// provider). Transient failures are excluded: they already have their own retry chain, and
// recording them would make that chain's next attempt skip itself. Writing this checkpoint is
// best-effort — losing it costs one extra scan, while failing the run over it would replace
// the real failure with a bookkeeping error. The lost write is still reported: a checkpoint
// that silently never lands turns the backoff off invisibly, which is how the unwritten
// success checkpoint hid a stuck cooldown before that error was made fatal.
function writeFailureCheckpoint(result, runtime) {
  if (!(runtime.failureBackoffMs > 0)) return
  // Only a run that actually failed counts: a skip is not a failure.
  if (deriveStatus(result) !== 'error') return
  // A failure is worth backing off from only if some failed cycle was *not* transient. When
  // every failure was a busy collector lock, the retry chain owns the schedule and recording
  // the failure would make that chain's next attempt skip itself. A mixed run — one source
  // permanently down, one transiently busy — does record: without it the permanently failing
  // source re-scans through every minute of the retry chain.
  const hasPermanentFailure = (result.cycles || []).some((cycle) => cycle?.error && cycle.transient !== true)
  if (!hasPermanentFailure) return
  const path = join(runtime.stateDir, 'last-failure.json')
  const value = new Date(runtime.now()).toISOString()
  try {
    if (typeof runtime.rename !== 'function') {
      runtime.writeFile(path, value, { mode: 0o600 })
      return
    }
    const temporaryPath = `${path}.tmp-${randomBytes(8).toString('hex')}`
    try {
      runtime.writeFile(temporaryPath, value, { flag: 'wx', mode: 0o600 })
      runtime.rename(temporaryPath, path)
    } catch (error) {
      try {
        runtime.unlink(temporaryPath)
      } catch {
        // Same reasoning as the success checkpoint: cleanup cannot be allowed to hide the
        // write error it followed.
      }
      throw error
    }
  } catch (error) {
    // Best effort, see above — but recorded, so a checkpoint that never lands is not invisible.
    result.failureCheckpointError = errorMessage(error)
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
      ...(result.resourcePressure ? { resourcePressure: result.resourcePressure } : {}),
      ...(result.cooldownRemainingMs != null ? { cooldownRemainingMs: result.cooldownRemainingMs } : {}),
      ...(result.failureBackoffRemainingMs != null
        ? { failureBackoffRemainingMs: result.failureBackoffRemainingMs }
        : {}),
      ...(result.failureCheckpointError ? { failureCheckpointError: result.failureCheckpointError } : {}),
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
  runtime.writeFile(join(runsDir, `${result.runId}.json`), json, { mode: 0o600 })
  pruneRunLogs(runsDir, runtime)
  runtime.writeFile(join(runtime.stateDir, 'last-run.json'), json, { mode: 0o600 })
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
  // Mode is pinned rather than left to the umask. The run logs carry absolute local paths
  // and collector diagnostics, and the hook path runs from an interactive shell, where the
  // umask is normally 022 — so the default here would publish them to every local user. The
  // rest of the state directory is already private (`sync.mjs` chmods the parent to 0700);
  // this is the one directory the coordinator creates itself.
  ensurePrivateDirectory(runtime, runsDir)
  if (!runtime.exists(markerPath)) {
    runtime.writeFile(markerPath, 'TokenBoard bounded run logs v1\n', { mode: 0o600 })
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
  // A lock timeout is contention, not failure: the trigger was deferred (and a
  // retry scheduled), so the run record is "skipped" even though the reason
  // travels in `error`. Counting it as an error made one long sync's own
  // contention look like a burst of failed runs in status.mjs.
  if (result.error) return result.skippedSync && result.skippedReason === 'lock-timeout' ? 'skipped' : 'error'
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
