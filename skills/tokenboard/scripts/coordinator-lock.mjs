const maxAcquireAttempts = 5

export function acquireLock(lockPath, runtime) {
  for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
    try {
      runtime.writeFile(lockPath, lockPayload(runtime), { flag: 'wx' })
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!isLockStale(lockPath, runtime)) return false
      if (!removeStaleLock(lockPath, runtime)) return false
    }
  }
  return false
}

export function waitForLock(lockPath, runtime) {
  const started = runtime.now()
  let backoff = 100
  while (runtime.now() - started < runtime.lockTimeoutMs) {
    if (acquireLock(lockPath, runtime)) return { acquired: true }
    runtime.sleep(backoff)
    backoff = Math.min(backoff * 2, 2000)
  }
  return { acquired: false, error: 'lock timeout' }
}

export function releaseLock(lockPath, runtime) {
  try {
    const lockPid = readLockPid(lockPath, runtime)
    if (lockPid === null || lockPid === runtime.process.pid) {
      runtime.unlink(lockPath)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function lockPayload(runtime) {
  return JSON.stringify({
    pid: runtime.process.pid,
    startedAt: new Date(runtime.now()).toISOString()
  })
}

function removeStaleLock(lockPath, runtime) {
  try {
    runtime.unlink(lockPath)
    return true
  } catch (error) {
    return error.code === 'ENOENT'
  }
}

function isLockStale(lockPath, runtime) {
  const pid = readLockPid(lockPath, runtime)
  if (pid === null) return true
  if (pid === runtime.process.pid) return false
  try {
    runtime.process.kill(pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function readLockPid(lockPath, runtime) {
  let raw
  try {
    raw = runtime.readFile(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed.pid === 'number' ? parsed.pid : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}
