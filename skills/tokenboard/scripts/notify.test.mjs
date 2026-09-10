import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  claimDispatchLock,
  defaultNotifyCooldownMs,
  executeTokenBoardSync,
  readNotifyCooldownMs,
  releaseDispatchLock,
  runNotify,
  runNotifyCli
} from './notify.mjs'
import { memoryFileMap, memoryPathStartsWith, sameMemoryPath } from './coordinator-test-helpers.mjs'

test('notify uses a fifteen-minute cooldown by default', () => {
  assert.equal(defaultNotifyCooldownMs, 900_000)
  assert.equal(readNotifyCooldownMs(undefined, {}), 900_000)
})

test('notify accepts an explicit bounded cooldown configuration', () => {
  assert.equal(readNotifyCooldownMs(undefined, { TOKENBOARD_NOTIFY_COOLDOWN_MS: '60000' }), 60_000)
  assert.equal(readNotifyCooldownMs(undefined, { TOKENBOARD_NOTIFY_COOLDOWN_MS: '3600000' }), 3_600_000)
})

test('notify carries its cooldown configuration into a trailing process', () => {
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  const spawned = []
  const env = { TOKENBOARD_NOTIFY_COOLDOWN_MS: '60000' }
  const result = runNotify({
    argv: ['--source', 'codex'],
    env,
    stateDir: '/state',
    ...memoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:00:30.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readdir: () => [],
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    spawnDetached: (command, args, options) => {
      spawned.push({ command, args, options })
      return { pid: 704, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.cooldownRemainingMs, 30_000)
  assert.equal(result.trailingScheduled, true)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].options.env.TOKENBOARD_NOTIFY_COOLDOWN_MS, '60000')
})

test('notify rejects invalid cooldown configuration', () => {
  for (const value of ['0', '59999', '3600001', '15m', '900000.5']) {
    assert.throws(
      () => readNotifyCooldownMs(undefined, { TOKENBOARD_NOTIFY_COOLDOWN_MS: value }),
      /TOKENBOARD_NOTIFY_COOLDOWN_MS/
    )
  }
})

test('notify leaves queued work intact when cooldown configuration is invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-notify-invalid-cooldown-'))
  const signalPath = join(root, 'notify.signal.d', 'codex.json')
  const errors = []

  try {
    await mkdir(join(root, 'notify.signal.d'), { recursive: true })
    await writeFile(signalPath, `${JSON.stringify({ source: 'codex' })}\n`)
    const exitCode = await runNotifyCli({
      env: {
        TOKENBOARD_CONFIG_DIR: root,
        TOKENBOARD_STATE_DIR: root,
        TOKENBOARD_NOTIFY_COOLDOWN_MS: 'invalid'
      },
      readConfig: () => ({ updatedAt: 'test-version' }),
      configDir: () => root,
      error: (message) => errors.push(message),
      runNotify: (options) => runNotify({ ...options, argv: ['--source', 'codex'] })
    })

    assert.equal(exitCode, 1)
    assert.deepEqual(errors, ['TOKENBOARD_NOTIFY_COOLDOWN_MS must be an integer number of milliseconds'])
    assert.match(await readFile(signalPath, 'utf8'), /"source":"codex"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify CLI reports an unrecovered coordinator error', async () => {
  const errors = []
  const exitCode = await runNotifyCli({
    env: { TOKENBOARD_CONFIG_DIR: '/state', TOKENBOARD_STATE_DIR: '/state' },
    readConfig: () => ({ updatedAt: 'test-version' }),
    configDir: () => '/state',
    error: (message) => errors.push(message),
    runNotify: () => ({ error: 'Invalid TokenBoard signal recovery journal', trailingScheduled: false })
  })

  assert.equal(exitCode, 1)
  assert.deepEqual(errors, ['Invalid TokenBoard signal recovery journal'])
})

test('notify CLI preserves and reports a malformed recovery journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-notify-recovery-journal-'))
  const journalPath = join(root, 'notify.signal.recovery.900.1.deadbeef.json')
  const errors = []

  try {
    await writeFile(journalPath, '{not-json}\n')
    const exitCode = await runNotifyCli({
      env: { TOKENBOARD_CONFIG_DIR: root, TOKENBOARD_STATE_DIR: root },
      readConfig: () => ({ updatedAt: 'test-version' }),
      configDir: () => root,
      error: (message) => errors.push(message),
      runNotify: (options) => runNotify({ ...options, argv: ['--source', 'codex'] })
    })

    assert.equal(exitCode, 1)
    assert.match(errors[0], /Invalid TokenBoard signal recovery journal/)
    assert.equal(await readFile(journalPath, 'utf8'), '{not-json}\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify CLI keeps a scheduled retry for a coordinator error', async () => {
  const errors = []
  const exitCode = await runNotifyCli({
    env: { TOKENBOARD_CONFIG_DIR: '/state', TOKENBOARD_STATE_DIR: '/state' },
    readConfig: () => ({ updatedAt: 'test-version' }),
    configDir: () => '/state',
    error: (message) => errors.push(message),
    runNotify: () => ({ error: 'lock timeout', trailingScheduled: true })
  })

  assert.equal(exitCode, 0)
  assert.deepEqual(errors, ['TokenBoard hook sync retry scheduled after error: lock timeout'])
})

test('notify passes the coordinator lock token to its child sync', () => {
  let invocation

  const result = executeTokenBoardSync('codex', {
    nodePath: '/usr/bin/node',
    syncScriptPath: '/repo/sync.mjs',
    env: { TOKENBOARD_STATE_DIR: '/state' },
    lockToken: 'coordinator-token',
    spawn: (command, args, options) => {
      invocation = { command, args, options }
      return { status: 0 }
    }
  })

  assert.deepEqual(result, { source: 'codex', exitCode: 0 })
  assert.equal(invocation.command, '/usr/bin/node')
  assert.deepEqual(invocation.args, ['/repo/sync.mjs', '--mode', 'sync', '--source', 'codex', '--hook'])
  assert.equal(invocation.options.env.TOKENBOARD_COORDINATOR_LOCK_HELD, '1')
  assert.equal(invocation.options.env.TOKENBOARD_COORDINATOR_LOCK_TOKEN, 'coordinator-token')
  assert.equal(invocation.options.env.TOKENBOARD_STATE_DIR, '/state')
})

test('notify refuses to start a hook sync without coordinator lock ownership', () => {
  assert.throws(
    () =>
      executeTokenBoardSync('codex', {
        spawn: () => {
          throw new Error('should not spawn')
        }
      }),
    /coordinator lock token is required/
  )
})

test('notify runs source-specific sync through coordinator', () => {
  const calls = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    cooldownMs: 0,
    mkdir: () => {},
    exists: () => false,
    readFile: () => {
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    },
    writeFile: () => {},
    unlink: () => {},
    executeSync: (trigger, lockToken) => {
      calls.push({ lockToken, trigger })
      return { source: trigger.source }
    }
  })

  assert.equal(result.skippedSync, false)
  assert.deepEqual(
    calls.map(({ trigger }) => trigger),
    [{ kind: 'notify', source: 'codex' }]
  )
  assert.match(calls[0].lockToken, /^[a-f0-9]{32}$/)
})

test('notify coalesces a pending signal through the fifteen-minute default cooldown', () => {
  const files = memoryFileMap([['/state/last-success.json', '2026-05-22T10:00:00.000Z']])
  const trailing = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...memoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readdir: () => [],
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    scheduleTrailing: (trigger, delayMs) => {
      trailing.push({ trigger, delayMs })
      return true
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.skippedReason, 'cooldown')
  assert.equal(result.cooldownRemainingMs, 840_000)
  assert.deepEqual(trailing, [{ trigger: { kind: 'notify', source: 'codex' }, delayMs: 840_000 }])
  assert.match(files.get('/state/notify.signal.d/codex.json'), /"source":"codex"/)
})

test('releaseDispatchLock only removes the matching dispatcher owner', () => {
  const workerPath = '/state/notify.dispatch.worker'
  const files = memoryFileMap([
    ['/state/notify.dispatch.lock', JSON.stringify({ pid: 10, token: 'owner-a' })],
    [workerPath, JSON.stringify({ pid: 11, token: 'owner-a' })]
  ])
  const fileOps = memoryFileOps(files)

  assert.equal(releaseDispatchLock('/state/notify.dispatch.lock', 'owner-b', { ...fileOps, workerPath }), false)
  assert.equal(files.has('/state/notify.dispatch.lock'), true)
  assert.equal(files.has(workerPath), true)
  assert.equal(releaseDispatchLock('/state/notify.dispatch.lock', 'owner-a', { ...fileOps, workerPath }), true)
  assert.equal(files.has('/state/notify.dispatch.lock'), false)
  assert.equal(files.has(workerPath), false)
})

test('notify releases dispatcher ownership when config loading fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-notify-dispatch-cleanup-'))
  const lockPath = join(root, 'notify.dispatch.lock')
  const token = 'test-owner'

  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }))
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./notify.mjs', import.meta.url)), '--source', 'codex'],
      {
        env: {
          ...process.env,
          TOKENBOARD_CONFIG_DIR: root,
          TOKENBOARD_STATE_DIR: root,
          TOKENBOARD_NOTIFY_DISPATCH_LOCK_PATH: lockPath,
          TOKENBOARD_NOTIFY_DISPATCH_LOCK_TOKEN: token
        }
      }
    )

    assert.equal(result.status, 1)
    assert.equal(existsSync(lockPath), false)
    assert.equal(existsSync(`${lockPath}.worker`), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify releases dispatcher ownership after a cooldown skip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-notify-dispatch-cooldown-'))
  const lockPath = join(root, 'notify.dispatch.lock')
  const token = 'test-owner'

  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({ updatedAt: new Date().toISOString() }))
    await writeFile(join(root, 'last-success.json'), new Date().toISOString())
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }))
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./notify.mjs', import.meta.url)), '--source', 'codex'],
      {
        env: {
          ...process.env,
          TOKENBOARD_CONFIG_DIR: root,
          TOKENBOARD_STATE_DIR: root,
          TOKENBOARD_NOTIFY_TRAILING_DELAY_MS: '1',
          TOKENBOARD_NOTIFY_DISPATCH_LOCK_PATH: lockPath,
          TOKENBOARD_NOTIFY_DISPATCH_LOCK_TOKEN: token
        }
      }
    )

    assert.equal(result.status, 0)
    assert.equal(existsSync(lockPath), false)
    assert.equal(existsSync(`${lockPath}.worker`), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify releases dispatcher ownership when a cooldown schedules trailing work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-notify-dispatch-trailing-'))
  const lockPath = join(root, 'notify.dispatch.lock')
  const trailingLockPath = join(root, 'trailing.lock')
  const token = 'test-owner'
  let trailingPid

  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({ updatedAt: new Date().toISOString() }))
    await writeFile(join(root, 'last-success.json'), new Date().toISOString())
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }))
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./notify.mjs', import.meta.url)), '--source', 'codex'],
      {
        env: {
          ...process.env,
          TOKENBOARD_CONFIG_DIR: root,
          TOKENBOARD_STATE_DIR: root,
          TOKENBOARD_NOTIFY_DISPATCH_LOCK_PATH: lockPath,
          TOKENBOARD_NOTIFY_DISPATCH_LOCK_TOKEN: token
        }
      }
    )

    trailingPid = JSON.parse(await readFile(trailingLockPath, 'utf8')).pid
    assert.equal(result.status, 0)
    assert.equal(existsSync(lockPath), false)
    assert.equal(existsSync(`${lockPath}.worker`), false)
  } finally {
    if (trailingPid) {
      try {
        process.kill(trailingPid, 'SIGTERM')
      } catch {}
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('dispatch worker claim stops when the foreground lock is replaced', () => {
  const files = memoryFileMap([['/state/notify.dispatch.lock', JSON.stringify({ pid: 10, token: 'owner-a' })]])
  const fileOps = memoryFileOps(files)
  const writeFile = (path, value) => {
    files.set(path, String(value))
    if (path.replaceAll('\\', '/').endsWith('.worker')) {
      files.set('/state/notify.dispatch.lock', JSON.stringify({ pid: 20, token: 'owner-b' }))
    }
  }

  assert.equal(
    claimDispatchLock('/state/notify.dispatch.lock', 'owner-a', {
      ...fileOps,
      writeFile,
      pid: 11,
      now: () => Date.parse('2026-05-22T10:00:00.000Z')
    }),
    false
  )
  assert.equal(files.has('/state/notify.dispatch.lock.worker'), false)
  assert.equal(JSON.parse(files.get('/state/notify.dispatch.lock')).token, 'owner-b')
})

test('dispatch worker claim records the current process start identity', () => {
  const lockPath = '/state/notify.dispatch.lock'
  const workerPath = `${lockPath}.worker`
  const files = memoryFileMap([[lockPath, JSON.stringify({ pid: 10, token: 'owner-a' })]])
  const fileOps = memoryFileOps(files)

  assert.equal(
    claimDispatchLock(lockPath, 'owner-a', {
      ...fileOps,
      writeFile: (path, value) => files.set(path, String(value)),
      workerPath,
      pid: process.pid,
      processStartIdentity: 'linux:test:123'
    }),
    true
  )
  assert.equal(JSON.parse(files.get(workerPath)).processStartIdentity, 'linux:test:123')
})

test('dispatch worker claim probes the current process identity when no identity is supplied', () => {
  const lockPath = '/state/notify.dispatch.lock'
  const workerPath = `${lockPath}.worker`
  const files = memoryFileMap([[lockPath, JSON.stringify({ pid: 10, token: 'owner-a' })]])
  const fileOps = memoryFileOps(files)

  assert.equal(
    claimDispatchLock(lockPath, 'owner-a', {
      ...fileOps,
      writeFile: (path, value) => files.set(path, String(value)),
      workerPath,
      pid: process.pid,
      readProcessStartIdentity: () => 'linux:test:456'
    }),
    true
  )
  assert.equal(JSON.parse(files.get(workerPath)).processStartIdentity, 'linux:test:456')
})

test('dispatch worker claim tolerates an unavailable automatic process identity probe', () => {
  const lockPath = '/state/notify.dispatch.lock'
  const workerPath = `${lockPath}.worker`
  const files = memoryFileMap([[lockPath, JSON.stringify({ pid: 10, token: 'owner-a' })]])
  const fileOps = memoryFileOps(files)

  assert.equal(
    claimDispatchLock(lockPath, 'owner-a', {
      ...fileOps,
      writeFile: (path, value) => files.set(path, String(value)),
      workerPath,
      pid: process.pid,
      platform: 'linux',
      nodeVersion: '24.0.0'
    }),
    true
  )
  assert.equal(Object.hasOwn(JSON.parse(files.get(workerPath)), 'processStartIdentity'), false)
})

test('dispatch worker claim does not overwrite a replacement marker with another pid', () => {
  const lockPath = '/state/notify.dispatch.lock'
  const workerPath = `${lockPath}.worker`
  const files = memoryFileMap([[lockPath, JSON.stringify({ pid: 10, token: 'owner-a' })]])
  const fileOps = memoryFileOps(files)
  let workerWrites = 0
  const writeFile = (path, value) => {
    files.set(path, String(value))
    if (sameMemoryPath(path, workerPath)) {
      workerWrites += 1
      if (workerWrites === 1) {
        files.set(
          workerPath,
          JSON.stringify({
            token: 'owner-a',
            pid: 99,
            startedAt: '2026-05-22T10:00:00.000Z',
            processStartIdentity: 'linux:replacement:99'
          })
        )
      }
    }
  }

  assert.equal(
    claimDispatchLock(lockPath, 'owner-a', {
      ...fileOps,
      writeFile,
      workerPath,
      pid: 11,
      processStartIdentity: 'linux:test:123'
    }),
    true
  )
  assert.deepEqual(JSON.parse(files.get(workerPath)), {
    token: 'owner-a',
    pid: 99,
    startedAt: '2026-05-22T10:00:00.000Z',
    processStartIdentity: 'linux:replacement:99'
  })
})

test('dispatch worker claim removes its marker when the lock recheck fails', () => {
  const lockPath = '/state/notify.dispatch.lock'
  const workerPath = `${lockPath}.worker`
  const files = memoryFileMap([[lockPath, JSON.stringify({ pid: 10, token: 'owner-a' })]])
  const fileOps = memoryFileOps(files)
  let lockReads = 0
  const readFile = (path) => {
    if (sameMemoryPath(path, lockPath)) {
      lockReads += 1
      if (lockReads === 2) {
        const error = new Error('dispatch lock read failed')
        error.code = 'EACCES'
        throw error
      }
    }
    return fileOps.readFile(path)
  }

  assert.throws(
    () =>
      claimDispatchLock(lockPath, 'owner-a', {
        ...fileOps,
        readFile,
        writeFile: (path, value) => files.set(path, String(value)),
        workerPath,
        pid: 11,
        now: () => Date.parse('2026-05-22T10:00:00.000Z')
      }),
    /dispatch lock read failed/
  )
  assert.equal(files.has(workerPath), false)
  assert.equal(files.has(lockPath), false)
})

test('dispatch worker claim releases the lock when the worker marker disappears during identity binding', () => {
  const lockPath = '/state/notify.dispatch.lock'
  const workerPath = `${lockPath}.worker`
  const files = memoryFileMap([[lockPath, JSON.stringify({ pid: 10, token: 'owner-a' })]])
  const fileOps = memoryFileOps(files)
  let workerRead = true
  const readFile = (path) => {
    if (sameMemoryPath(path, workerPath) && workerRead) {
      workerRead = false
      const error = new Error('worker marker disappeared')
      error.code = 'ENOENT'
      throw error
    }
    return fileOps.readFile(path)
  }

  assert.equal(
    claimDispatchLock(lockPath, 'owner-a', {
      ...fileOps,
      readFile,
      writeFile: (path, value) => files.set(path, String(value)),
      workerPath,
      pid: 11,
      processStartIdentity: 'linux:test:123'
    }),
    false
  )
  assert.equal(files.has(workerPath), false)
  assert.equal(files.has(lockPath), false)
})

test('dispatch worker claim preserves the primary error code when cleanup also fails', () => {
  const lockPath = '/state/notify.dispatch.lock'
  const workerPath = `${lockPath}.worker`
  const files = memoryFileMap([[lockPath, JSON.stringify({ pid: 10, token: 'owner-a' })]])
  const fileOps = memoryFileOps(files)
  let lockReads = 0
  const readFile = (path) => {
    if (sameMemoryPath(path, lockPath)) {
      lockReads += 1
      if (lockReads === 2) {
        const error = new Error('dispatch lock read failed')
        error.code = 'EACCES'
        throw error
      }
    }
    return fileOps.readFile(path)
  }
  const rename = (from, to) => {
    if (sameMemoryPath(from, lockPath)) {
      const error = new Error('dispatch lock cleanup failed')
      error.code = 'EPERM'
      throw error
    }
    return fileOps.rename(from, to)
  }

  assert.throws(
    () =>
      claimDispatchLock(lockPath, 'owner-a', {
        ...fileOps,
        readFile,
        rename,
        writeFile: (path, value) => files.set(path, String(value)),
        workerPath,
        pid: 11,
        now: () => Date.parse('2026-05-22T10:00:00.000Z')
      }),
    (error) => {
      assert.equal(error instanceof AggregateError, true)
      assert.equal(error.code, 'EACCES')
      assert.equal(error.errors[0].code, 'EACCES')
      assert.equal(error.errors[1].code, 'EPERM')
      return true
    }
  )
  assert.equal(files.has(workerPath), false)
  assert.equal(files.has(lockPath), true)
})

test('dispatch worker claim preserves a cleanup error when the primary failure is ENOENT', () => {
  const lockPath = '/state/notify.dispatch.lock'
  const workerPath = `${lockPath}.worker`
  const files = memoryFileMap([[lockPath, JSON.stringify({ pid: 10, token: 'owner-a' })]])
  const fileOps = memoryFileOps(files)
  let workerRead = true
  const readFile = (path) => {
    if (sameMemoryPath(path, workerPath) && workerRead) {
      workerRead = false
      const error = new Error('worker marker disappeared')
      error.code = 'ENOENT'
      throw error
    }
    return fileOps.readFile(path)
  }
  const rename = (from, to) => {
    if (sameMemoryPath(from, lockPath)) {
      const error = new Error('dispatch lock cleanup failed')
      error.code = 'EPERM'
      throw error
    }
    return fileOps.rename(from, to)
  }

  assert.throws(
    () =>
      claimDispatchLock(lockPath, 'owner-a', {
        ...fileOps,
        readFile,
        rename,
        writeFile: (path, value) => files.set(path, String(value)),
        workerPath,
        pid: 11,
        processStartIdentity: 'linux:test:123'
      }),
    (error) => {
      assert.equal(error instanceof AggregateError, true)
      assert.equal(error.code, 'EPERM')
      assert.equal(error.errors[0].code, 'ENOENT')
      assert.equal(error.errors[1].code, 'EPERM')
      return true
    }
  )
  assert.equal(files.has(workerPath), false)
  assert.equal(files.has(lockPath), true)
})

test('releaseDispatchLock preserves a newer worker marker', () => {
  const files = memoryFileMap([
    ['/state/notify.dispatch.lock', JSON.stringify({ pid: 20, token: 'owner-b' })],
    ['/state/notify.dispatch.lock.worker', JSON.stringify({ pid: 21, token: 'owner-b' })]
  ])
  const fileOps = memoryFileOps(files)

  assert.equal(releaseDispatchLock('/state/notify.dispatch.lock', 'owner-a', fileOps), false)
  assert.equal(JSON.parse(files.get('/state/notify.dispatch.lock')).token, 'owner-b')
  assert.equal(JSON.parse(files.get('/state/notify.dispatch.lock.worker')).token, 'owner-b')
})

test('releaseDispatchLock preserves a replacement created after it quarantines its lock', () => {
  const lockPath = '/state/notify.dispatch.lock'
  const workerPath = `${lockPath}.worker`
  const files = memoryFileMap([
    [lockPath, JSON.stringify({ pid: 10, token: 'owner-a' })],
    [workerPath, JSON.stringify({ pid: 11, token: 'owner-a' })]
  ])
  const fileOps = memoryFileOps(files)
  const rename = (from, to) => {
    fileOps.rename(from, to)
    if (sameMemoryPath(from, lockPath)) {
      files.set(lockPath, JSON.stringify({ pid: 20, token: 'owner-b' }))
      files.set(workerPath, JSON.stringify({ pid: 21, token: 'owner-b' }))
    }
  }

  assert.equal(releaseDispatchLock(lockPath, 'owner-a', { ...fileOps, rename, workerPath }), true)
  assert.equal(JSON.parse(files.get(lockPath)).token, 'owner-b')
  assert.equal(JSON.parse(files.get(workerPath)).token, 'owner-b')
})

test('releaseDispatchLock cleans the worker marker when foreground lock cleanup fails', () => {
  const lockPath = '/state/notify.dispatch.lock'
  const workerPath = `${lockPath}.worker`
  const files = memoryFileMap([
    [lockPath, JSON.stringify({ pid: 10, token: 'owner-a' })],
    [workerPath, JSON.stringify({ pid: 11, token: 'owner-a' })]
  ])
  const fileOps = memoryFileOps(files)
  const rename = (from, to) => {
    if (sameMemoryPath(from, lockPath)) {
      const error = new Error('dispatch lock cleanup failed')
      error.code = 'EACCES'
      throw error
    }
    return fileOps.rename(from, to)
  }

  assert.throws(
    () => releaseDispatchLock(lockPath, 'owner-a', { ...fileOps, workerPath, rename }),
    /dispatch lock cleanup failed/
  )
  assert.equal(files.has(lockPath), true)
  assert.equal(files.has(workerPath), false)
})

test('trailing notifier preserves a replacement lock during cleanup', async () => {
  const stateDir = '/state'
  const lockPath = join(stateDir, 'trailing.lock')
  const replacement = JSON.stringify({ pid: 902, token: 'replacement' })
  const files = memoryFileMap([[lockPath, JSON.stringify({ pid: 901, token: 'owner-a' })]])
  let replaced = false
  const replaceOwner = () => {
    if (replaced) return
    replaced = true
    files.set(lockPath, replacement)
  }
  const runtime = {
    stateDir,
    configDir: stateDir,
    now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    process: { pid: 901, kill: () => true },
    ownerToken: 'owner-a',
    readFile: (path) => readMemoryFile(files, path),
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

  const exitCode = await runNotifyCli({
    env: {
      TOKENBOARD_CONFIG_DIR: stateDir,
      TOKENBOARD_STATE_DIR: stateDir,
      TOKENBOARD_NOTIFY_TRAILING_LOCK_PATH: lockPath
    },
    configDir: () => stateDir,
    readConfig: () => ({ updatedAt: 'test-version' }),
    trailingRuntime: runtime,
    waitTrailingDelay: async () => {},
    runNotify: () => ({ trailingScheduled: false })
  })

  assert.equal(exitCode, 0)
  assert.equal(files.get(lockPath), replacement)
})

test('notify CLI fails when trailing lock cleanup fails', async () => {
  const stateDir = '/state/notify-trailing-cleanup'
  const errors = []
  const exitCode = await runNotifyCli({
    env: { TOKENBOARD_CONFIG_DIR: stateDir, TOKENBOARD_STATE_DIR: stateDir },
    readConfig: () => ({ updatedAt: 'test-version' }),
    configDir: () => stateDir,
    error: (message) => errors.push(message),
    runNotify: () => ({ trailingScheduled: false }),
    trailingRuntime: {
      process: { pid: 101 },
      ownerToken: 'owner-a',
      readFile: () => JSON.stringify({ pid: 101, token: 'owner-a' })
    },
    releaseDispatchLock: () => true
  })

  assert.equal(exitCode, 0)
  assert.deepEqual(errors, [])

  const cleanupErrors = []
  const failedExitCode = await runNotifyCli({
    env: {
      TOKENBOARD_CONFIG_DIR: stateDir,
      TOKENBOARD_STATE_DIR: stateDir,
      TOKENBOARD_NOTIFY_TRAILING_LOCK_PATH: `${stateDir}/trailing.lock`
    },
    readConfig: () => ({ updatedAt: 'test-version' }),
    configDir: () => stateDir,
    error: (message) => cleanupErrors.push(message),
    runNotify: () => ({ trailingScheduled: false }),
    trailingRuntime: {
      process: { pid: 101 },
      ownerToken: 'owner-a',
      readFile: () => JSON.stringify({ pid: 101, token: 'owner-a' })
    },
    releaseDispatchLock: () => true
  })

  assert.equal(failedExitCode, 1)
  assert.deepEqual(cleanupErrors, [
    'TokenBoard trailing lock cleanup failed: TokenBoard trailing lock cleanup requires atomic rename and link operations'
  ])
})

test('notify CLI fails when dispatch lock cleanup fails', async () => {
  const errors = []
  const exitCode = await runNotifyCli({
    env: { TOKENBOARD_CONFIG_DIR: '/state', TOKENBOARD_STATE_DIR: '/state' },
    readConfig: () => ({ updatedAt: 'test-version' }),
    configDir: () => '/state',
    error: (message) => errors.push(message),
    runNotify: () => ({ trailingScheduled: false }),
    claimDispatchLock: () => true,
    releaseDispatchLock: () => {
      throw new Error('dispatch cleanup failed')
    }
  })

  assert.equal(exitCode, 1)
  assert.deepEqual(errors, ['TokenBoard dispatch lock cleanup failed: dispatch cleanup failed'])
})

test('notify hides the sync child process on Windows', () => {
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    cooldownMs: 0,
    mkdir: () => {},
    exists: () => false,
    readFile: () => {
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    },
    writeFile: () => {},
    unlink: () => {},
    spawn: (command, args, options) => {
      spawned.push({ command, args, options })
      return { status: 0, stderr: '' }
    }
  })

  assert.equal(result.skippedSync, false)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].options.windowsHide, true)
})

test('notify replaces malformed trailing lock during cooldown', () => {
  const files = memoryFileMap([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/trailing.lock', '{ invalid json']
  ])
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...memoryFileOps(files),
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
    process: {
      pid: 503,
      kill: () => true
    },
    spawnDetached: (command, args, options) => {
      spawned.push({ command, args, options })
      return { pid: 704, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.trailingScheduled, true)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].options.windowsHide, true)
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 704)
})

test('notify replaces a trailing lock with an invalid numeric pid during cooldown', () => {
  const stateDir = '/state/notify-invalid-pid'
  const trailingLockPath = `${stateDir}/trailing.lock`
  const files = memoryFileMap([
    [`${stateDir}/last-success.json`, '2026-05-22T10:00:00.000Z'],
    [trailingLockPath, JSON.stringify({ pid: -1 })]
  ])
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir,
    ...memoryFileOps(files),
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
    process: {
      pid: 503,
      kill: () => true
    },
    spawnDetached: (command, args, options) => {
      spawned.push({ command, args, options })
      return { pid: 704, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.trailingScheduled, true)
  assert.equal(spawned.length, 1)
  assert.equal(JSON.parse(files.get(trailingLockPath)).pid, 704)
})

test('trailing process retains its lock when pending signals remain in cooldown', () => {
  const files = memoryFileMap([
    ['/state/last-success.json', '2026-05-22T10:02:00.000Z'],
    ['/state/notify.signal', `${JSON.stringify({ source: 'codex' })}\n`],
    ['/state/trailing.lock', JSON.stringify({ pid: 800, token: 'owner-a' })]
  ])
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...memoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:03:00.000Z'),
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
    process: {
      pid: 800,
      kill: () => true
    },
    ownerToken: 'owner-a',
    trailingProcess: true,
    spawnDetached: () => {
      spawned.push('spawned')
      return { pid: 801, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.skippedReason, 'cooldown')
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(spawned, [])
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 800)
})

test('trailing CLI waits under its existing lock and completes pending work without spawning again', async () => {
  const stateDir = '/state'
  const trailingLockPath = join(stateDir, 'trailing.lock')
  let nowMs = Date.parse('2026-05-22T10:00:05.000Z')
  const files = memoryFileMap([
    [join(stateDir, 'last-success.json'), '2026-05-22T10:00:00.000Z'],
    [join(stateDir, 'notify.signal'), `${JSON.stringify({ source: 'codex' })}\n`],
    [trailingLockPath, JSON.stringify({ pid: 800, token: 'owner-a' })]
  ])
  const waits = []
  const spawned = []
  const synced = []
  const readFile = (path) => {
    if (!files.has(path)) {
      const error = new Error(`ENOENT: ${path}`)
      error.code = 'ENOENT'
      throw error
    }
    return files.get(path)
  }
  const writeFile = (path, value, options = {}) => {
    if (options.flag === 'wx' && files.has(path)) {
      const error = new Error(`EEXIST: ${path}`)
      error.code = 'EEXIST'
      throw error
    }
    files.set(path, String(value))
  }
  const runtime = {
    stateDir,
    configDir: stateDir,
    now: () => nowMs,
    process: { pid: 800, kill: () => true },
    ownerToken: 'owner-a',
    readFile,
    writeFile,
    unlink: (path) => files.delete(path),
    rename: memoryFileOps(files).rename,
    link: memoryFileOps(files).link
  }

  const exitCode = await runNotifyCli({
    env: {
      TOKENBOARD_CONFIG_DIR: stateDir,
      TOKENBOARD_STATE_DIR: stateDir,
      TOKENBOARD_NOTIFY_TRAILING_LOCK_PATH: trailingLockPath,
      TOKENBOARD_NOTIFY_TRAILING_LOCK_TOKEN: 'owner-a',
      TOKENBOARD_NOTIFY_TRAILING_DELAY_MS: '0'
    },
    readConfig: () => ({ updatedAt: 'test-version' }),
    configDir: () => stateDir,
    trailingRuntime: runtime,
    waitTrailingDelay: async (delayMs) => {
      waits.push(delayMs)
      nowMs += Math.max(0, delayMs)
    },
    runNotify: (options) =>
      runNotify({
        ...options,
        argv: ['--source', 'codex'],
        cooldownMs: 10_000,
        now: () => nowMs,
        mkdir: () => {},
        exists: (path) => files.has(path),
        readFile,
        writeFile,
        unlink: (path) => files.delete(path),
        rename: memoryFileOps(files).rename,
        link: memoryFileOps(files).link,
        process: runtime.process,
        spawnDetached: () => {
          spawned.push('spawned')
          return { pid: 801, unref: () => {} }
        },
        executeSync: (trigger) => {
          synced.push(trigger.source)
          return { source: trigger.source }
        }
      })
  })

  assert.equal(exitCode, 0)
  assert.deepEqual(waits, [0, 5_000])
  assert.deepEqual(synced, ['codex'])
  assert.deepEqual(spawned, [])
  assert.equal(files.has(trailingLockPath), false)
})

test('trailing CLI does not spin when a continuation reports zero delay', async () => {
  const stateDir = '/state'
  const trailingLockPath = join(stateDir, 'trailing.lock')
  const files = memoryFileMap([[trailingLockPath, JSON.stringify({ pid: 800, token: 'owner-a' })]])
  const waits = []
  const runtime = {
    stateDir,
    configDir: stateDir,
    process: { pid: 800, kill: () => true },
    ownerToken: 'owner-a',
    readFile: memoryFileOps(files).readFile,
    writeFile: (path, value) => files.set(path, String(value)),
    unlink: (path) => files.delete(path),
    rename: memoryFileOps(files).rename,
    link: memoryFileOps(files).link
  }

  const exitCode = await runNotifyCli({
    env: {
      TOKENBOARD_CONFIG_DIR: stateDir,
      TOKENBOARD_STATE_DIR: stateDir,
      TOKENBOARD_NOTIFY_TRAILING_LOCK_PATH: trailingLockPath,
      TOKENBOARD_NOTIFY_TRAILING_LOCK_TOKEN: 'owner-a',
      TOKENBOARD_NOTIFY_TRAILING_DELAY_MS: '0'
    },
    readConfig: () => ({ updatedAt: 'test-version' }),
    configDir: () => stateDir,
    trailingRuntime: runtime,
    waitTrailingDelay: async (delayMs) => waits.push(delayMs),
    runNotify: () => ({ trailingScheduled: true, trailingDelayMs: 0 })
  })

  assert.equal(exitCode, 0)
  assert.deepEqual(waits, [0])
  assert.equal(files.has(trailingLockPath), false)
})

function memoryFileOps(files) {
  return {
    readFile: (path) => {
      const value = files.get(path)
      if (value !== undefined) return value
      const error = new Error(`ENOENT: ${path}`)
      error.code = 'ENOENT'
      throw error
    },
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
    },
    unlink: (path) => removeMemoryFile(files, path)
  }
}

function readMemoryFile(files, path) {
  const value = files.get(path)
  if (value !== undefined) return value
  const error = new Error(`ENOENT: ${path}`)
  error.code = 'ENOENT'
  throw error
}

function moveMemoryFile(files, from, to) {
  const value = readMemoryFile(files, from)
  files.set(to, value)
  files.delete(from)
}

function linkMemoryFile(files, from, to) {
  if (files.has(to)) {
    const error = new Error(`EEXIST: ${to}`)
    error.code = 'EEXIST'
    throw error
  }
  files.set(to, readMemoryFile(files, from))
}

function removeMemoryFile(files, path) {
  if (!files.has(path)) {
    const error = new Error(`ENOENT: ${path}`)
    error.code = 'ENOENT'
    throw error
  }
  files.delete(path)
}
