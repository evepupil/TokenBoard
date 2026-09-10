import assert from 'node:assert/strict'
import test from 'node:test'
import { win32 as windowsPath } from 'node:path'
import { acquireLock, lockHasToken, releaseLock } from './coordinator-lock.mjs'
import { coordinatedSync } from './coordinator.mjs'
import {
  fakeProcess,
  linkMemoryFile,
  memoryRuntime,
  memoryPathStartsWith,
  sameMemoryPath,
  moveMemoryFile,
  readMemoryFile,
  removeMemoryFile
} from './coordinator-test-helpers.mjs'

test('releaseLock rejects non-atomic cleanup instead of deleting a lock', () => {
  const removed = []

  assert.throws(
    () =>
      releaseLock('/state/sync.lock', {
        process: fakeProcess(201),
        readFile: () => JSON.stringify({ pid: 201, startedAt: '2026-05-22T10:00:00.000Z' }),
        unlink: (path) => removed.push(path)
      }),
    /requires atomic rename and link operations/
  )

  assert.deepEqual(removed, [])
})

test('acquireLock creates a private tokenized lock record', () => {
  const files = new Map()
  let writeOptions
  const runtime = {
    now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    process: fakeProcess(201),
    readFile: (path) => readMemoryFile(files, path),
    writeFile: (path, value, options) => {
      writeOptions = options
      files.set(path, String(value))
    }
  }

  const owner = acquireLock('/state/sync.lock', runtime)

  assert.match(owner.token, /^[a-f0-9]{32}$/)
  assert.deepEqual(JSON.parse(files.get('/state/sync.lock')), {
    pid: 201,
    startedAt: '2026-07-18T10:00:00.000Z',
    token: owner.token
  })
  assert.equal(writeOptions.flag, 'wx')
  assert.equal(writeOptions.mode, 0o600)
  assert.equal(lockHasToken('/state/sync.lock', owner.token, runtime), true)
})

test('acquireLock binds new lock records to the process start identity when available', () => {
  const files = new Map()
  const runtime = {
    process: fakeProcess(201),
    processStartIdentity: 'linux:boot-a:123',
    writeFile: (path, value) => files.set(path, String(value)),
    readFile: (path) => readMemoryFile(files, path)
  }

  const owner = acquireLock('/state/sync.lock', runtime)

  assert.equal(JSON.parse(files.get('/state/sync.lock')).processStartIdentity, 'linux:boot-a:123')
  assert.equal(owner.processStartIdentity, 'linux:boot-a:123')
})

test('acquireLock treats Windows path aliases as the same active owner', () => {
  const files = new Map()
  const canonical = (path) => windowsPath.normalize(String(path)).toLowerCase()
  const readFile = (path) => {
    const key = canonical(path)
    if (!files.has(key)) {
      const error = new Error(`ENOENT: ${path}`)
      error.code = 'ENOENT'
      throw error
    }
    return files.get(key)
  }
  const runtime = {
    platform: 'win32',
    process: fakeProcess(211),
    readFile,
    writeFile: (path, value, options = {}) => {
      const key = canonical(path)
      if (options.flag?.includes('x') && files.has(key)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(key, String(value))
    },
    rename: (source, target) => {
      const sourceKey = canonical(source)
      if (!files.has(sourceKey)) {
        const error = new Error(`ENOENT: ${source}`)
        error.code = 'ENOENT'
        throw error
      }
      files.set(canonical(target), files.get(sourceKey))
      files.delete(sourceKey)
    },
    link: (source, target) => {
      const sourceKey = canonical(source)
      const targetKey = canonical(target)
      if (!files.has(sourceKey)) {
        const error = new Error(`ENOENT: ${source}`)
        error.code = 'ENOENT'
        throw error
      }
      if (files.has(targetKey)) {
        const error = new Error(`EEXIST: ${target}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(targetKey, files.get(sourceKey))
    },
    unlink: (path) => {
      const key = canonical(path)
      if (!files.delete(key)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
    }
  }

  const owner = acquireLock('C:\\State\\nested\\..\\Sync.lock', runtime)
  const aliasAttempt = acquireLock('c:/state/sync.lock', runtime)

  assert.ok(owner)
  assert.equal(aliasAttempt, false)
  assert.equal(releaseLock('c:/STATE/sync.lock', runtime, owner), true)
})

test('acquireLock reclaims a lock record with an invalid pid instead of probing pid zero', () => {
  const lockPath = '/state/sync.lock'
  const original = JSON.stringify({ pid: 0, token: 'invalid-pid' })
  const fs = memoryRuntime({ [lockPath]: original })
  let probedPid = null
  const runtime = {
    ...fs,
    readProcessStartIdentity: () => ({ status: 'unknown' }),
    process: {
      ...fakeProcess(212),
      kill: (pid) => {
        probedPid = pid
        return true
      }
    }
  }

  const owner = acquireLock(lockPath, runtime)

  assert.ok(owner)
  assert.equal(probedPid, null)
  assert.equal(JSON.parse(fs.files.get(lockPath)).token, owner.token)
})

test('acquireLock reclaims an identity-bound lock after pid reuse', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({
      pid: 301,
      token: 'old-owner',
      processStartIdentity: 'linux:boot-a:100'
    })
  })
  const runtime = {
    ...fs,
    process: fakeProcess(302),
    processStartIdentity: 'linux:boot-a:200',
    platform: 'linux',
    readProcessStartIdentity: (pid) => (pid === 301 ? 'linux:boot-a:999' : 'linux:boot-a:200')
  }

  const owner = acquireLock(lockPath, runtime)

  assert.equal(owner.processStartIdentity, 'linux:boot-a:200')
  assert.equal(JSON.parse(fs.files.get(lockPath)).token, owner.token)
})

test('acquireLock keeps an identity-bound lock when the pid and start identity still match', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({
      pid: 301,
      token: 'active-owner',
      processStartIdentity: 'linux:boot-a:100'
    })
  })
  const runtime = {
    ...fs,
    process: fakeProcess(302),
    processStartIdentity: 'linux:boot-a:200',
    platform: 'linux',
    readProcessStartIdentity: () => 'linux:boot-a:100'
  }

  assert.equal(acquireLock(lockPath, runtime), false)
  assert.equal(JSON.parse(fs.files.get(lockPath)).token, 'active-owner')
})

test('acquireLock keeps an identity-bound lock when the process identity is unavailable', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({
      pid: 301,
      token: 'unknown-owner',
      processStartIdentity: 'linux:boot-a:100'
    })
  })
  const runtime = {
    ...fs,
    process: fakeProcess(302),
    processStartIdentity: 'linux:boot-a:200',
    platform: 'linux',
    readProcessStartIdentity: () => ({ status: 'unknown' })
  }

  assert.equal(acquireLock(lockPath, runtime), false)
  assert.equal(JSON.parse(fs.files.get(lockPath)).token, 'unknown-owner')
})

test('acquireLock reclaims an identity-bound lock when an unknown identity probe finds a dead pid', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({
      pid: 301,
      token: 'dead-owner',
      processStartIdentity: 'linux:boot-a:100'
    })
  })
  const runtime = {
    ...fs,
    platform: 'linux',
    process: {
      ...fakeProcess(302),
      kill: (pid) => {
        if (pid === 301) {
          const error = new Error('ESRCH')
          error.code = 'ESRCH'
          throw error
        }
        return true
      }
    },
    readProcessStartIdentity: () => ({ status: 'unknown' })
  }

  const owner = acquireLock(lockPath, runtime)

  assert.ok(owner)
  assert.equal(JSON.parse(fs.files.get(lockPath)).token, owner.token)
})

test('releaseLock does not remove an identity-bound lock after pid reuse', () => {
  const lockPath = '/state/sync.lock'
  const original = JSON.stringify({
    pid: 301,
    token: 'old-owner',
    processStartIdentity: 'linux:boot-a:100'
  })
  const fs = memoryRuntime({ [lockPath]: original })
  const runtime = {
    ...fs,
    process: fakeProcess(301),
    processStartIdentity: 'linux:boot-a:200',
    platform: 'linux',
    readProcessStartIdentity: () => 'linux:boot-a:200'
  }

  assert.equal(releaseLock(lockPath, runtime), false)
  assert.equal(fs.files.get(lockPath), original)
})

test('acquireLock rejects a directory in an ordinary lock path', () => {
  const runtime = {
    process: fakeProcess(201),
    readFile: (path) => {
      if (path.endsWith('.cleanup')) {
        const error = new Error('ENOENT')
        error.code = 'ENOENT'
        throw error
      }
      const error = new Error('EISDIR')
      error.code = 'EISDIR'
      throw error
    },
    writeFile: () => {
      const error = new Error('EEXIST')
      error.code = 'EEXIST'
      throw error
    }
  }

  assert.throws(
    () => acquireLock('/state/sync.lock', runtime),
    (error) => error.code === 'EISDIR'
  )
})

test('releaseLock rejects a directory in an ordinary lock path', () => {
  const runtime = {
    process: fakeProcess(201),
    readFile: () => {
      const error = new Error('EISDIR')
      error.code = 'EISDIR'
      throw error
    },
    unlink: () => {
      throw new Error('directory fence must not be removed')
    }
  }

  assert.throws(
    () => releaseLock('/state/sync.lock', runtime, { token: 'owner' }),
    (error) => error.code === 'EISDIR'
  )
})

test('legacy retry callers can explicitly treat a directory fence as occupied', () => {
  const runtime = {
    process: fakeProcess(201),
    readFile: () => {
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    },
    writeFile: () => {
      const error = new Error('EISDIR')
      error.code = 'EISDIR'
      throw error
    }
  }

  assert.equal(acquireLock('/state/scheduled-sync-retry.lock', runtime, { allowDirectoryFence: true }), false)
})

test('legacy retry callers keep a directory fence occupied when a stale cleanup guard remains', () => {
  const lockPath = '/state/scheduled-sync-retry.lock'
  const cleanupPath = `${lockPath}.cleanup`
  const files = new Map([[cleanupPath, JSON.stringify({ pid: 300, token: 'stale-cleanup', lockToken: 'old-primary' })]])
  const runtime = {
    platform: 'linux',
    process: {
      pid: 301,
      kill: (pid) => {
        if (pid === 300) {
          const error = new Error('ESRCH')
          error.code = 'ESRCH'
          throw error
        }
        return true
      }
    },
    readFile: (path) => {
      if (sameMemoryPath(path, cleanupPath)) return readMemoryFile(files, path)
      const error = new Error('EISDIR')
      error.code = 'EISDIR'
      throw error
    },
    writeFile: () => {
      const error = new Error('EISDIR')
      error.code = 'EISDIR'
      throw error
    },
    unlink: (path) => removeMemoryFile(files, path)
  }

  assert.equal(acquireLock(lockPath, runtime, { allowDirectoryFence: true }), false)
  assert.equal(files.has(cleanupPath), false)
})

test('releaseLock preserves a same-process lock with a different token', () => {
  const lockPath = '/state/sync.lock'
  const original = JSON.stringify({ pid: 201, token: 'new-owner' })
  const files = new Map([[lockPath, original]])
  const runtime = {
    process: fakeProcess(201),
    readFile: (path) => readMemoryFile(files, path),
    rename: (from, to) => moveMemoryFile(files, from, to),
    link: (from, to) => linkMemoryFile(files, from, to),
    unlink: (path) => removeMemoryFile(files, path)
  }

  assert.equal(releaseLock(lockPath, runtime, { token: 'old-owner' }), false)
  assert.equal(files.get(lockPath), original)
})

test('coordinator recovers a pid-reused lock not owned by the current process', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({ pid: 301, token: 'crashed-owner', startedAt: '2026-07-18T10:00:00.000Z' })
  })
  let ran = false

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(301),
      executeSync: () => {
        ran = true
        return { ok: true }
      }
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(ran, true)
  assert.equal(fs.files.has(lockPath), false)
})

test('coordinator preserves an active same-process lock owner', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime()
  const runtime = {
    ...fs,
    now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    process: fakeProcess(302)
  }
  const owner = acquireLock(lockPath, runtime)
  let ran = false

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...runtime,
      stateDir: '/state',
      cooldownMs: 0,
      lockTimeoutMs: 0,
      executeSync: () => {
        ran = true
        return { ok: true }
      }
    }
  )

  assert.equal(result.skippedReason, 'lock-timeout')
  assert.equal(ran, false)
  assert.equal(lockHasToken(lockPath, owner.token, runtime), true)
  assert.equal(releaseLock(lockPath, runtime, owner), true)
})

test('releaseLock removes malformed lock files', () => {
  const lockPath = '/state/sync.lock'
  const files = new Map([[lockPath, 'not-json']])
  const released = releaseLock(lockPath, {
    process: fakeProcess(202),
    readFile: (path) => readMemoryFile(files, path),
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    rename: (from, to) => moveMemoryFile(files, from, to),
    link: (from, to) => linkMemoryFile(files, from, to),
    unlink: (path) => removeMemoryFile(files, path)
  })

  assert.equal(released, true)
  assert.equal(files.has(lockPath), false)
})

test('releaseLock preserves a successful lock removal when cleanup guard release fails', () => {
  const lockPath = '/state/sync.lock'
  const cleanupPath = `${lockPath}.cleanup`
  const fs = memoryRuntime()
  let cleanupUnlinks = 0
  const runtime = {
    ...fs,
    process: fakeProcess(203),
    unlink: (path) => {
      if (sameMemoryPath(path, cleanupPath) && cleanupUnlinks++ === 0) {
        const error = new Error('cleanup guard unavailable')
        error.code = 'EACCES'
        throw error
      }
      return fs.unlink(path)
    }
  }
  const owner = acquireLock(lockPath, runtime)

  assert.equal(releaseLock(lockPath, runtime, owner), true)
  assert.equal(fs.files.has(lockPath), false)
  assert.equal(cleanupUnlinks, 2)
  assert.equal(fs.files.has(cleanupPath), false)
})

test('acquireLock does not remain blocked by a cleanup guard left after primary removal', () => {
  const lockPath = '/state/sync.lock'
  const cleanupPath = `${lockPath}.cleanup`
  const fs = memoryRuntime()
  const runtime = {
    ...fs,
    process: fakeProcess(204),
    unlink: (path) => {
      if (sameMemoryPath(path, cleanupPath)) {
        const error = new Error('cleanup guard unavailable')
        error.code = 'EACCES'
        throw error
      }
      return fs.unlink(path)
    }
  }
  const owner = acquireLock(lockPath, runtime)

  assert.equal(releaseLock(lockPath, runtime, owner), true)
  assert.equal(fs.files.has(lockPath), false)
  assert.equal(fs.files.has(cleanupPath), true)

  const replacement = acquireLock(lockPath, runtime)
  assert.ok(replacement)
  assert.equal(lockHasToken(lockPath, replacement.token, runtime), true)
  assert.equal(releaseLock(lockPath, runtime, replacement), true)
  assert.equal(fs.files.has(lockPath), false)
})

test('another process ignores a completed cleanup guard when its unlink remains unavailable', () => {
  const lockPath = '/state/sync.lock'
  const cleanupPath = `${lockPath}.cleanup`
  const fs = memoryRuntime()
  const runtimeA = {
    ...fs,
    process: fakeProcess(206),
    processStartIdentity: 'linux:cleanup-owner',
    unlink: (path) => {
      if (sameMemoryPath(path, cleanupPath)) {
        const error = new Error('cleanup guard unavailable')
        error.code = 'EACCES'
        throw error
      }
      return fs.unlink(path)
    }
  }
  const owner = acquireLock(lockPath, runtimeA)
  assert.equal(releaseLock(lockPath, runtimeA, owner), true)
  assert.equal(fs.files.has(lockPath), false)
  assert.ok(fs.files.has(cleanupPath))

  const runtimeB = {
    ...fs,
    process: fakeProcess(207),
    processStartIdentity: 'linux:replacement-owner',
    readProcessStartIdentity: (pid) =>
      pid === 206 ? { status: 'known', value: 'linux:cleanup-owner' } : { status: 'dead' },
    unlink: (path) => {
      if (sameMemoryPath(path, cleanupPath)) {
        const error = new Error('cleanup guard unavailable')
        error.code = 'EACCES'
        throw error
      }
      return fs.unlink(path)
    }
  }

  const replacement = acquireLock(lockPath, runtimeB)
  assert.ok(replacement)
  assert.equal(lockHasToken(lockPath, replacement.token, runtimeB), true)
  assert.equal(releaseLock(lockPath, runtimeB, replacement), true)
})

test('releaseLock does not remove locks with unreadable ownership', () => {
  const removed = []
  assert.throws(
    () =>
      releaseLock('/state/sync.lock', {
        process: fakeProcess(205),
        readFile: () => {
          const error = new Error('EACCES')
          error.code = 'EACCES'
          throw error
        },
        unlink: (path) => removed.push(path)
      }),
    /EACCES/
  )

  assert.deepEqual(removed, [])
})

test('releaseLock leaves a replacement untouched when its ownership read sees no file', () => {
  const removed = []
  releaseLock('/state/sync.lock', {
    process: fakeProcess(206),
    readFile: () => {
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    },
    unlink: (path) => {
      removed.push(path)
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    }
  })

  assert.deepEqual(removed, [])
})

test('coordinator restores a stale lock when its quarantined record cannot be read', () => {
  const lockPath = '/state/sync.lock'
  const original = JSON.stringify({ pid: 300, startedAt: '2026-05-22T10:00:00.000Z' })
  const fs = memoryRuntime({ [lockPath]: original })
  let quarantinePath = ''

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      process: {
        pid: 301,
        kill: (pid) => {
          if (pid === 300) {
            const error = new Error('ESRCH')
            error.code = 'ESRCH'
            throw error
          }
          return true
        }
      },
      readFile: (path) => {
        if (sameMemoryPath(path, quarantinePath)) {
          const error = new Error('EACCES')
          error.code = 'EACCES'
          throw error
        }
        return fs.readFile(path)
      },
      rename: (from, to) => {
        if (sameMemoryPath(from, lockPath)) quarantinePath = to
        fs.rename(from, to)
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(result.error, 'EACCES')
  assert.equal(fs.files.get(lockPath), original)
  assert.equal(fs.files.has(quarantinePath), false)
})

test('releaseLock preserves a replacement created after reading its owner', () => {
  const lockPath = '/state/sync.lock'
  const replacement = JSON.stringify({ pid: 302, token: 'replacement' })
  const files = new Map([[lockPath, JSON.stringify({ pid: 301, token: 'original' })]])
  let replaced = false
  const replaceOwner = () => {
    if (replaced) return
    replaced = true
    files.set(lockPath, replacement)
  }
  const runtime = {
    process: fakeProcess(301),
    readFile: (path) => readMemoryFile(files, path),
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    rename: (from, to) => {
      replaceOwner()
      moveMemoryFile(files, from, to)
    },
    link: (from, to) => linkMemoryFile(files, from, to),
    unlink: (path) => {
      replaceOwner()
      removeMemoryFile(files, path)
    }
  }

  releaseLock(lockPath, runtime)

  assert.equal(files.get(lockPath), replacement)
})

test('coordinator does not clear a live replacement while recovering a stale lock', () => {
  const lockPath = '/state/sync.lock'
  const replacement = JSON.stringify({ pid: 302, token: 'replacement' })
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({ pid: 300, token: 'stale' })
  })
  let replaced = false
  let ran = false
  const replaceOwner = () => {
    if (replaced) return
    replaced = true
    fs.files.set(lockPath, replacement)
  }

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      lockTimeoutMs: 0,
      process: {
        pid: 301,
        kill: (pid) => {
          if (pid === 300) {
            const error = new Error('ESRCH')
            error.code = 'ESRCH'
            throw error
          }
          return true
        }
      },
      rename: (from, to) => {
        replaceOwner()
        moveMemoryFile(fs.files, from, to)
      },
      link: (from, to) => linkMemoryFile(fs.files, from, to),
      unlink: (path) => {
        replaceOwner()
        removeMemoryFile(fs.files, path)
      },
      executeSync: () => {
        ran = true
        return { ok: true }
      }
    }
  )

  assert.equal(result.skippedReason, 'lock-timeout')
  assert.equal(ran, false)
  assert.equal(fs.files.get(lockPath), replacement)
})

test('coordinator cleanup guard blocks a competing owner while removing a stale lock', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({ pid: 300, token: 'stale' })
  })
  let competingOwner
  let observedCleanupGuard = false
  const competingRuntime = {
    ...fs,
    now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    process: fakeProcess(302)
  }

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-07-18T10:00:00.000Z'),
      process: {
        pid: 301,
        kill: (pid) => {
          if (pid === 300) {
            const error = new Error('ESRCH')
            error.code = 'ESRCH'
            throw error
          }
          return true
        }
      },
      writeFile: (path, value, options) => {
        fs.writeFile(path, value, options)
        if (sameMemoryPath(path, `${lockPath}.cleanup`) && !observedCleanupGuard) {
          observedCleanupGuard = true
          competingOwner = acquireLock(lockPath, competingRuntime)
        }
      },
      executeSync: () => ({ ok: true })
    }
  )

  assert.equal(observedCleanupGuard, true)
  assert.equal(competingOwner, false)
  assert.equal(result.error, undefined)
  assert.equal(fs.files.has(`${lockPath}.cleanup`), false)
})

test('cleanup guard with a missing primary token does not block a new owner after the primary disappears', () => {
  const lockPath = '/state/sync.lock'
  const cleanupPath = `${lockPath}.cleanup`
  const fs = memoryRuntime([
    [lockPath, JSON.stringify({ pid: 300, startedAt: '2026-07-18T10:00:00.000Z' })],
    [cleanupPath, JSON.stringify({ pid: 301, token: 'active-cleanup', lockToken: 'old-primary' })]
  ])
  let primaryReads = 0
  const runtime = {
    ...fs,
    process: fakeProcess(302),
    readFile: (path) => {
      const value = readMemoryFile(fs.files, path)
      if (sameMemoryPath(path, lockPath) && primaryReads++ === 0) fs.files.delete(lockPath)
      return value
    }
  }

  const owner = acquireLock(lockPath, runtime)

  assert.ok(owner)
  assert.equal(lockHasToken(lockPath, owner.token, runtime), true)
})

test('acquireLock recovers a dead cleanup guard before retrying the lock', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({ pid: 300, token: 'stale' }),
    [`${lockPath}.cleanup`]: JSON.stringify({ pid: 300, token: 'abandoned-cleanup' })
  })
  const runtime = {
    ...fs,
    now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    process: {
      pid: 301,
      kill: (pid) => {
        if (pid === 300) {
          const error = new Error('ESRCH')
          error.code = 'ESRCH'
          throw error
        }
        return true
      }
    }
  }

  const owner = acquireLock(lockPath, runtime)

  assert.notEqual(owner, false)
  assert.equal(fs.files.has(`${lockPath}.cleanup`), false)
  assert.equal(lockHasToken(lockPath, owner.token, runtime), true)
})

test('coordinator reacquires a stale lock even if the file is recreated during cleanup', () => {
  const fs = memoryRuntime({
    '/state/sync.lock': JSON.stringify({ pid: 300, startedAt: '2026-05-22T10:00:00.000Z' })
  })
  let recreated = false
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      process: {
        pid: 301,
        kill: (pid) => {
          if (pid === 300 || pid === 302) {
            const error = new Error('ESRCH')
            error.code = 'ESRCH'
            throw error
          }
          return true
        }
      },
      unlink: (path) => {
        if (memoryPathStartsWith(path, '/state/sync.lock.release-')) {
          fs.unlink(path)
          if (!recreated) {
            recreated = true
            fs.writeFile('/state/sync.lock', JSON.stringify({ pid: 302, startedAt: '2026-05-22T10:00:01.000Z' }))
          }
          return
        }
        fs.unlink(path)
      },
      executeSync: () => ({ ok: true })
    }
  )

  assert.equal(result.skippedSync, false)
  assert.equal(result.error, undefined)
  assert.equal(fs.files.get('/state/sync.lock'), undefined)
})

test('coordinator recovers a stale lock through tasklist on legacy Windows Node', () => {
  const fs = memoryRuntime({
    '/state/sync.lock': JSON.stringify({ pid: 300, startedAt: '2026-05-22T10:00:00.000Z' })
  })
  let tasklistCalls = 0
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      process: fakeProcess(301),
      platform: 'win32',
      nodeVersion: '22.12.0',
      runTasklist: () => {
        tasklistCalls += 1
        return { status: 0, stdout: 'INFO: no matching process\r\n' }
      },
      executeSync: () => ({ ok: true })
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(tasklistCalls, 1)
  assert.equal(fs.files.has('/state/sync.lock'), false)
})
