import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { runNotify } from './notify.mjs'
import { memoryFileMap, memoryPathStartsWith, sameMemoryPath } from './coordinator-test-helpers.mjs'

test('notify retains its own trailing lock without recursive scheduling', () => {
  const files = memoryFileMap([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/trailing.lock', JSON.stringify({ pid: 900, token: 'owner-a' })]
  ])

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: () => {},
    process: {
      pid: 900,
      kill: () => true
    },
    ownerToken: 'owner-a',
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.skippedReason, 'cooldown')
  assert.equal(result.trailingScheduled, true)
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 900)
})

test('notify reports trailing lock cleanup failures after spawn errors', () => {
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  let failedCleanup = false

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => {
      if (memoryPathStartsWith(path, '/state/trailing.lock.release-') && !failedCleanup) {
        failedCleanup = true
        const error = new Error('EPERM')
        error.code = 'EPERM'
        throw error
      }
      files.delete(path)
    },
    process: {
      pid: 901,
      kill: () => true
    },
    spawnDetached: () => {
      throw new Error('spawn failed')
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.match(result.error, /spawn failed/)
  assert.match(result.error, /trailing lock cleanup failed: EPERM/)
})

test('notify releases a trailing lock when the detached notifier emits an asynchronous spawn error', async () => {
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  const child = new EventEmitter()
  child.pid = 902
  child.unref = () => {}
  const errors = []

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    process: { pid: 901, kill: () => true },
    error: (message) => errors.push(message),
    spawnDetached: () => child,
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.trailingScheduled, true)
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 902)

  await new Promise((resolve) =>
    setImmediate(() => {
      const error = new Error('ENOENT: missing node')
      error.code = 'ENOENT'
      child.emit('error', error)
      child.emit('error', new Error('second spawn error'))
      resolve()
    })
  )

  assert.equal(files.has('/state/trailing.lock'), false)
  assert.deepEqual(errors, ['TokenBoard trailing notifier spawn failed: ENOENT: missing node'])
})

test('notify preserves a replacement trailing lock after a published child emits an asynchronous spawn error', async () => {
  const lockPath = '/state/trailing.lock'
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  const child = new EventEmitter()
  child.pid = 902
  child.unref = () => {}
  const errors = []

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    process: { pid: 901, kill: () => true },
    error: (message) => errors.push(message),
    spawnDetached: () => child,
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  const replacement = JSON.stringify({ pid: 903, token: 'replacement-owner' })
  files.set(lockPath, replacement)

  await new Promise((resolve) =>
    setImmediate(() => {
      const error = new Error('ENOENT: missing node')
      error.code = 'ENOENT'
      child.emit('error', error)
      resolve()
    })
  )

  assert.equal(files.get(lockPath), replacement)
  assert.deepEqual(errors, ['TokenBoard trailing notifier spawn failed: ENOENT: missing node'])
})

test('notify reports asynchronous trailing lock cleanup failures without crashing', async () => {
  const lockPath = '/state/trailing.lock'
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  const child = new EventEmitter()
  child.pid = 902
  child.unref = () => {}
  const errors = []
  let failedCleanup = false

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => {
      if (memoryPathStartsWith(path, `${lockPath}.release-`) && !failedCleanup) {
        failedCleanup = true
        const error = new Error('EPERM')
        error.code = 'EPERM'
        throw error
      }
      files.delete(path)
    },
    process: { pid: 901, kill: () => true },
    error: (message) => errors.push(message),
    spawnDetached: () => child,
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  child.emit('error', new Error('ENOENT: missing node'))

  assert.equal(files.has(lockPath), true)
  assert.deepEqual(errors, [
    'TokenBoard trailing notifier spawn failed: ENOENT: missing node; trailing lock cleanup failed: EPERM'
  ])
})

test('notify handles an asynchronous spawn error before the detached notifier has a pid', async () => {
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  const child = new EventEmitter()
  const errors = []

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    process: { pid: 901, kill: () => true },
    error: (message) => errors.push(message),
    spawnDetached: () => child,
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.match(result.error, /did not provide a valid process id/)
  assert.equal(files.has('/state/trailing.lock'), false)

  await new Promise((resolve) =>
    setImmediate(() => {
      const error = new Error('ENOENT: missing node')
      error.code = 'ENOENT'
      child.emit('error', error)
      resolve()
    })
  )

  assert.equal(files.has('/state/trailing.lock'), false)
  assert.deepEqual(errors, ['TokenBoard trailing notifier spawn failed: ENOENT: missing node'])
})

test('notify does not remove a replacement trailing lock after a prior spawn failure', async () => {
  const lockPath = '/state/trailing.lock'
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  const child = new EventEmitter()
  const errors = []

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    process: { pid: 901, kill: () => true },
    error: (message) => errors.push(message),
    spawnDetached: () => child,
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.match(result.error, /did not provide a valid process id/)
  assert.equal(files.has(lockPath), false)
  const replacement = JSON.stringify({ pid: 901, token: 'replacement-owner' })
  files.set(lockPath, replacement)

  await new Promise((resolve) =>
    setImmediate(() => {
      const error = new Error('ENOENT: missing node')
      error.code = 'ENOENT'
      child.emit('error', error)
      resolve()
    })
  )

  assert.equal(files.get(lockPath), replacement)
  assert.deepEqual(errors, ['TokenBoard trailing notifier spawn failed: ENOENT: missing node'])
})

test('notify keeps its trailing lock and error listener after a successful child spawn', async () => {
  const lockPath = '/state/trailing.lock'
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  const child = new EventEmitter()
  child.pid = 902
  child.unref = () => {}
  const errors = []

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    process: { pid: 901, kill: () => true },
    error: (message) => errors.push(message),
    spawnDetached: () => child,
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  child.emit('spawn')
  const lockBeforeError = files.get(lockPath)
  const error = new Error('late child error')
  error.code = 'EIO'
  child.emit('error', error)

  assert.equal(files.get(lockPath), lockBeforeError)
  assert.deepEqual(errors, [])
})

test('notify re-registers the error listener for a once-only detached child', async () => {
  const lockPath = '/state/trailing.lock'
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  const events = new EventEmitter()
  const child = {
    pid: 902,
    unref: () => {},
    once: events.once.bind(events)
  }
  const errors = []

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    process: { pid: 901, kill: () => true },
    error: (message) => errors.push(message),
    spawnDetached: () => child,
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  events.emit('error', new Error('ENOENT: missing node'))
  events.emit('error', new Error('second spawn error'))

  assert.equal(files.has(lockPath), false)
  assert.deepEqual(errors, ['TokenBoard trailing notifier spawn failed: ENOENT: missing node'])
})

test('notify preserves diagnostics when spawn and cleanup errors have empty messages', () => {
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  let failedCleanup = false

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value) => files.set(path, String(value)),
    unlink: (path) => {
      if (memoryPathStartsWith(path, '/state/trailing.lock.release-') && !failedCleanup) {
        failedCleanup = true
        throw new Error('')
      }
      files.delete(path)
    },
    process: {
      pid: 904,
      kill: () => true
    },
    spawnDetached: () => {
      throw new Error('')
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, 'Error; trailing lock cleanup failed: Error')
})

test('notify reports trailing lock ownership read failures', () => {
  const files = memoryFileMap([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/trailing.lock', JSON.stringify({ pid: 902 })]
  ])

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => {
      if (sameMemoryPath(path, '/state/trailing.lock')) {
        const error = new Error('EACCES')
        error.code = 'EACCES'
        throw error
      }
      return files.get(path) || ''
    },
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => files.delete(path),
    process: {
      pid: 903,
      kill: () => true
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, 'EACCES')
  assert.equal(files.has('/state/trailing.lock'), true)
})

test('notify recovers a stale trailing lock through tasklist on legacy Windows Node', () => {
  const files = memoryFileMap([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/trailing.lock', JSON.stringify({ pid: 900 })]
  ])
  const spawned = []
  let tasklistCalls = 0
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => files.delete(path),
    process: { pid: 901, kill: () => true },
    platform: 'win32',
    nodeVersion: '22.12.0',
    runTasklist: () => {
      tasklistCalls += 1
      return { status: 0, stdout: 'INFO: no matching process\r\n' }
    },
    spawnDetached: () => {
      spawned.push('spawned')
      return { pid: 902, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.trailingScheduled, true)
  assert.equal(tasklistCalls, 1)
  assert.deepEqual(spawned, ['spawned'])
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 902)
})

test('notify replaces a trailing lock when the owner pid is reused', () => {
  const lockPath = '/state/trailing.lock'
  const files = memoryFileMap([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    [
      lockPath,
      JSON.stringify({
        pid: 901,
        token: 'old-owner',
        processStartIdentity: 'linux:boot-a:100'
      })
    ]
  ])
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => files.delete(path),
    process: { pid: 901, kill: () => true },
    processStartIdentity: 'linux:boot-b:200',
    platform: 'linux',
    spawnDetached: (_command, _args, options) => {
      spawned.push(options)
      return { pid: 902, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.trailingScheduled, true)
  assert.equal(spawned.length, 1)
  assert.equal(JSON.parse(files.get(lockPath)).pid, 902)
  assert.notEqual(JSON.parse(files.get(lockPath)).token, 'old-owner')
})

test('notify reclaims an identity-unknown same-pid trailing lock with a different token', () => {
  const lockPath = '/state/trailing.lock'
  const files = memoryFileMap([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    [lockPath, JSON.stringify({ pid: 901, token: 'old-owner' })]
  ])
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => files.delete(path),
    process: { pid: 901, kill: () => true },
    ownerToken: 'new-owner',
    spawnDetached: () => {
      spawned.push('spawned')
      return { pid: 902, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(spawned, ['spawned'])
  assert.notEqual(JSON.parse(files.get(lockPath)).token, 'old-owner')
})

test('notify reclaims a legacy pid-only lock when a normal hook reuses its pid', () => {
  const lockPath = '/state/trailing.lock'
  const files = memoryFileMap([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/notify.signal', `${JSON.stringify({ source: 'codex' })}\n`],
    [lockPath, JSON.stringify({ pid: 901 })]
  ])
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => files.delete(path),
    process: { pid: 901, kill: () => true },
    spawnDetached: () => {
      spawned.push('spawned')
      return { pid: 902, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(spawned, ['spawned'])
  assert.equal(JSON.parse(files.get(lockPath)).pid, 902)
})

test('legacy trailing continuation may retain a pid-only lock', () => {
  const lockPath = '/state/trailing.lock'
  const files = memoryFileMap([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/notify.signal', `${JSON.stringify({ source: 'codex' })}\n`],
    [lockPath, JSON.stringify({ pid: 901 })]
  ])
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    env: { TOKENBOARD_NOTIFY_TRAILING_LOCK_PATH: lockPath },
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => files.delete(path),
    process: { pid: 901, kill: () => true },
    trailingProcess: true,
    spawnDetached: () => {
      spawned.push('spawned')
      return { pid: 902, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(spawned, [])
  assert.equal(JSON.parse(files.get(lockPath)).pid, 901)
})

test('notify retries trailing lock acquisition when its owner releases the lock after EEXIST', () => {
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  let firstTrailingLockWrite = true
  const trailingLockAcquireFlags = []
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => {
      const value = files.get(path)
      if (value !== undefined) return value
      const error = new Error(`ENOENT: ${path}`)
      error.code = 'ENOENT'
      throw error
    },
    writeFile: (path, value, options = {}) => {
      if (sameMemoryPath(path, '/state/trailing.lock') && options.flag === 'wx') {
        trailingLockAcquireFlags.push(options.flag)
      }
      if (sameMemoryPath(path, '/state/trailing.lock') && options.flag === 'wx' && firstTrailingLockWrite) {
        firstTrailingLockWrite = false
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => files.delete(path),
    process: { pid: 903, kill: () => true },
    spawnDetached: () => {
      spawned.push('spawned')
      return { pid: 904, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(trailingLockAcquireFlags, ['wx', 'wx'])
  assert.deepEqual(spawned, ['spawned'])
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 904)
})

test('notify atomically publishes the trailing child process id without exposing partial JSON', () => {
  const lockPath = '/state/trailing.lock'
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  const writes = []
  let childOptions
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => {
      const value = files.get(path)
      if (value !== undefined) return value
      const error = new Error(`ENOENT: ${path}`)
      error.code = 'ENOENT'
      throw error
    },
    writeFile: (path, value, options = {}) => {
      writes.push({ path, options })
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
      if (!sameMemoryPath(path, lockPath) && files.has(lockPath)) {
        assert.doesNotThrow(() => JSON.parse(files.get(lockPath)))
      }
    },
    rename: (from, to) => {
      if (sameMemoryPath(to, lockPath)) {
        assert.match(from.replaceAll('\\', '/'), /^\/state\/trailing\.lock\.publish-/)
        assert.doesNotThrow(() => JSON.parse(files.get(from)))
        assert.doesNotThrow(() => JSON.parse(files.get(to)))
      }
      atomicMemoryFileOps(files).rename(from, to)
    },
    unlink: (path) => files.delete(path),
    process: { pid: 903, kill: () => true },
    processStartIdentity: 'linux:boot-a:100',
    platform: 'linux',
    readProcessStartIdentity: (pid) => ({ status: 'known', value: `linux:boot-a:${pid}` }),
    spawnDetached: (_command, _args, options) => {
      childOptions = options
      return { pid: 904, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.trailingScheduled, true)
  assert.equal(
    writes.filter(({ path }) => sameMemoryPath(path, lockPath)).every(({ options }) => options.flag === 'wx'),
    true
  )
  assert.equal(
    writes.some(({ path }) => memoryPathStartsWith(path, `${lockPath}.publish-`)),
    true
  )
  const published = JSON.parse(files.get(lockPath))
  assert.equal(published.pid, 904)
  assert.equal(published.startedAt, '2026-05-22T10:01:00.000Z')
  assert.match(published.token, /^[a-f0-9]{32}$/)
  assert.equal(published.processStartIdentity, 'linux:boot-a:904')
  assert.equal(childOptions.env.TOKENBOARD_NOTIFY_TRAILING_LOCK_TOKEN, published.token)
})

function atomicMemoryFileOps(files) {
  return {
    rename: (from, to) => {
      const value = files.get(from)
      if (value === undefined) {
        const error = new Error(`ENOENT: ${from}`)
        error.code = 'ENOENT'
        throw error
      }
      files.set(to, value)
      files.delete(from)
    },
    link: (from, to) => {
      const value = files.get(from)
      if (value === undefined) {
        const error = new Error(`ENOENT: ${from}`)
        error.code = 'ENOENT'
        throw error
      }
      if (files.has(to)) {
        const error = new Error(`EEXIST: ${to}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(to, value)
    }
  }
}
