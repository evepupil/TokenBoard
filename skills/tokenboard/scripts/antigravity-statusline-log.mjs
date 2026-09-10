import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { probeProcessLiveness, supportsReliableSignalZero } from './process-liveness.mjs'

export { supportsReliableSignalZero } from './process-liveness.mjs'

const logSchemaVersion = 'antigravity-statusline-log/v1'
const lockRetryDelayMs = 20
const lockWaitTimeoutMs = 2_000
const orphanLockGraceMs = 500
const compactionLineageMaxAttempts = 8
const sleepState = new Int32Array(new SharedArrayBuffer(4))

export function appendBoundedStatuslineEvent(filePath, value, maxBytes) {
  appendBoundedJsonLine(filePath, value, maxBytes, buildUsageLogHeader)
}

export function appendBoundedStatuslineError(filePath, value, maxBytes) {
  appendBoundedJsonLine(filePath, value, maxBytes)
}

function appendBoundedJsonLine(filePath, value, maxBytes, buildHeader) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const lockPath = `${filePath}.lock`
  const lease = acquireLock(lockPath)
  try {
    appendWithinLock(filePath, value, maxBytes, buildHeader)
  } finally {
    releaseLock(lease)
  }
}

function appendWithinLock(filePath, value, maxBytes, buildHeader) {
  const line = `${JSON.stringify(value)}\n`
  const currentSize = readFileSize(filePath)
  if (currentSize + Buffer.byteLength(line) <= maxBytes) {
    appendFileSync(filePath, line, { mode: 0o600 })
    chmodSync(filePath, 0o600)
    return
  }
  compactJsonl(filePath, line, maxBytes, currentSize, Boolean(buildHeader))
}

function buildUsageLogHeader(input) {
  const header = {
    schemaVersion: logSchemaVersion,
    generation: input.generation
  }
  if (input.retainedFrom !== undefined) {
    header.retainedFrom = input.retainedFrom
  }
  return `${JSON.stringify(header)}\n`
}

function compactJsonl(filePath, line, maxBytes, currentSize, withUsageHeader) {
  const previousGeneration = withUsageHeader ? readUsageLogGeneration(filePath) : undefined
  let retainedFromOffsetBytes = currentSize
  let generation = withUsageHeader ? nextUsageLogGeneration(previousGeneration, retainedFromOffsetBytes) : undefined
  let header = withUsageHeader
    ? buildUsageLogHeader({
        generation,
        retainedFrom: previousGeneration === undefined ? undefined : retainedFromOffsetBytes
      })
    : ''
  let tail = { text: '', startOffsetBytes: currentSize }
  let converged = false

  for (let attempt = 0; attempt < compactionLineageMaxAttempts; attempt += 1) {
    const availableBytes = maxBytes - Buffer.byteLength(header) - Buffer.byteLength(line)
    if (availableBytes < 0) {
      throw new Error('Antigravity statusline log limit is too small for one event')
    }
    tail = readCompleteLogTail(filePath, currentSize, availableBytes)
    const nextRetainedFromOffsetBytes = tail.startOffsetBytes
    if (!withUsageHeader || nextRetainedFromOffsetBytes === retainedFromOffsetBytes) {
      converged = true
      break
    }
    retainedFromOffsetBytes = nextRetainedFromOffsetBytes
    generation = nextUsageLogGeneration(previousGeneration, retainedFromOffsetBytes)
    header = buildUsageLogHeader({
      generation,
      retainedFrom: previousGeneration === undefined ? undefined : retainedFromOffsetBytes
    })
  }
  if (!converged) {
    throw new Error('Antigravity statusline log compaction did not converge')
  }
  const content = `${header}${tail.text}${line}`
  if (Buffer.byteLength(content) > maxBytes) {
    throw new Error('Antigravity statusline log compaction exceeded byte limit')
  }
  const tempPath = `${filePath}.tmp-${process.pid}`
  writeFileSync(tempPath, content, { mode: 0o600 })
  renameSync(tempPath, filePath)
  chmodSync(filePath, 0o600)
}

function nextUsageLogGeneration(previousGeneration, retainedFromOffsetBytes) {
  if (previousGeneration === undefined) return randomBytes(16).toString('hex')
  const previousHash = createHash('sha256').update(previousGeneration).digest('hex')
  return createHash('sha256')
    .update(previousHash)
    .update('\0')
    .update(String(retainedFromOffsetBytes))
    .digest('hex')
    .slice(0, 32)
}

function readUsageLogGeneration(filePath) {
  if (readFileSize(filePath) === 0) return undefined
  const buffer = Buffer.alloc(512)
  const file = openSync(filePath, 'r')
  try {
    const bytesRead = readSync(file, buffer, 0, buffer.length, 0)
    const newline = buffer.indexOf(0x0a, 0, bytesRead)
    const end = newline === -1 ? bytesRead : newline
    const line = buffer.subarray(0, end).toString('utf8').replace(/\r$/, '')
    try {
      const value = JSON.parse(line)
      return value?.schemaVersion === logSchemaVersion && typeof value.generation === 'string'
        ? value.generation
        : undefined
    } catch {
      return undefined
    }
  } finally {
    closeSync(file)
  }
}

function readCompleteLogTail(filePath, currentSize, maxBytes) {
  if (currentSize === 0 || maxBytes === 0) return { text: '', startOffsetBytes: currentSize }
  const bytesToRead = Math.min(currentSize, maxBytes)
  const start = currentSize - bytesToRead
  const buffer = Buffer.alloc(bytesToRead)
  const file = openSync(filePath, 'r')
  try {
    readSync(file, buffer, 0, bytesToRead, start)
  } finally {
    closeSync(file)
  }
  let retained = buffer
  let retainedStart = start
  if (start > 0) {
    const firstNewline = retained.indexOf(0x0a)
    if (firstNewline === -1) return { text: '', startOffsetBytes: currentSize }
    retained = retained.subarray(firstNewline + 1)
    retainedStart += firstNewline + 1
  }
  const firstNewline = retained.indexOf(0x0a)
  if (firstNewline !== -1) {
    const firstLine = retained.subarray(0, firstNewline).toString('utf8').replace(/\r$/, '')
    if (isLogHeader(firstLine)) {
      retained = retained.subarray(firstNewline + 1)
      retainedStart += firstNewline + 1
    }
  }
  if (retained.length > 0 && retained.at(-1) !== 0x0a) {
    while (retained.length + 1 > maxBytes) {
      const newline = retained.indexOf(0x0a)
      if (newline === -1) return { text: '', startOffsetBytes: currentSize }
      retained = retained.subarray(newline + 1)
      retainedStart += newline + 1
    }
    retained = Buffer.concat([retained, Buffer.from('\n')])
  }
  return { text: retained.toString('utf8'), startOffsetBytes: retainedStart }
}

function isLogHeader(line) {
  try {
    return JSON.parse(line)?.schemaVersion === logSchemaVersion
  } catch {
    return false
  }
}

function readFileSize(filePath) {
  try {
    return statSync(filePath).size
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0
    throw error
  }
}

function acquireLock(lockPath) {
  const deadline = Date.now() + lockWaitTimeoutMs
  while (Date.now() < deadline) {
    const pendingPath = `${lockPath}.pending-${process.pid}-${randomBytes(8).toString('hex')}`
    try {
      mkdirSync(pendingPath, { mode: 0o700 })
      writeFileSync(join(pendingPath, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 })
      const identity = readLockIdentity(pendingPath)
      renameSync(pendingPath, lockPath)
      return { lockPath, identity }
    } catch (error) {
      rmSync(pendingPath, { recursive: true, force: true })
      if (!isLockExistsError(error, lockPath)) throw error
      recoverOrphanedLock(lockPath)
      sleep(lockRetryDelayMs)
    }
  }
  throw new Error('Timed out waiting for Antigravity statusline log lock')
}

function releaseLock(lease) {
  if (!sameLockIdentity(lease.lockPath, lease.identity)) {
    throw new Error('Antigravity statusline log lock ownership changed')
  }
  const pid = readLockPid(lease.lockPath)
  if (pid !== process.pid) {
    throw new Error('Antigravity statusline log lock owner changed')
  }
  removeLockWithIdentity(lease.lockPath, lease.identity)
}

function isLockExistsError(error, lockPath) {
  if (!error || typeof error !== 'object') return false
  if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') return true
  return error.code === 'EPERM' && existsSync(lockPath)
}

function recoverOrphanedLock(lockPath) {
  const identity = readLockIdentityOrNull(lockPath)
  if (!identity) return
  const ageMs = readLockAgeMs(lockPath)
  if (ageMs === null) return
  const pid = readLockPid(lockPath)
  if (pid === null) {
    if (ageMs < orphanLockGraceMs) return
    removeLockWithIdentity(lockPath, identity)
    return
  }
  const liveness = probeProcessLiveness(pid)
  if (liveness !== 'dead') return
  removeLockWithIdentity(lockPath, identity)
}

function readLockPid(lockPath) {
  try {
    const raw = readFileSync(join(lockPath, 'pid'), 'utf8').trim()
    if (!/^\d+$/.test(raw)) return null
    const pid = Number(raw)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function readLockIdentity(lockPath) {
  const stats = statSync(lockPath, { bigint: true })
  return { dev: stats.dev, ino: stats.ino }
}

function readLockIdentityOrNull(lockPath) {
  try {
    return readLockIdentity(lockPath)
  } catch {
    return null
  }
}

function sameLockIdentity(lockPath, expected) {
  const current = readLockIdentityOrNull(lockPath)
  return current !== null && current.dev === expected.dev && current.ino === expected.ino
}

function removeLockWithIdentity(lockPath, identity) {
  if (!sameLockIdentity(lockPath, identity)) return
  const quarantinePath = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    renameSync(lockPath, quarantinePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!sameLockIdentity(quarantinePath, identity)) {
    restoreQuarantinedLock(lockPath, quarantinePath)
    return
  }
  rmSync(quarantinePath, { recursive: true, force: true })
}

function restoreQuarantinedLock(lockPath, quarantinePath) {
  try {
    renameSync(quarantinePath, lockPath)
  } catch (error) {
    throw new Error('Antigravity statusline replacement lock could not be restored', { cause: error })
  }
}

function readLockAgeMs(lockPath) {
  try {
    return Math.max(0, Date.now() - statSync(lockPath).mtimeMs)
  } catch {
    return null
  }
}

function sleep(milliseconds) {
  Atomics.wait(sleepState, 0, 0, milliseconds)
}
