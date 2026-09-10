import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { acquireLock, lockHasToken, releaseLock } from './coordinator-lock.mjs'
import { errorMessage } from './error-message.mjs'
import { probeProcessLiveness, probeProcessStartIdentity } from './process-liveness.mjs'

const legacyRetryMarkerPrefix = 'source-'
const activeLegacyRetryLocks = new Map()
const activeLegacyRetryMarkers = new Set()

export function acquireLegacyRetryFence({ runtime, lockPath }) {
  const active = activeLegacyRetryLocks.get(lockPath)
  if (active && active.owner.pid === runtime.process.pid) {
    active.references += 1
    return active.owner
  }
  if (!ensureLegacyRetryFence({ runtime, lockPath })) return false

  const owner = {
    pid: runtime.process.pid,
    token: randomBytes(16).toString('hex'),
    processStartIdentity: runtime.processStartIdentity,
    markerPath: join(
      lockPath,
      `${legacyRetryMarkerPrefix}${runtime.process.pid}-${randomBytes(8).toString('hex')}.json`
    )
  }
  runtime.writeFile(
    owner.markerPath,
    JSON.stringify({
      pid: owner.pid,
      token: owner.token,
      ...(owner.processStartIdentity ? { processStartIdentity: owner.processStartIdentity } : {})
    }),
    { flag: 'wx', mode: 0o600 }
  )
  activeLegacyRetryMarkers.add(owner.token)
  activeLegacyRetryLocks.set(lockPath, { owner, references: 1 })
  return owner
}

export function releaseLegacyRetryFence({ runtime, lockPath, transitionPath, owner, transitionOwner }) {
  if (!owner || owner === false) return
  const active = activeLegacyRetryLocks.get(lockPath)
  let finalReference = false
  if (active?.owner.token === owner.token) {
    active.references -= 1
    if (active.references > 0) return
    finalReference = true
  }

  const acquiredTransitionOwner = transitionOwner || acquireLock(transitionPath, runtime)
  if (!acquiredTransitionOwner) {
    throw new Error('TokenBoard scheduled retry could not acquire the transition lock to release its legacy marker')
  }

  let primaryError
  let markerRemoved = false
  try {
    markerRemoved = removeLegacyRetryMarker({ runtime, lockPath, owner })
  } catch (error) {
    primaryError = error
    markerRemoved = hasMarkerRemovalFlag(error)
  }
  if (!transitionOwner) {
    try {
      releaseOwnedLock(transitionPath, runtime, acquiredTransitionOwner)
    } catch (releaseError) {
      primaryError = primaryError
        ? new AggregateError(
            [primaryError, releaseError],
            `${errorMessage(primaryError)}; ${errorMessage(releaseError)}`
          )
        : releaseError
    }
  }
  if (markerRemoved) {
    activeLegacyRetryMarkers.delete(owner.token)
    if (finalReference && activeLegacyRetryLocks.get(lockPath)?.owner.token === owner.token) {
      activeLegacyRetryLocks.delete(lockPath)
    }
  }
  if (primaryError) throw primaryError
}

export function prepareLegacyRetryFenceForAll({ runtime, lockPath }) {
  if (!isDirectoryPath(lockPath, runtime)) return false
  const { activeMarkers, unknownEntries, corruptedEntries } = pruneLegacyRetryMarkers({ runtime, lockPath })
  throwIfLegacyRetryFenceIsCorrupt(lockPath, unknownEntries, corruptedEntries)
  if (activeMarkers > 0) return true
  try {
    runtime.rmdir(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
      throwLegacyRetryFenceCorruption(lockPath, ['directory changed during cleanup'])
    }
    throw error
  }
  return false
}

function ensureLegacyRetryFence({ runtime, lockPath }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      runtime.mkdir(lockPath, { mode: 0o700 })
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }

    if (isDirectoryPath(lockPath, runtime)) {
      const { activeMarkers, unknownEntries, corruptedEntries } = pruneLegacyRetryMarkers({ runtime, lockPath })
      throwIfLegacyRetryFenceIsCorrupt(lockPath, unknownEntries, corruptedEntries)
      if (activeMarkers > 0) return true
      try {
        runtime.rmdir(lockPath)
      } catch (error) {
        if (error.code === 'ENOENT') continue
        if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
          throwLegacyRetryFenceCorruption(lockPath, ['directory changed during cleanup'])
        }
        throw error
      }
      continue
    }

    const legacyOwner = acquireLock(lockPath, runtime, { allowDirectoryFence: true })
    if (!legacyOwner) return false
    releaseOwnedLock(lockPath, runtime, legacyOwner, { allowDirectoryFence: true })
  }
  return false
}

function removeLegacyRetryMarker({ runtime, lockPath, owner }) {
  const initialFence = pruneLegacyRetryMarkers({ runtime, lockPath })
  throwIfLegacyRetryFenceIsCorrupt(lockPath, initialFence.unknownEntries, initialFence.corruptedEntries)

  let markerRemoved = false
  try {
    try {
      runtime.unlink(owner.markerPath)
      markerRemoved = true
    } catch (error) {
      if (error.code === 'ENOENT') markerRemoved = true
      else throw error
    }

    const { activeMarkers, unknownEntries, corruptedEntries } = pruneLegacyRetryMarkers({ runtime, lockPath })
    throwIfLegacyRetryFenceIsCorrupt(lockPath, unknownEntries, corruptedEntries)
    if (activeMarkers > 0) return markerRemoved
    try {
      runtime.rmdir(lockPath)
    } catch (error) {
      if (error.code === 'ENOENT') return markerRemoved
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
        throwLegacyRetryFenceCorruption(lockPath, ['directory changed during cleanup'])
      }
      throw error
    }
    return markerRemoved
  } catch (error) {
    if (markerRemoved) {
      try {
        error.tokenboardMarkerRemoved = true
      } catch {
        const wrapped = new Error(errorMessage(error), { cause: error })
        wrapped.tokenboardMarkerRemoved = true
        throw wrapped
      }
    }
    throw error
  }
}

function pruneLegacyRetryMarkers({ runtime, lockPath }) {
  let entries
  try {
    entries = runtime.readdir(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') return { activeMarkers: 0, unknownEntries: [], corruptedEntries: [] }
    if (error.code === 'ENOTDIR' || error.code === 'EISDIR')
      return { activeMarkers: 0, unknownEntries: [], corruptedEntries: [] }
    throw error
  }

  let activeMarkers = 0
  const unknownEntries = []
  const corruptedEntries = []
  for (const entry of entries) {
    if (!entry.startsWith(legacyRetryMarkerPrefix)) {
      unknownEntries.push(entry)
      continue
    }
    const markerPath = join(lockPath, entry)
    const marker = readLegacyRetryMarker(runtime, markerPath)
    if (marker.status === 'missing') continue
    if (marker.status === 'invalid') {
      corruptedEntries.push(entry)
      continue
    }
    if (isLegacyRetryMarkerActive(marker.value, runtime)) {
      activeMarkers += 1
      continue
    }
    try {
      runtime.unlink(markerPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return { activeMarkers, unknownEntries, corruptedEntries }
}

function throwIfLegacyRetryFenceIsCorrupt(lockPath, unknownEntries, corruptedEntries = []) {
  if (unknownEntries.length === 0 && corruptedEntries.length === 0) return
  throwLegacyRetryFenceCorruption(lockPath, unknownEntries, corruptedEntries)
}

function throwLegacyRetryFenceCorruption(lockPath, unknownEntries, corruptedEntries = []) {
  const details = []
  if (unknownEntries.length > 0) {
    details.push(`unexpected entries ${unknownEntries.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }
  if (corruptedEntries.length > 0) {
    details.push(`corrupted marker files ${corruptedEntries.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }
  const error = new Error(`TokenBoard scheduled retry legacy fence is corrupted at ${lockPath}: ${details.join('; ')}`)
  error.code = 'TOKENBOARD_LEGACY_RETRY_FENCE_CORRUPTED'
  throw error
}

function hasMarkerRemovalFlag(error) {
  return Boolean(error && typeof error === 'object' && error.tokenboardMarkerRemoved === true)
}

function readLegacyRetryMarker(runtime, markerPath) {
  let raw
  try {
    raw = runtime.readFile(markerPath)
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' }
    throw error
  }
  try {
    const marker = JSON.parse(raw)
    if (
      !marker ||
      typeof marker !== 'object' ||
      !Number.isSafeInteger(marker.pid) ||
      marker.pid <= 0 ||
      typeof marker.token !== 'string' ||
      !marker.token
    ) {
      return { status: 'invalid' }
    }
    if (
      marker.processStartIdentity !== undefined &&
      (typeof marker.processStartIdentity !== 'string' ||
        !marker.processStartIdentity ||
        marker.processStartIdentity.length > 256)
    ) {
      return { status: 'invalid' }
    }
    return { status: 'valid', value: marker }
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 'invalid' }
    throw error
  }
}

function isLegacyRetryMarkerActive(marker, runtime) {
  if (marker.pid === runtime.process.pid && activeLegacyRetryMarkers.has(marker.token)) {
    if (
      marker.processStartIdentity &&
      runtime.processStartIdentity &&
      marker.processStartIdentity !== runtime.processStartIdentity
    ) {
      return false
    }
    return true
  }
  if (marker.processStartIdentity) {
    const identity = probeProcessStartIdentity(marker.pid, {
      platform: runtime.platform,
      nodeVersion: runtime.nodeVersion,
      readProcessStartIdentity: runtime.readProcessStartIdentity,
      runProcessIdentity: runtime.runProcessIdentity
    })
    if (identity.status === 'dead') return false
    if (identity.status === 'known') return identity.value === marker.processStartIdentity
    return true
  }
  return (
    probeProcessLiveness(marker.pid, {
      platform: runtime.platform,
      nodeVersion: runtime.nodeVersion,
      kill: runtime.process.kill?.bind(runtime.process),
      runTasklist: runtime.runTasklist
    }) !== 'dead'
  )
}

function isDirectoryPath(path, runtime) {
  try {
    runtime.readdir(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') return false
    throw error
  }
}

function releaseOwnedLock(lockPath, runtime, owner, options = {}) {
  const released = releaseLock(lockPath, runtime, owner, options)
  if (released || !lockHasToken(lockPath, owner.token, runtime, options)) return
  throw new Error('TokenBoard scheduled retry lock release was not confirmed')
}
