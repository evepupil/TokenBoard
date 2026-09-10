import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSyncInvocation, runWithSyncLock, shouldRunUpgrade } from './sync.mjs'
import { memoryFileMap, sameMemoryPath } from './coordinator-test-helpers.mjs'
import { currentProcessStartIdentity } from './process-liveness.mjs'

test('builds Windows sync invocation with semicolon PATH delimiter', () => {
  const invocation = buildSyncInvocation({
    flags: { mode: 'sync' },
    config: {
      collectorDir: 'C:\\Users\\tokenboard\\.tokenboard\\TokenBoard',
      endpoint: 'https://tokenboard.example',
      uploadToken: 'token',
      timezone: 'Asia/Shanghai',
      source: 'all',
      packageManager: 'pnpm'
    },
    pathEnv: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    homeDir: 'C:\\Users\\tokenboard',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32'
  })

  assert.equal(invocation.command, 'C:\\Program Files\\nodejs\\node.exe')
  assert.equal(invocation.shell, false)
  assert.deepEqual(invocation.args, ['--import', 'tsx', 'src/cli.ts', 'sync', '--source', 'all'])
  assert.equal(
    invocation.env.PATH,
    'C:\\Users\\tokenboard\\.bun\\bin;C:\\Users\\tokenboard\\.local\\bin;C:\\Program Files\\nodejs;C:\\Windows\\System32'
  )
})

test('builds Windows npm sync invocation through cmd shim', () => {
  const invocation = buildSyncInvocation({
    flags: { mode: 'sync', 'package-manager': 'npm' },
    config: {
      collectorDir: 'C:\\Users\\tokenboard\\.tokenboard\\TokenBoard',
      endpoint: 'https://tokenboard.example',
      uploadToken: 'token',
      timezone: 'Asia/Shanghai',
      source: 'all'
    },
    pathEnv: 'C:\\Windows\\System32',
    homeDir: 'C:\\Users\\tokenboard',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32'
  })

  assert.equal(invocation.command, 'C:\\Program Files\\nodejs\\node.exe')
  assert.equal(invocation.shell, false)
})

test('builds Windows bun sync invocation with bun executable', () => {
  const invocation = buildSyncInvocation({
    flags: { mode: 'preview', 'package-manager': 'bun' },
    config: {
      collectorDir: 'C:\\Users\\tokenboard\\.tokenboard\\TokenBoard',
      endpoint: 'https://tokenboard.example',
      uploadToken: 'token',
      timezone: 'Asia/Shanghai',
      source: 'all'
    },
    pathEnv: 'C:\\Windows\\System32',
    homeDir: 'C:\\Users\\tokenboard',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32'
  })

  assert.equal(invocation.command, 'C:\\Program Files\\nodejs\\node.exe')
  assert.equal(invocation.shell, false)
  assert.deepEqual(invocation.args, ['--import', 'tsx', 'src/cli.ts', 'preview', '--source', 'all'])
})

test('sync runs upgrade by default and supports skip flag', () => {
  assert.equal(shouldRunUpgrade({ flags: {}, env: {} }), true)
  assert.equal(shouldRunUpgrade({ flags: { hook: true }, env: {} }), false)
  assert.equal(shouldRunUpgrade({ flags: { 'skip-upgrade': true }, env: {} }), false)
  assert.equal(shouldRunUpgrade({ flags: {}, env: { TOKENBOARD_SKIP_UPGRADE: '1' } }), false)
  assert.equal(shouldRunUpgrade({ flags: {}, env: { TOKENBOARD_AUTO_UPGRADE: '0' } }), false)
})

test('direct sync waits for the hook coordinator lock before running', () => {
  const fs = memoryLockRuntime({
    '/state/sync.lock': JSON.stringify({ pid: 200, startedAt: '2026-07-17T01:00:00.000Z' })
  })
  let ran = false

  const result = runWithSyncLock({
    flags: { mode: 'sync' },
    stateDir: '/state',
    runtime: fs.runtime,
    run: () => {
      ran = true
      assert.equal(JSON.parse(fs.files.get('/state/sync.lock')).pid, 201)
      return 'complete'
    }
  })

  assert.equal(result, 'complete')
  assert.equal(ran, true)
  assert.equal(fs.files.has('/state/sync.lock'), false)
})

test('direct sync creates and restricts the state directory', () => {
  const fs = memoryLockRuntime()

  assert.equal(
    runWithSyncLock({
      flags: { mode: 'sync' },
      stateDir: '/state',
      runtime: fs.runtime,
      run: () => 'complete'
    }),
    'complete'
  )

  assert.deepEqual(fs.directoryOps, [
    { type: 'mkdir', path: '/state', options: { recursive: true, mode: 0o700 } },
    { type: 'chmod', path: '/state', mode: 0o700 }
  ])
})

test('direct sync reports missing state directory capabilities clearly', () => {
  const fs = memoryLockRuntime()
  delete fs.runtime.chmod

  assert.throws(
    () =>
      runWithSyncLock({
        flags: { mode: 'sync' },
        stateDir: '/state',
        runtime: fs.runtime,
        run: () => 'unreachable'
      }),
    /state directory setup requires mkdir and chmod operations/
  )
  assert.deepEqual(fs.directoryOps, [])
})

test('direct sync refuses a symbolic-link state directory before changing permissions', () => {
  const fs = memoryLockRuntime()
  const directoryOps = fs.directoryOps
  fs.runtime.lstat = () => ({
    isSymbolicLink: () => true,
    isDirectory: () => false
  })

  assert.throws(
    () =>
      runWithSyncLock({
        flags: { mode: 'sync' },
        stateDir: '/state',
        runtime: fs.runtime,
        run: () => 'unreachable'
      }),
    /state directory must not be a symbolic link/
  )
  assert.deepEqual(directoryOps, [])
})

test('direct sync binds the production lock to the current process identity', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tokenboard-sync-lock-'))
  const expectedIdentity = currentProcessStartIdentity()
  let lockIdentity

  try {
    runWithSyncLock({
      flags: { mode: 'sync' },
      stateDir,
      run: () => {
        lockIdentity = JSON.parse(readFileSync(join(stateDir, 'sync.lock'), 'utf8')).processStartIdentity
        return 'complete'
      }
    })
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }

  if (expectedIdentity) {
    assert.equal(lockIdentity, expectedIdentity)
  } else if (lockIdentity !== undefined) {
    // See the coordinator test: a busy Windows host may make the first
    // identity probe unknown even though lock acquisition immediately gets a
    // valid process-start identity.
    assert.match(lockIdentity, /^[a-z]+:[^\s]+$/)
  }
})

test('hook child reuses the coordinator lock only with its matching token', () => {
  const originalLock = JSON.stringify({
    pid: 200,
    startedAt: '2026-07-17T01:00:00.000Z',
    token: 'coordinator-token'
  })
  const fs = memoryLockRuntime({ '/state/sync.lock': originalLock })

  const result = runWithSyncLock({
    flags: { hook: true, mode: 'sync' },
    env: {
      TOKENBOARD_COORDINATOR_LOCK_HELD: '1',
      TOKENBOARD_COORDINATOR_LOCK_TOKEN: 'coordinator-token'
    },
    stateDir: '/state',
    runtime: fs.runtime,
    run: () => 'hook-complete'
  })

  assert.equal(result, 'hook-complete')
  assert.equal(fs.files.get('/state/sync.lock'), originalLock)
})

test('hook child does not resolve a new sync lock identity when reusing the coordinator lock', () => {
  const fs = memoryLockRuntime({
    '/state/sync.lock': JSON.stringify({
      pid: 200,
      startedAt: '2026-07-17T01:00:00.000Z',
      token: 'coordinator-token'
    })
  })
  let identityResolutions = 0
  fs.runtime.getProcessStartIdentity = () => {
    identityResolutions += 1
    return 'linux:boot-a:201'
  }

  const result = runWithSyncLock({
    flags: { hook: true, mode: 'sync' },
    env: {
      TOKENBOARD_COORDINATOR_LOCK_HELD: '1',
      TOKENBOARD_COORDINATOR_LOCK_TOKEN: 'coordinator-token'
    },
    stateDir: '/state',
    runtime: fs.runtime,
    run: () => 'hook-complete'
  })

  assert.equal(result, 'hook-complete')
  assert.equal(identityResolutions, 0)
})

test('hook child cannot bypass a live coordinator lock with only the held marker', () => {
  const fs = memoryLockRuntime(
    {
      '/state/sync.lock': JSON.stringify({
        pid: 200,
        startedAt: '2026-07-17T01:00:00.000Z',
        token: 'coordinator-token'
      })
    },
    { releaseOnSleep: false, lockTimeoutMs: 1 }
  )
  let ran = false

  assert.throws(
    () =>
      runWithSyncLock({
        flags: { hook: true, mode: 'sync' },
        env: { TOKENBOARD_COORDINATOR_LOCK_HELD: '1' },
        stateDir: '/state',
        runtime: fs.runtime,
        run: () => {
          ran = true
        }
      }),
    /Timed out waiting for TokenBoard sync lock/
  )

  assert.equal(ran, false)
})

test('hook child cannot bypass a live coordinator lock with a mismatched token', () => {
  const fs = memoryLockRuntime(
    {
      '/state/sync.lock': JSON.stringify({
        pid: 200,
        startedAt: '2026-07-17T01:00:00.000Z',
        token: 'coordinator-token'
      })
    },
    { releaseOnSleep: false, lockTimeoutMs: 1 }
  )
  let ran = false

  assert.throws(
    () =>
      runWithSyncLock({
        flags: { hook: true, mode: 'sync' },
        env: {
          TOKENBOARD_COORDINATOR_LOCK_HELD: '1',
          TOKENBOARD_COORDINATOR_LOCK_TOKEN: 'different-token'
        },
        stateDir: '/state',
        runtime: fs.runtime,
        run: () => {
          ran = true
        }
      }),
    /Timed out waiting for TokenBoard sync lock/
  )

  assert.equal(ran, false)
})

test('direct sync fails before collection when the coordinator lock stays busy', () => {
  const fs = memoryLockRuntime(
    {
      '/state/sync.lock': JSON.stringify({ pid: 200, startedAt: '2026-07-17T01:00:00.000Z' })
    },
    { releaseOnSleep: false, lockTimeoutMs: 1 }
  )
  let ran = false

  assert.throws(
    () =>
      runWithSyncLock({
        flags: { mode: 'sync' },
        stateDir: '/state',
        runtime: fs.runtime,
        run: () => {
          ran = true
        }
      }),
    /Timed out waiting for TokenBoard sync lock/
  )

  assert.equal(ran, false)
  assert.equal(JSON.parse(fs.files.get('/state/sync.lock')).pid, 200)
})

test('direct sync exposes a structurally damaged directory lock', () => {
  const fs = memoryLockRuntime()
  const writeFile = fs.runtime.writeFile
  fs.runtime.writeFile = (path, value, options) => {
    if (sameMemoryPath(path, '/state/sync.lock')) {
      const error = new Error(`EISDIR: ${path}`)
      error.code = 'EISDIR'
      throw error
    }
    return writeFile(path, value, options)
  }
  let ran = false

  assert.throws(
    () =>
      runWithSyncLock({
        flags: { mode: 'sync' },
        stateDir: '/state',
        runtime: fs.runtime,
        run: () => {
          ran = true
        }
      }),
    (error) => error.code === 'EISDIR'
  )

  assert.equal(ran, false)
})

test('direct sync releases its coordinator lock when collection fails', () => {
  const fs = memoryLockRuntime()

  assert.throws(
    () =>
      runWithSyncLock({
        flags: { mode: 'sync' },
        stateDir: '/state',
        runtime: fs.runtime,
        run: () => {
          throw new Error('collector failed')
        }
      }),
    /collector failed/
  )

  assert.equal(fs.files.has('/state/sync.lock'), false)
})

test('direct sync preserves the primary error while reporting a lock release failure', () => {
  const fs = memoryLockRuntime()
  const lockPath = '/state/sync.lock'
  const originalRename = fs.runtime.rename
  fs.runtime.rename = (from, to) => {
    if (sameMemoryPath(from, lockPath)) {
      const error = new Error('permission denied')
      error.code = 'EACCES'
      throw error
    }
    return originalRename(from, to)
  }

  assert.throws(
    () =>
      runWithSyncLock({
        flags: { mode: 'sync' },
        stateDir: '/state',
        runtime: fs.runtime,
        run: () => {
          throw new Error('collector failed')
        }
      }),
    (error) => {
      assert.equal(error instanceof AggregateError, true)
      assert.deepEqual(
        error.errors.map((entry) => entry.message),
        ['collector failed', 'TokenBoard sync lock release failed: permission denied']
      )
      return true
    }
  )
  assert.equal(fs.files.has(lockPath), true)
})

test('direct sync fails visibly when its lock cannot be released after a successful collection', () => {
  const fs = memoryLockRuntime()
  const lockPath = '/state/sync.lock'
  const originalRename = fs.runtime.rename
  fs.runtime.rename = (from, to) => {
    if (sameMemoryPath(from, lockPath)) {
      const error = new Error('permission denied')
      error.code = 'EACCES'
      throw error
    }
    return originalRename(from, to)
  }

  assert.throws(
    () =>
      runWithSyncLock({
        flags: { mode: 'sync' },
        stateDir: '/state',
        runtime: fs.runtime,
        run: () => 'complete'
      }),
    /TokenBoard sync lock release failed: permission denied/
  )
  assert.equal(fs.files.has(lockPath), true)
})

test('direct sync does not swallow falsy collection errors', () => {
  for (const thrown of ['', null, undefined]) {
    const fs = memoryLockRuntime()
    let didThrow = false
    let caught

    try {
      runWithSyncLock({
        flags: { mode: 'sync' },
        stateDir: '/state',
        runtime: fs.runtime,
        run: () => {
          throw thrown
        }
      })
    } catch (error) {
      didThrow = true
      caught = error
    }

    assert.equal(didThrow, true)
    assert.equal(caught, thrown)
    assert.equal(fs.files.has('/state/sync.lock'), false)
  }
})

test('direct sync preserves falsy collection errors when lock release also fails', () => {
  for (const thrown of ['', null, undefined]) {
    const fs = memoryLockRuntime()
    const lockPath = '/state/sync.lock'
    const originalRename = fs.runtime.rename
    fs.runtime.rename = (from, to) => {
      if (sameMemoryPath(from, lockPath)) {
        const error = new Error('permission denied')
        error.code = 'EACCES'
        throw error
      }
      return originalRename(from, to)
    }

    assert.throws(
      () =>
        runWithSyncLock({
          flags: { mode: 'sync' },
          stateDir: '/state',
          runtime: fs.runtime,
          run: () => {
            throw thrown
          }
        }),
      (error) => {
        assert.equal(error instanceof AggregateError, true)
        assert.equal(error.errors[0], thrown, `primary error mismatch for ${String(thrown)}`)
        assert.match(
          error.errors[1].message,
          /sync lock release failed: permission denied/,
          `release error mismatch for ${String(thrown)}`
        )
        return true
      }
    )
    assert.equal(fs.files.has(lockPath), true)
  }
})

function memoryLockRuntime(initial = {}, options = {}) {
  const files = memoryFileMap(initial)
  const directoryOps = []
  let now = Date.parse('2026-07-17T01:00:00.000Z')
  const runtime = {
    lockTimeoutMs: options.lockTimeoutMs ?? 60_000,
    chmod: (path, mode) => {
      directoryOps.push({ type: 'chmod', path, mode })
    },
    mkdir: (path, options) => {
      directoryOps.push({ type: 'mkdir', path, options })
    },
    now: () => now,
    process: {
      pid: 201,
      kill: (pid) => {
        if (pid === 200) return true
        return true
      }
    },
    readFile: (path) => {
      if (!files.has(path)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
      return files.get(path)
    },
    rename: (from, to) => {
      if (!files.has(from)) {
        const error = new Error(`ENOENT: ${from}`)
        error.code = 'ENOENT'
        throw error
      }
      files.set(to, files.get(from))
      files.delete(from)
    },
    link: (from, to) => {
      if (!files.has(from)) {
        const error = new Error(`ENOENT: ${from}`)
        error.code = 'ENOENT'
        throw error
      }
      if (files.has(to)) {
        const error = new Error(`EEXIST: ${to}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(to, files.get(from))
    },
    sleep: (milliseconds) => {
      now += milliseconds
      if (options.releaseOnSleep !== false) files.delete('/state/sync.lock')
    },
    unlink: (path) => {
      if (!files.has(path)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
      files.delete(path)
    },
    writeFile: (path, value, writeOptions = {}) => {
      if (writeOptions.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    }
  }
  return { directoryOps, files, runtime }
}
