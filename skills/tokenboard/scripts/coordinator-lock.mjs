import { randomBytes } from 'node:crypto'
import { normalize, win32 as windowsPath } from 'node:path'
import { errorMessage } from './error-message.mjs'
import { probeProcessLiveness, probeProcessStartIdentity } from './process-liveness.mjs'

const maxAcquireAttempts = 5
const activeLockOwners = new Set()
const activeCleanupOwners = new Set()

export function acquireLock(lockPath, runtime, options = {}) {
  const allowDirectoryFence = options.allowDirectoryFence === true
  for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
    if (isLockCleanupInProgress(lockPath, runtime, { allowDirectoryFence })) return false
    const owner = createLockOwner(runtime)
    try {
      runtime.writeFile(lockPath, lockPayload(owner), { flag: 'wx', mode: 0o600 })
      rememberLockOwner(lockPath, owner, runtime)
      return owner
    } catch (error) {
      if (error.code === 'EISDIR') {
        if (allowDirectoryFence) return false
        throw error
      }
      if (error.code !== 'EEXIST') throw error
      if (!removeStaleLock(lockPath, runtime, { allowDirectoryFence })) return false
    }
  }
  return null
}

export function waitForLock(lockPath, runtime, options = {}) {
  const started = runtime.now()
  let backoff = 100
  while (runtime.now() - started < runtime.lockTimeoutMs) {
    const owner = acquireLock(lockPath, runtime, options)
    if (owner) return { acquired: true, owner }
    runtime.sleep(backoff)
    backoff = Math.min(backoff * 2, 2000)
  }
  return { acquired: false, error: 'lock timeout' }
}

export function releaseLock(lockPath, runtime, owner = null, options = {}) {
  const record = readLockRecord(lockPath, runtime, options)
  if (!record) {
    forgetLockOwner(lockPath, owner, runtime)
    return false
  }
  if (record.directory) {
    forgetLockOwner(lockPath, owner, runtime)
    return false
  }
  if (owner && record.token !== owner.token) {
    forgetLockOwner(lockPath, owner, runtime)
    return false
  }
  if (record.pid !== null && record.pid !== runtime.process.pid) {
    forgetLockOwner(lockPath, owner, runtime)
    return false
  }
  if (!lockRecordMatchesRuntime(record, runtime)) {
    forgetLockOwner(lockPath, owner, runtime)
    return false
  }
  const released = removeLockRecord(lockPath, record.raw, runtime, options)
  if (released) forgetLockOwner(lockPath, record, runtime)
  else forgetLockOwner(lockPath, owner, runtime)
  return released
}

export function lockHasToken(lockPath, token, runtime, options = {}) {
  if (typeof token !== 'string' || !token) return false
  const record = readLockRecord(lockPath, runtime, options)
  return record?.token === token
}

function createLockOwner(runtime, lockToken = null) {
  const now = typeof runtime.now === 'function' ? runtime.now() : Date.now()
  const processStartIdentity = currentRuntimeProcessStartIdentity(runtime)
  return {
    pid: runtime.process.pid,
    startedAt: new Date(now).toISOString(),
    token: randomBytes(16).toString('hex'),
    ...(typeof lockToken === 'string' && lockToken ? { lockToken } : {}),
    ...(processStartIdentity ? { processStartIdentity } : {})
  }
}

function currentRuntimeProcessStartIdentity(runtime) {
  if (typeof runtime.processStartIdentity === 'string' && runtime.processStartIdentity) {
    return runtime.processStartIdentity
  }
  if (typeof runtime.getProcessStartIdentity === 'function') {
    const identity = runtime.getProcessStartIdentity()
    return typeof identity === 'string' && identity ? identity : undefined
  }
  return undefined
}

function rememberLockOwner(lockPath, owner, runtime) {
  if (owner?.token) activeLockOwners.add(lockOwnerKey(lockPath, owner.token, runtime))
}

function forgetLockOwner(lockPath, owner, runtime) {
  if (owner?.token) activeLockOwners.delete(lockOwnerKey(lockPath, owner.token, runtime))
}

function lockOwnerKey(lockPath, token, runtime) {
  const isWindows = process.platform === 'win32' || runtime?.platform === 'win32'
  const normalizedPath = isWindows ? windowsPath.normalize(String(lockPath)) : normalize(String(lockPath))
  const keyPath = isWindows ? normalizedPath.toLowerCase() : normalizedPath
  return `${keyPath}\u0000${token}`
}

function lockPayload(owner) {
  return JSON.stringify({
    pid: owner.pid,
    startedAt: owner.startedAt,
    token: owner.token,
    ...(owner.lockToken ? { lockToken: owner.lockToken } : {}),
    ...(owner.processStartIdentity ? { processStartIdentity: owner.processStartIdentity } : {})
  })
}

function removeStaleLock(lockPath, runtime, options = {}) {
  const record = readLockRecord(lockPath, runtime, options)
  if (!record) return true
  if (record.directory) return false
  if (!isLockRecordStale(lockPath, record, runtime)) return false
  const removed = removeLockRecord(lockPath, record.raw, runtime, options)
  if (removed) forgetLockOwner(lockPath, record, runtime)
  return removed
}

function removeLockRecord(lockPath, expectedRaw, runtime, options = {}) {
  if (
    typeof runtime.rename !== 'function' ||
    typeof runtime.link !== 'function' ||
    typeof runtime.writeFile !== 'function'
  ) {
    throw new Error('TokenBoard lock cleanup requires atomic rename and link operations')
  }

  const cleanupOwner = acquireLockCleanup(lockPath, expectedRaw, runtime)
  if (!cleanupOwner) return false

  let removed = false
  let primaryError
  try {
    const current = readLockRecord(lockPath, runtime, options)
    if (current && current.raw === expectedRaw) {
      removed = removeVerifiedLockRecord(lockPath, expectedRaw, runtime, options)
    }
  } catch (error) {
    primaryError = error
  }

  let cleanupError
  try {
    releaseLockCleanup(lockPath, cleanupOwner, runtime)
  } catch (error) {
    cleanupError = error
    try {
      releaseLockCleanup(lockPath, cleanupOwner, runtime)
      cleanupError = null
    } catch (retryError) {
      cleanupError = new AggregateError(
        [error, retryError],
        `${errorMessage(error)}; cleanup guard retry failed: ${errorMessage(retryError)}`
      )
    }
  }
  if (primaryError) {
    if (cleanupError && primaryError && typeof primaryError === 'object') {
      try {
        primaryError.cleanupError = cleanupError
      } catch (_) {}
    }
    throw primaryError
  }
  if (cleanupError && !removed) throw cleanupError
  return removed
}

function removeVerifiedLockRecord(lockPath, expectedRaw, runtime, options = {}) {
  const quarantinePath = lockQuarantinePath(lockPath, runtime)
  try {
    runtime.rename(lockPath, quarantinePath)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }

  let quarantined
  try {
    quarantined = readLockRecord(quarantinePath, runtime, options)
  } catch (error) {
    restoreLockRecord(lockPath, quarantinePath, runtime)
    throw error
  }
  if (!quarantined || quarantined.raw !== expectedRaw) {
    restoreLockRecord(lockPath, quarantinePath, runtime)
    return false
  }
  try {
    runtime.unlink(quarantinePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    restoreLockRecord(lockPath, quarantinePath, runtime)
    throw error
  }
}

function isLockCleanupInProgress(lockPath, runtime, options = {}) {
  const guardPath = lockCleanupPath(lockPath)
  const guard = readLockCleanup(guardPath, runtime)
  if (!guard) return false

  const primary = readLockRecord(lockPath, runtime, options)
  // A completed cleanup may leave its guard behind when the guard unlink
  // fails. Once the primary record is gone, the guard cannot represent a live
  // cleanup and must not block a new owner in another process. A guard with a
  // different primary token belongs to an older cleanup cycle.
  if (!primary) return false
  if (primary.directory) {
    if (isLockCleanupOwnerActive(guardPath, guard, runtime)) return true
    try {
      removeStaleLockCleanup(guardPath, guard.raw, runtime)
    } catch (_) {}
    return false
  }
  if (!cleanupGuardBelongsToPrimary(guard, primary)) return false

  const active = isLockCleanupOwnerActive(guardPath, guard, runtime)
  // Keep an active cleanup operation serialized even during the short window
  // after it has quarantined the primary record. A stale guard left behind by
  // a failed unlink is safe to ignore once the primary record is absent.
  if (active) return true
  if (!readLockRecord(lockPath, runtime, options)) return false
  try {
    return !removeStaleLockCleanup(guardPath, guard.raw, runtime)
  } catch (_) {
    // The recorded cleanup owner is no longer active. If the guard itself
    // cannot be unlinked, it cannot protect a live cleanup operation either.
    // Let the primary lock path decide whether acquisition can proceed.
    return false
  }
}

function acquireLockCleanup(lockPath, expectedRaw, runtime) {
  const guardPath = lockCleanupPath(lockPath)
  const expected = parseLockRecord(expectedRaw)
  for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
    const owner = createLockOwner(runtime, expected.token)
    try {
      runtime.writeFile(guardPath, lockPayload(owner), { flag: 'wx', mode: 0o600 })
      rememberCleanupOwner(guardPath, owner, runtime)
      return owner
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = readLockCleanup(guardPath, runtime)
      if (!existing) return null
      const primary = readLockRecord(lockPath, runtime)
      if (primary && !cleanupGuardBelongsToPrimary(existing, primary)) {
        try {
          if (!removeStaleLockCleanup(guardPath, existing.raw, runtime)) return null
        } catch (_) {
          // A guard from an older lock generation cannot protect the current
          // primary record. If it cannot be unlinked, continue unprotected.
          return { unprotected: true }
        }
        continue
      }
      if (isLockCleanupOwnerActive(guardPath, existing, runtime)) return null
      try {
        if (!removeStaleLockCleanup(guardPath, existing.raw, runtime)) return null
      } catch (_) {
        // The guard owner has been verified stale. Continue without creating a
        // second guard when the stale marker cannot be unlinked; retaining it
        // must not make a live primary lock impossible to release.
        return { unprotected: true }
      }
    }
  }
  return null
}

function releaseLockCleanup(lockPath, owner, runtime) {
  if (owner?.unprotected) return false
  const guardPath = lockCleanupPath(lockPath)
  try {
    const current = readLockCleanup(guardPath, runtime)
    if (!current || current.token !== owner.token || current.pid !== runtime.process.pid) return false
    if (!lockRecordMatchesRuntime(current, runtime)) return false
    runtime.unlink(guardPath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  } finally {
    forgetCleanupOwner(guardPath, owner, runtime)
  }
}

function removeStaleLockCleanup(guardPath, expectedRaw, runtime) {
  const current = readLockCleanup(guardPath, runtime)
  if (!current || current.raw !== expectedRaw) return false
  try {
    runtime.unlink(guardPath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
}

function readLockCleanup(guardPath, runtime) {
  let raw
  try {
    raw = runtime.readFile(guardPath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const record = parseLockRecord(raw)
  return { raw, ...record }
}

function isLockCleanupOwnerActive(guardPath, record, runtime) {
  // A completed cleanup in this process may leave its guard behind when the
  // unlink fails. The process identity alone cannot distinguish that stale
  // marker from an active cleanup, so require the in-memory owner token for
  // same-process guards.
  if (record?.pid === runtime.process.pid && record.token) {
    return activeCleanupOwners.has(lockOwnerKey(guardPath, record.token, runtime))
  }
  return isLockOwnerActive(guardPath, record, runtime, activeCleanupOwners)
}

function rememberCleanupOwner(guardPath, owner, runtime) {
  if (owner?.token) activeCleanupOwners.add(lockOwnerKey(guardPath, owner.token, runtime))
}

function forgetCleanupOwner(guardPath, owner, runtime) {
  if (owner?.token) activeCleanupOwners.delete(lockOwnerKey(guardPath, owner.token, runtime))
}

function restoreLockRecord(lockPath, quarantinePath, runtime) {
  try {
    runtime.link(quarantinePath, lockPath)
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error
  }
  try {
    runtime.unlink(quarantinePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function isLockRecordStale(lockPath, record, runtime) {
  return !isLockOwnerActive(lockPath, record, runtime, activeLockOwners)
}

function isLockOwnerActive(lockPath, record, runtime, activeOwners) {
  const pid = record?.pid ?? null
  if (pid === null) return false
  if (pid === runtime.process.pid && record.token && activeOwners.has(lockOwnerKey(lockPath, record.token, runtime))) {
    return true
  }
  if (record.processStartIdentity) {
    const identity = processStartIdentityForPid(pid, runtime)
    if (identity.status === 'dead') return false
    if (identity.status === 'known') return identity.value === record.processStartIdentity
    // A failed start-identity probe cannot distinguish a live process from a
    // reused PID, but it can still identify a process that has exited. Avoid
    // permanently wedging the lock when the owner is clearly gone; retain the
    // conservative live result for an indeterminate liveness probe.
    return (
      probeProcessLiveness(pid, {
        platform: runtime.platform,
        nodeVersion: runtime.nodeVersion,
        kill: runtime.process.kill?.bind(runtime.process),
        runTasklist: runtime.runTasklist
      }) !== 'dead'
    )
  }
  if (pid === runtime.process.pid) return false
  return (
    probeProcessLiveness(pid, {
      platform: runtime.platform,
      nodeVersion: runtime.nodeVersion,
      kill: runtime.process.kill?.bind(runtime.process),
      runTasklist: runtime.runTasklist
    }) !== 'dead'
  )
}

function processStartIdentityForPid(pid, runtime) {
  if (pid === runtime.process.pid) {
    const processStartIdentity = currentRuntimeProcessStartIdentity(runtime)
    if (processStartIdentity) return { status: 'known', value: processStartIdentity }
  }
  return probeProcessStartIdentity(pid, {
    platform: runtime.platform,
    nodeVersion: runtime.nodeVersion,
    readProcessStartIdentity: runtime.readProcessStartIdentity,
    runProcessIdentity: runtime.runProcessIdentity,
    kill: runtime.process.kill?.bind(runtime.process)
  })
}

function lockRecordMatchesRuntime(record, runtime) {
  if (!record.processStartIdentity) return true
  const identity = processStartIdentityForPid(record.pid, runtime)
  return identity.status === 'known' && identity.value === record.processStartIdentity
}

function readLockRecord(lockPath, runtime, options = {}) {
  let raw
  try {
    raw = runtime.readFile(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error.code === 'EISDIR') {
      if (options.allowDirectoryFence === true) {
        return { directory: true, pid: null, token: null, raw: null }
      }
      throw error
    }
    throw error
  }
  return { raw, ...parseLockRecord(raw) }
}

function parseLockRecord(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { pid: null, token: null }
    return {
      pid: Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      token: typeof parsed.token === 'string' ? parsed.token : null,
      lockToken: typeof parsed.lockToken === 'string' && parsed.lockToken ? parsed.lockToken : null,
      processStartIdentity:
        typeof parsed.processStartIdentity === 'string' && parsed.processStartIdentity
          ? parsed.processStartIdentity
          : null
    }
  } catch (error) {
    if (error instanceof SyntaxError) return { pid: null, token: null }
    throw error
  }
}

function cleanupGuardBelongsToPrimary(guard, primary) {
  if (primary.directory) return false
  if (guard.lockToken) return guard.lockToken === primary.token
  if (!guard.lockToken && !primary.lockToken) {
    const guardStartedAt = Date.parse(guard.startedAt ?? '')
    const primaryStartedAt = Date.parse(primary.startedAt ?? '')
    if (Number.isFinite(guardStartedAt) && Number.isFinite(primaryStartedAt)) {
      return guardStartedAt >= primaryStartedAt
    }
  }
  return true
}

function lockQuarantinePath(lockPath, runtime) {
  const now = typeof runtime.now === 'function' ? runtime.now() : Date.now()
  return `${lockPath}.release-${runtime.process.pid}-${now}-${Math.random().toString(36).slice(2)}`
}

function lockCleanupPath(lockPath) {
  return `${lockPath}.cleanup`
}
