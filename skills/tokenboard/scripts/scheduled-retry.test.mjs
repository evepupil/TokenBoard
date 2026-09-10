import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireLock, releaseLock } from './coordinator-lock.mjs'
import {
  runScheduledRetry,
  scheduledRetryLegacyLockPath,
  scheduledRetryLegacyStatePath,
  scheduledRetryLockPath,
  scheduledRetryStatePath,
  scheduledRetryTransitionLockPath
} from './scheduled-retry.mjs'
import { runSyncInvocation } from './sync.mjs'
import {
  memoryFileMap,
  memoryPathSet,
  memoryPathStartsWith,
  normalizeMemoryPath,
  sameMemoryPath
} from './coordinator-test-helpers.mjs'

test('scheduled retry records deferred lock contention and then completion', () => {
  const fs = memoryRuntime()
  let calls = 0

  const result = runScheduledRetry({
    stateDir: '/state',
    source: 'all',
    runtime: fs.runtime,
    maxAttempts: 2,
    delayMs: 250,
    runAttempt: ({ attempt }) => {
      calls += 1
      if (attempt === 1) throw lockTimeout()
      return 0
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: false, attempts: 2 })
  assert.equal(calls, 2)
  assert.deepEqual(fs.sleeps, [250])
  assert.equal(fs.files.has('/state/scheduled-sync-retry.lock'), false)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath('/state')), false)
  assert.deepEqual(JSON.parse(fs.files.get(scheduledRetryStatePath('/state'))), {
    schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
    source: 'all',
    status: 'completed',
    retryAttempt: 2,
    maxAttempts: 2,
    updatedAt: '2026-07-29T00:00:00.250Z'
  })
})

test('scheduled retry stops after its bounded lock-timeout budget', () => {
  const fs = memoryRuntime()
  let calls = 0

  const result = runScheduledRetry({
    stateDir: '/state',
    source: 'all',
    runtime: fs.runtime,
    maxAttempts: 2,
    delayMs: 10,
    runAttempt: () => {
      calls += 1
      throw lockTimeout()
    }
  })

  assert.deepEqual(result, { exitCode: 1, skipped: false, attempts: 2, exhausted: true })
  assert.equal(calls, 2)
  assert.deepEqual(fs.sleeps, [10])
  assert.equal(fs.files.has('/state/scheduled-sync-retry.lock'), false)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath('/state')), false)
  const state = JSON.parse(fs.files.get(scheduledRetryStatePath('/state')))
  assert.equal(state.status, 'exhausted')
  assert.equal(state.retryAttempt, 2)
  assert.match(state.error, /Timed out waiting for TokenBoard sync lock/)
})

test('scheduled retry stops immediately on a real collector failure', () => {
  const fs = memoryRuntime()

  const result = runScheduledRetry({
    stateDir: '/state',
    source: 'all',
    runtime: fs.runtime,
    runAttempt: () => 17
  })

  assert.deepEqual(result, { exitCode: 17, skipped: false, attempts: 1 })
  assert.deepEqual(fs.sleeps, [])
  assert.equal(JSON.parse(fs.files.get(scheduledRetryStatePath('/state'))).status, 'failed')
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath('/state')), false)
})

test('scheduled retry writes a failure state before rethrowing an infrastructure error', () => {
  const fs = memoryRuntime()

  assert.throws(
    () =>
      runScheduledRetry({
        stateDir: '/state',
        source: 'all',
        runtime: fs.runtime,
        runAttempt: () => {
          throw new Error('config unreadable')
        }
      }),
    /config unreadable/
  )

  const state = JSON.parse(fs.files.get(scheduledRetryStatePath('/state')))
  assert.equal(state.status, 'failed')
  assert.equal(state.retryAttempt, 1)
  assert.equal(state.error, 'config unreadable')
  assert.equal(fs.files.has('/state/scheduled-sync-retry.lock'), false)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath('/state')), false)
})

test('scheduled retry cleans the all-source primary lock when transition cleanup fails', () => {
  const fs = memoryRuntime()
  const transitionPath = scheduledRetryTransitionLockPath('/state')
  const unlink = fs.runtime.unlink

  assert.throws(
    () =>
      runScheduledRetry({
        stateDir: '/state',
        source: 'all',
        runtime: {
          ...fs.runtime,
          unlink: (path) => {
            if (memoryPathStartsWith(path, `${transitionPath}.release-`)) {
              throw new Error('transition release failed')
            }
            unlink(path)
          }
        },
        runAttempt: () => 0
      }),
    /transition release failed/
  )

  assert.equal(fs.files.has(scheduledRetryLockPath('/state')), false)
  assert.equal(fs.files.has(scheduledRetryLockPath('/state', 'codex')), false)
  assert.equal(fs.files.has(scheduledRetryLockPath('/state', 'claude-code')), false)
})

test('scheduled retry preserves its legacy marker ownership when transition cleanup is contended', () => {
  const fs = memoryRuntime()
  const stateDir = '/state/scheduled-retry-transition-contention'
  const transitionPath = scheduledRetryTransitionLockPath(stateDir)
  const legacyPath = scheduledRetryLegacyLockPath(stateDir)
  let competingOwner
  let firstMarker

  assert.throws(
    () =>
      runScheduledRetry({
        stateDir,
        source: 'codex',
        runtime: fs.runtime,
        runAttempt: () => {
          competingOwner = acquireLock(transitionPath, fs.runtime)
          assert.ok(competingOwner)
          firstMarker = readOnlyLegacyMarker(fs, legacyPath)
          return 0
        }
      }),
    /could not acquire the transition lock/
  )

  assert.ok(firstMarker)
  assert.equal(fs.directories.has(legacyPath), true)
  assert.deepEqual(readOnlyLegacyMarker(fs, legacyPath), firstMarker)
  assert.equal(JSON.parse(fs.files.get(scheduledRetryStatePath(stateDir, 'codex'))).status, 'failed')

  assert.equal(releaseLock(transitionPath, fs.runtime, competingOwner), true)
  const secondResult = runScheduledRetry({
    stateDir,
    source: 'codex',
    runtime: fs.runtime,
    runAttempt: () => {
      assert.deepEqual(readOnlyLegacyMarker(fs, legacyPath), firstMarker)
      return 0
    }
  })

  assert.deepEqual(secondResult, { exitCode: 0, skipped: false, attempts: 1 })
  assert.equal(fs.directories.has(legacyPath), false)
})

test('scheduled retry coalesces while another retry loop owns its lock', () => {
  const fs = memoryRuntime({
    '/state/scheduled-sync-retry.lock': JSON.stringify({
      pid: 999,
      startedAt: '2026-07-29T00:00:00.000Z',
      token: 'other-retry'
    })
  })
  let collected = false

  const result = runScheduledRetry({
    stateDir: '/state',
    source: 'all',
    runtime: fs.runtime,
    runAttempt: () => {
      collected = true
      return 0
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: true, skippedReason: 'active-retry', attempts: 0 })
  assert.equal(collected, false)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath('/state')), false)
})

test('scheduled retry respects an active legacy lock while preserving source isolation', () => {
  const stateDir = '/state/scheduled-retry-active-legacy'
  const fs = memoryRuntime({
    [scheduledRetryLegacyLockPath(stateDir)]: JSON.stringify({
      pid: 999,
      startedAt: '2026-07-29T00:00:00.000Z',
      token: 'legacy-retry'
    })
  })
  let collected = false

  const result = runScheduledRetry({
    stateDir,
    source: 'codex',
    runtime: fs.runtime,
    runAttempt: () => {
      collected = true
      return 0
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: true, skippedReason: 'active-legacy-retry', attempts: 0 })
  assert.equal(collected, false)
  assert.equal(fs.files.has(scheduledRetryLockPath(stateDir, 'codex')), false)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath(stateDir)), false)
  assert.equal(fs.files.has(scheduledRetryLegacyLockPath(stateDir)), true)
})

test('scheduled retry leaves an active legacy lock untouched when the legacy fence blocks a source retry', () => {
  const stateDir = '/state/scheduled-retry-source-blocked'
  const fs = memoryRuntime({
    [scheduledRetryLegacyLockPath(stateDir)]: JSON.stringify({
      pid: 999,
      startedAt: '2026-07-29T00:00:00.000Z',
      token: 'stale-legacy-retry'
    })
  })

  const result = runScheduledRetry({
    stateDir,
    source: 'codex',
    runtime: fs.runtime,
    runAttempt: () => {
      throw new Error('legacy retry must win')
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: true, skippedReason: 'active-legacy-retry', attempts: 0 })
  assert.equal(fs.files.has(scheduledRetryLegacyLockPath(stateDir)), true)
  assert.equal(fs.files.has(scheduledRetryLockPath(stateDir, 'codex')), false)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath(stateDir)), false)
})

test('scheduled retry reports unknown legacy fence entries instead of silently skipping all sources', () => {
  const stateDir = '/state/scheduled-retry-corrupt-legacy-fence'
  const legacyPath = scheduledRetryLegacyLockPath(stateDir)
  const fs = memoryRuntime(
    {},
    {
      files: memoryFileMap([[join(legacyPath, 'unexpected.tmp'), 'leftover']]),
      directories: memoryPathSet([legacyPath])
    }
  )
  let collected = false

  assert.throws(
    () =>
      runScheduledRetry({
        stateDir,
        source: 'all',
        runtime: fs.runtime,
        runAttempt: () => {
          collected = true
          return 0
        }
      }),
    (error) => {
      assert.equal(error.code, 'TOKENBOARD_LEGACY_RETRY_FENCE_CORRUPTED')
      assert.match(error.message, /unexpected entries "unexpected\.tmp"/)
      return true
    }
  )

  assert.equal(collected, false)
  assert.equal(fs.directories.has(legacyPath), true)
  assert.equal(fs.files.has(join(legacyPath, 'unexpected.tmp')), true)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath(stateDir)), false)
  assert.equal(fs.files.has(scheduledRetryLockPath(stateDir, 'codex')), false)
})

test('scheduled retry reports unknown legacy fence entries for a source-specific retry', () => {
  const stateDir = '/state/scheduled-retry-corrupt-source-fence'
  const legacyPath = scheduledRetryLegacyLockPath(stateDir)
  const fs = memoryRuntime(
    {},
    {
      files: memoryFileMap([[join(legacyPath, 'unexpected.tmp'), 'leftover']]),
      directories: memoryPathSet([legacyPath])
    }
  )

  assert.throws(
    () =>
      runScheduledRetry({
        stateDir,
        source: 'codex',
        runtime: fs.runtime,
        runAttempt: () => 0
      }),
    (error) => {
      assert.equal(error.code, 'TOKENBOARD_LEGACY_RETRY_FENCE_CORRUPTED')
      return true
    }
  )

  assert.equal(fs.directories.has(legacyPath), true)
  assert.equal(fs.files.has(join(legacyPath, 'unexpected.tmp')), true)
  assert.equal(fs.files.has(scheduledRetryLockPath(stateDir, 'codex')), false)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath(stateDir)), false)
})

for (const source of ['all', 'codex']) {
  test(`scheduled retry preserves a corrupted legacy marker for ${source}`, () => {
    const stateDir = `/state/scheduled-retry-corrupt-marker-${source}`
    const legacyPath = scheduledRetryLegacyLockPath(stateDir)
    const markerPath = join(legacyPath, 'source-999-truncated.json')
    const fs = memoryRuntime(
      {},
      {
        files: memoryFileMap([[markerPath, '{"pid":999']]),
        directories: memoryPathSet([legacyPath])
      }
    )

    assert.throws(
      () =>
        runScheduledRetry({
          stateDir,
          source,
          runtime: fs.runtime,
          runAttempt: () => 0
        }),
      (error) => {
        assert.equal(error.code, 'TOKENBOARD_LEGACY_RETRY_FENCE_CORRUPTED')
        assert.match(error.message, /corrupted marker files "source-999-truncated\.json"/)
        return true
      }
    )

    assert.equal(fs.directories.has(legacyPath), true)
    assert.equal(fs.files.has(markerPath), true)
    assert.equal(fs.files.has(scheduledRetryLockPath(stateDir, source)), false)
    assert.equal(fs.files.has(scheduledRetryTransitionLockPath(stateDir)), false)
  })
}

test('all-source retry keeps a live marker whose start identity was unavailable', () => {
  const stateDir = '/state/scheduled-retry-unknown-marker-identity'
  const legacyPath = scheduledRetryLegacyLockPath(stateDir)
  const markerPath = join(legacyPath, 'source-999-unknown.json')
  const fs = memoryRuntime(
    {},
    {
      files: memoryFileMap([[markerPath, JSON.stringify({ pid: 999, token: 'unknown-identity' })]]),
      directories: memoryPathSet([legacyPath]),
      readProcessStartIdentity: () => 'linux:known-identity',
      kill: () => true
    }
  )

  const result = runScheduledRetry({
    stateDir,
    source: 'all',
    runtime: fs.runtime,
    runAttempt: () => {
      throw new Error('live marker must block the retry')
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: true, skippedReason: 'active-legacy-retry', attempts: 0 })
  assert.equal(fs.directories.has(legacyPath), true)
  assert.equal(fs.files.has(markerPath), true)
})

test('all-source retry keeps an unidentifiable live marker that shares its pid', () => {
  const stateDir = '/state/scheduled-retry-unknown-current-pid'
  const legacyPath = scheduledRetryLegacyLockPath(stateDir)
  const markerPath = join(legacyPath, 'source-101-unknown.json')
  const fs = memoryRuntime(
    {},
    {
      files: memoryFileMap([[markerPath, JSON.stringify({ pid: 101, token: 'unknown-current-pid' })]]),
      directories: memoryPathSet([legacyPath]),
      readProcessStartIdentity: () => ({ status: 'unknown' }),
      kill: () => true
    }
  )

  const result = runScheduledRetry({
    stateDir,
    source: 'all',
    runtime: fs.runtime,
    runAttempt: () => {
      throw new Error('unidentifiable live marker must block the retry')
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: true, skippedReason: 'active-legacy-retry', attempts: 0 })
  assert.equal(fs.directories.has(legacyPath), true)
  assert.equal(fs.files.has(markerPath), true)
})

test('source retry omits an unavailable process start identity from its marker', () => {
  const fs = memoryRuntime()
  const stateDir = '/state/scheduled-retry-omit-unknown-identity'
  const legacyPath = scheduledRetryLegacyLockPath(stateDir)
  delete fs.runtime.processStartIdentity
  fs.runtime.readProcessStartIdentity = () => ({ status: 'unknown' })

  const result = runScheduledRetry({
    stateDir,
    source: 'codex',
    runtime: fs.runtime,
    runAttempt: () => {
      const marker = readOnlyLegacyMarker(fs, legacyPath)
      assert.equal(Object.hasOwn(marker, 'processStartIdentity'), false)
      return 0
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: false, attempts: 1 })
  assert.equal(fs.directories.has(legacyPath), false)
})

test('source retry holds a legacy compatibility lock for its whole lifecycle', () => {
  const fs = memoryRuntime()
  const stateDir = '/state/scheduled-retry-legacy-lifecycle'
  let lockObservedDuringAttempt = false
  let transitionLock
  let sourceLock
  const writeFile = fs.runtime.writeFile

  const result = runScheduledRetry({
    stateDir,
    source: 'codex',
    runtime: {
      ...fs.runtime,
      writeFile: (path, value, options) => {
        writeFile(path, value, options)
        if (sameMemoryPath(path, scheduledRetryTransitionLockPath(stateDir))) {
          transitionLock = JSON.parse(String(value))
        }
      }
    },
    runAttempt: () => {
      lockObservedDuringAttempt = fs.directories.has(scheduledRetryLegacyLockPath(stateDir))
      sourceLock = JSON.parse(fs.files.get(scheduledRetryLockPath(stateDir, 'codex')))
      return 0
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: false, attempts: 1 })
  assert.equal(lockObservedDuringAttempt, true)
  assert.equal(transitionLock.processStartIdentity, fs.runtime.processStartIdentity)
  assert.equal(sourceLock.processStartIdentity, fs.runtime.processStartIdentity)
  assert.equal(fs.directories.has(scheduledRetryLegacyLockPath(stateDir)), false)
})

test('source retry skips when a legacy process claims the lock during preparation', () => {
  const fs = memoryRuntime()
  const stateDir = '/state/scheduled-retry-legacy-race'
  const legacyPath = scheduledRetryLegacyLockPath(stateDir)
  let injected = false
  const mkdir = fs.runtime.mkdir

  const result = runScheduledRetry({
    stateDir,
    source: 'codex',
    runtime: {
      ...fs.runtime,
      mkdir: (path, options) => {
        if (sameMemoryPath(path, legacyPath) && !injected) {
          injected = true
          fs.files.set(
            legacyPath,
            JSON.stringify({
              pid: 999,
              startedAt: '2026-07-29T00:00:00.000Z',
              token: 'legacy-process'
            })
          )
          throw codeError('EEXIST', path)
        }
        mkdir(path, options)
      }
    },
    runAttempt: () => {
      throw new Error('legacy retry must win')
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: true, skippedReason: 'active-legacy-retry', attempts: 0 })
  assert.equal(fs.files.has(scheduledRetryLockPath(stateDir, 'codex')), false)
  assert.equal(fs.files.has(legacyPath), true)
})

test('scheduled retries isolate concurrent sources instead of dropping the second retry', () => {
  const fs = memoryRuntime()
  const stateDir = mkdtempSync(join(tmpdir(), 'tokenboard-scheduled-retry-'))
  let nestedResult

  try {
    const result = runScheduledRetry({
      stateDir,
      source: 'codex',
      runtime: fs.runtime,
      runAttempt: () => {
        nestedResult = runScheduledRetry({
          stateDir,
          source: 'claude-code',
          runtime: fs.runtime,
          runAttempt: () => 0
        })
        return 0
      }
    })

    assert.deepEqual(result, { exitCode: 0, skipped: false, attempts: 1 })
    assert.deepEqual(nestedResult, { exitCode: 0, skipped: false, attempts: 1 })
    assert.equal(fs.files.has(scheduledRetryLockPath(stateDir, 'codex')), false)
    assert.equal(fs.files.has(scheduledRetryLockPath(stateDir, 'claude-code')), false)
    assert.equal(fs.files.has(scheduledRetryTransitionLockPath(stateDir)), false)
    assert.equal(JSON.parse(fs.files.get(scheduledRetryStatePath(stateDir, 'codex'))).source, 'codex')
    assert.equal(JSON.parse(fs.files.get(scheduledRetryStatePath(stateDir, 'claude-code'))).source, 'claude-code')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('independent source retry processes share the legacy fence without serializing', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tokenboard-scheduled-retry-independent-'))
  const files = memoryFileMap()
  const directories = memoryPathSet()
  const tasklist = () => ({
    status: 0,
    stdout: '"node","101"\n"node","202"\n',
    stderr: ''
  })
  const first = memoryRuntime(
    {},
    { files, directories, pid: 101, platform: 'win32', nodeVersion: '22.15.0', runTasklist: tasklist }
  )
  const second = memoryRuntime(
    {},
    { files, directories, pid: 202, platform: 'win32', nodeVersion: '22.15.0', runTasklist: tasklist }
  )
  let nestedResult

  try {
    const result = runScheduledRetry({
      stateDir,
      source: 'codex',
      runtime: first.runtime,
      runAttempt: () => {
        nestedResult = runScheduledRetry({
          stateDir,
          source: 'claude-code',
          runtime: second.runtime,
          runAttempt: () => 0
        })
        return 0
      }
    })

    assert.deepEqual(result, { exitCode: 0, skipped: false, attempts: 1 })
    assert.deepEqual(nestedResult, { exitCode: 0, skipped: false, attempts: 1 })
    assert.equal(directories.has(scheduledRetryLegacyLockPath(stateDir)), false)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('source retry reclaims a legacy fence marker left by a stopped process', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tokenboard-scheduled-retry-stale-marker-'))
  const legacyPath = scheduledRetryLegacyLockPath(stateDir)
  const files = memoryFileMap([
    [join(legacyPath, 'source-999-dead.json'), JSON.stringify({ pid: 999, token: 'dead-marker' })]
  ])
  const directories = memoryPathSet([legacyPath])
  const fs = memoryRuntime(
    {},
    {
      files,
      directories,
      pid: 101,
      platform: 'win32',
      nodeVersion: '22.15.0',
      runTasklist: () => ({ status: 0, stdout: '', stderr: '' })
    }
  )
  let fenceObserved = false

  try {
    const result = runScheduledRetry({
      stateDir,
      source: 'codex',
      runtime: fs.runtime,
      runAttempt: () => {
        fenceObserved = directories.has(legacyPath)
        return 0
      }
    })

    assert.deepEqual(result, { exitCode: 0, skipped: false, attempts: 1 })
    assert.equal(fenceObserved, true)
    assert.equal(directories.has(legacyPath), false)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('all-source retry reclaims a marker when the pid is reused by a different process', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tokenboard-scheduled-retry-pid-reuse-'))
  const legacyPath = scheduledRetryLegacyLockPath(stateDir)
  const files = memoryFileMap([
    [
      join(legacyPath, 'source-999-reused.json'),
      JSON.stringify({
        pid: 999,
        token: 'old-process',
        processStartIdentity: 'linux:old-start'
      })
    ]
  ])
  const directories = memoryPathSet([legacyPath])
  const fs = memoryRuntime(
    {},
    {
      files,
      directories,
      pid: 101,
      processIdentity: 'linux:current-start',
      readProcessStartIdentity: (pid) => (pid === 999 ? 'linux:new-process' : 'linux:current-start'),
      kill: () => true
    }
  )

  try {
    const result = runScheduledRetry({
      stateDir,
      source: 'all',
      runtime: fs.runtime,
      runAttempt: () => 0
    })

    assert.deepEqual(result, { exitCode: 0, skipped: false, attempts: 1 })
    assert.equal(directories.has(legacyPath), false)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('scheduled retries prevent all-source execution from racing with a source retry', () => {
  const fs = memoryRuntime()
  const stateDir = '/state/scheduled-retry-all-race'
  let nestedResult
  let nestedCollected = false

  const result = runScheduledRetry({
    stateDir,
    source: 'codex',
    runtime: fs.runtime,
    runAttempt: () => {
      nestedResult = runScheduledRetry({
        stateDir,
        source: 'all',
        runtime: fs.runtime,
        runAttempt: () => {
          nestedCollected = true
          return 0
        }
      })
      return 0
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: false, attempts: 1 })
  assert.deepEqual(nestedResult, { exitCode: 0, skipped: true, skippedReason: 'active-retry', attempts: 0 })
  assert.equal(nestedCollected, false)
  assert.equal(fs.files.has(scheduledRetryLockPath(stateDir, 'codex')), false)
  assert.equal(fs.files.has(scheduledRetryLockPath(stateDir, 'all')), false)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath(stateDir)), false)
})

test('scheduled retry surfaces retry-state write failures and releases its retry lock', () => {
  const fs = memoryRuntime()
  const writeFile = fs.runtime.writeFile
  let collected = false

  assert.throws(
    () =>
      runScheduledRetry({
        stateDir: '/state',
        source: 'all',
        runtime: {
          ...fs.runtime,
          writeFile: (path, value, options) => {
            if (path.includes('scheduled-sync-retry.json.tmp-')) throw codeError('EACCES', path)
            writeFile(path, value, options)
          }
        },
        runAttempt: () => {
          collected = true
          return 0
        }
      }),
    /EACCES/
  )

  assert.equal(collected, false)
  assert.equal(fs.files.has('/state/scheduled-sync-retry.lock'), false)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath('/state')), false)
})

test('scheduled retry reports lock-release failures without hiding a completed collection', () => {
  const fs = memoryRuntime()
  const unlink = fs.runtime.unlink
  let releaseFailed = false

  assert.throws(
    () =>
      runScheduledRetry({
        stateDir: '/state',
        source: 'all',
        runtime: {
          ...fs.runtime,
          unlink: (path) => {
            if (!releaseFailed && memoryPathStartsWith(path, '/state/scheduled-sync-retry.lock.release-')) {
              releaseFailed = true
              throw new Error('retry lock release failed')
            }
            unlink(path)
          }
        },
        runAttempt: () => 0
      }),
    /TokenBoard scheduled retry lock release failed: retry lock release failed/
  )

  const state = JSON.parse(fs.files.get(scheduledRetryStatePath('/state')))
  assert.equal(state.status, 'failed')
  assert.equal(state.retryAttempt, 1)
  assert.match(state.error, /TokenBoard scheduled retry lock release failed/)
  assert.equal(fs.files.has('/state/scheduled-sync-retry.lock'), true)
  assert.equal(fs.files.has(scheduledRetryTransitionLockPath('/state')), false)
})

test('sync invocation retries only scheduled lock timeouts and skips upgrade during recovery', () => {
  const retries = []
  const invocation = {
    source: 'all',
    env: { TOKENBOARD_CONFIG_DIR: '/config' }
  }
  const initialFlags = { mode: 'sync', scheduled: true }

  const exitCode = runSyncInvocation({
    flags: initialFlags,
    invocation,
    stateDir: '/state',
    runWithLock: ({ flags }) => {
      if (flags['skip-upgrade'] === true) return 0
      throw lockTimeout()
    },
    runRetry: (options) => {
      retries.push(options)
      return { exitCode: options.runAttempt({ attempt: 1 }), skipped: false, attempts: 1 }
    }
  })

  assert.equal(exitCode, 0)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].source, 'all')
  assert.equal(retries[0].stateDir, '/state')
  assert.equal(initialFlags['skip-upgrade'], undefined)
})

test('sync invocation never retries a hook timeout or a non-sync mode', () => {
  for (const flags of [
    { mode: 'sync', scheduled: true, hook: true },
    { mode: 'preview', scheduled: true }
  ]) {
    assert.throws(
      () =>
        runSyncInvocation({
          flags,
          invocation: { source: 'all', env: {} },
          stateDir: '/state',
          runWithLock: () => {
            throw lockTimeout()
          },
          runRetry: () => {
            throw new Error('this invocation must not enter scheduled retry')
          }
        }),
      /Timed out waiting for TokenBoard sync lock/
    )
  }
})

function lockTimeout() {
  const error = new Error('Timed out waiting for TokenBoard sync lock: /state/sync.lock')
  error.code = 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
  return error
}

function memoryRuntime(initial = {}, options = {}) {
  const files = options.files || memoryFileMap(initial)
  const directories = options.directories || memoryPathSet()
  const sleeps = []
  const pid = options.pid || 101
  let now = Date.parse('2026-07-29T00:00:00.000Z')
  const runtime = {
    stateDir: '/state',
    platform: options.platform || 'linux',
    nodeVersion: options.nodeVersion || '22.16.0',
    runTasklist: options.runTasklist,
    processStartIdentity: options.processIdentity || `test:${pid}`,
    readProcessStartIdentity: options.readProcessStartIdentity || ((targetPid) => `test:${targetPid}`),
    now: () => now,
    process: {
      pid,
      kill: options.kill || (() => true)
    },
    mkdir: (path, mkdirOptions = {}) => {
      if (directories.has(path)) {
        if (mkdirOptions.recursive) return
        throw codeError('EEXIST', path)
      }
      if (files.has(path)) throw codeError('EEXIST', path)
      directories.add(path)
    },
    readFile: (path) => readFile(files, directories, path),
    readdir: (path) => readDirectory(files, directories, path),
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && (files.has(path) || directories.has(path))) throw codeError('EEXIST', path)
      files.set(path, String(value))
    },
    rename: (from, to) => {
      const value = readFile(files, directories, from)
      if (directories.has(to)) throw codeError('EISDIR', to)
      files.set(to, value)
      files.delete(from)
    },
    link: (from, to) => {
      if (files.has(to) || directories.has(to)) throw codeError('EEXIST', to)
      files.set(to, readFile(files, directories, from))
    },
    unlink: (path) => {
      if (directories.has(path)) throw codeError('EISDIR', path)
      if (!files.has(path)) throw codeError('ENOENT', path)
      files.delete(path)
    },
    rmdir: (path) => {
      if (!directories.has(path)) throw codeError('ENOENT', path)
      if (readDirectory(files, directories, path).length > 0) throw codeError('ENOTEMPTY', path)
      directories.delete(path)
    },
    sleep: (milliseconds) => {
      sleeps.push(milliseconds)
      now += milliseconds
    }
  }
  return { files, directories, sleeps, runtime }
}

function readFile(files, directories, path) {
  if (directories.has(path)) throw codeError('EISDIR', path)
  if (!files.has(path)) throw codeError('ENOENT', path)
  return files.get(path)
}

function readDirectory(files, directories, path) {
  const normalizedPath = normalizeMemoryPath(path)
  if (!directories.has(normalizedPath)) {
    if (files.has(normalizedPath)) throw codeError('ENOTDIR', path)
    throw codeError('ENOENT', path)
  }
  const prefix = normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`
  return [...files.keys()]
    .filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'))
    .map((entry) => entry.slice(prefix.length))
}

function readOnlyLegacyMarker(fs, legacyPath) {
  const entries = fs.runtime.readdir(legacyPath)
  assert.equal(entries.length, 1)
  return JSON.parse(fs.files.get(join(legacyPath, entries[0])))
}

function codeError(code, path) {
  const error = new Error(`${code}: ${path}`)
  error.code = code
  return error
}
