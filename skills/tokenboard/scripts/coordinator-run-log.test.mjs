import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatedSync } from './coordinator.mjs'
import {
  fakeProcess,
  memoryPathStartsWith,
  memoryRuntime,
  normalizeMemoryPath,
  sameMemoryPath,
  writeSignal
} from './coordinator-test-helpers.mjs'

test('coordinator writes run logs and last success for successful sync', () => {
  const fs = memoryRuntime()
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(100),
      executeSync: () => ({ ok: true })
    }
  )

  assert.equal(result.skippedSync, false)
  assert.equal(JSON.parse(fs.files.get('/state/last-run.json')).status, 'success')
  assert.equal(fs.files.get('/state/last-success.json'), '2026-05-22T10:00:00.000Z')
})

// A hook run writes no log of its own, so the run log is the only place its
// phase timings can land. Losing them in the cycle record would leave the
// measurement unreachable right where it is meant to be read.
test('coordinator keeps the sync phase timings in the run log', () => {
  const fs = memoryRuntime()
  const timings = { cursorScan: 1_200, ccusageDaily: 91_000, ccusageSession: 40_500, upload: 220 }
  coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(101),
      executeSync: () => ({ source: 'claude-code', exitCode: 0, timings })
    }
  )

  const lastRun = JSON.parse(fs.files.get('/state/last-run.json'))
  assert.deepEqual(lastRun.cycles[0].result.timings, timings)
})

test('coordinator uses a Windows-safe run log filename', () => {
  const fs = memoryRuntime()
  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(115),
      executeSync: () => ({ ok: true })
    }
  )

  const runLogPath = [...fs.files.keys()].find((path) => path.startsWith('/state/runs/') && path.endsWith('.json'))
  const runLogName = runLogPath?.split('/').pop() || ''
  assert.match(runLogName, /\.json$/)
  assert.doesNotMatch(runLogName, /[<>:"\\|?*]/)
})

test('coordinator prunes oldest run logs beyond the retention limit', () => {
  const oldest = '/state/runs/2026-05-20T10-00-00.000Z-oldest.json'
  const recent = '/state/runs/2026-05-21T10-00-00.000Z-recent.json'
  const fs = memoryRuntime({
    [oldest]: '{}',
    [recent]: '{}'
  })

  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      listRunLogs: fs.readdir,
      maxRunLogs: 2,
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(116),
      executeSync: () => ({ ok: true })
    }
  )

  const runLogs = [...fs.files.keys()].filter((path) => path.startsWith('/state/runs/') && path.endsWith('.json'))
  assert.equal(runLogs.length, 2)
  assert.equal(fs.files.has(oldest), false)
  assert.equal(fs.files.has(recent), true)
})

test('coordinator rotates a legacy run directory before enabling bounded retention', () => {
  const fs = memoryRuntime()
  const renames = []
  let legacyRunsExists = true

  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(117),
      exists: (path) => {
        if (sameMemoryPath(path, '/state/runs')) return legacyRunsExists
        if (sameMemoryPath(path, '/state/runs/.bounded-v1')) return false
        return fs.exists(path)
      },
      rename: (source, target) => {
        if (sameMemoryPath(source, '/state/runs')) {
          renames.push({ source, target })
          legacyRunsExists = false
          return
        }
        fs.rename(source, target)
      },
      executeSync: () => ({ ok: true })
    }
  )

  assert.equal(renames.length, 1)
  assert.equal(sameMemoryPath(renames[0].source, '/state/runs'), true)
  assert.match(normalizeMemoryPath(renames[0].target), /^\/state\/runs\.unbounded-/)
  assert.equal(fs.files.has('/state/runs/.bounded-v1'), true)
})

test('coordinator serializes run log directory preparation', () => {
  const fs = memoryRuntime()
  let checkedRunsDirectory = false

  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(118),
      exists: (path) => {
        if (sameMemoryPath(path, '/state/runs')) {
          checkedRunsDirectory = true
          assert.equal(fs.files.has('/state/run-logs.lock'), true)
        }
        return fs.exists(path)
      },
      executeSync: () => ({ ok: true })
    }
  )

  assert.equal(checkedRunsDirectory, true)
  assert.equal(fs.files.has('/state/run-logs.lock'), false)
})

test('coordinator fails visibly when the run log lock times out', () => {
  const fs = memoryRuntime({
    '/state/run-logs.lock': JSON.stringify({ pid: 400, startedAt: '2026-05-22T10:00:00.000Z' })
  })
  let now = Date.parse('2026-05-22T10:01:00.000Z')
  let syncRuns = 0

  assert.throws(
    () =>
      coordinatedSync(
        { kind: 'notify', source: 'codex' },
        {
          ...fs,
          stateDir: '/state',
          now: () => now,
          sleep: (ms) => {
            now += ms
          },
          lockTimeoutMs: 1,
          process: fakeProcess(401),
          executeSync: () => {
            syncRuns += 1
            return { ok: true }
          }
        }
      ),
    /run log lock timeout/
  )

  assert.equal(syncRuns, 1)
  assert.equal(JSON.parse(fs.files.get('/state/run-logs.lock')).pid, 400)
  assert.equal(fs.files.get('/state/last-success.json'), '2026-05-22T10:01:00.000Z')
})

test('coordinator recovers a stale run log lock before writing', () => {
  const fs = memoryRuntime({
    '/state/run-logs.lock': JSON.stringify({ pid: 402, startedAt: '2026-05-22T10:00:00.000Z' })
  })

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      process: {
        pid: 403,
        kill: (pid) => {
          if (pid === 402) {
            const error = new Error('ESRCH')
            error.code = 'ESRCH'
            throw error
          }
          return true
        }
      },
      executeSync: () => ({ ok: true })
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(fs.files.has('/state/run-logs.lock'), false)
  assert.equal(JSON.parse(fs.files.get('/state/last-run.json')).status, 'success')
})

for (const malformedLock of ['not-json', '{}']) {
  test(`coordinator replaces malformed run log lock ${JSON.stringify(malformedLock)}`, () => {
    const fs = memoryRuntime({
      '/state/run-logs.lock': malformedLock
    })

    const result = coordinatedSync(
      { kind: 'notify', source: 'codex' },
      {
        ...fs,
        stateDir: '/state',
        process: fakeProcess(404),
        executeSync: () => ({ ok: true })
      }
    )

    assert.equal(result.error, undefined)
    assert.equal(fs.files.has('/state/run-logs.lock'), false)
    assert.equal(JSON.parse(fs.files.get('/state/last-run.json')).status, 'success')
  })
}

test('coordinator fails visibly when run log writing fails', () => {
  const fs = memoryRuntime()
  assert.throws(
    () =>
      coordinatedSync(
        { kind: 'notify', source: 'codex' },
        {
          ...fs,
          stateDir: '/state',
          now: () => Date.parse('2026-05-22T10:00:00.000Z'),
          process: fakeProcess(208),
          writeFile: (path, value, options) => {
            if (sameMemoryPath(path, '/state/last-run.json')) {
              const error = new Error('log write failed')
              error.code = 'EACCES'
              throw error
            }
            fs.writeFile(path, value, options)
          },
          executeSync: () => ({ ok: true })
        }
      ),
    /log write failed/
  )
  assert.equal(fs.files.has('/state/sync.lock'), false)
  assert.equal(fs.files.has('/state/run-logs.lock'), false)
  assert.equal(fs.files.get('/state/last-success.json'), '2026-05-22T10:00:00.000Z')
})

for (const failure of [
  {
    name: 'an Error',
    value: Object.assign(new Error('checkpoint write failed'), { code: 'EACCES' }),
    expected: /checkpoint write failed/
  },
  { name: 'an empty value', value: '', expected: /Unknown error/ }
]) {
  test(`coordinator logs and rethrows successful sync checkpoint failures from ${failure.name}`, () => {
    const fs = memoryRuntime()
    let runs = 0

    assert.throws(
      () =>
        coordinatedSync(
          { kind: 'notify', source: 'codex' },
          {
            ...fs,
            stateDir: '/state',
            maxFollowUps: 1,
            process: fakeProcess(210),
            writeFile: (path, value, options) => {
              if (memoryPathStartsWith(path, '/state/last-success.json')) throw failure.value
              fs.writeFile(path, value, options)
            },
            executeSync: (trigger) => {
              runs += 1
              if (runs === 1) writeSignal(fs, 'claude-code')
              return { source: trigger.source, run: runs }
            }
          }
        ),
      failure.expected
    )

    const lastRun = JSON.parse(fs.files.get('/state/last-run.json'))
    assert.equal(lastRun.status, 'error')
    assert.equal(lastRun.coordination.hadFollowUp, true)
    assert.equal(lastRun.coordination.followUpCount, 1)
    assert.deepEqual(lastRun.cycles, [
      { source: 'codex', result: { source: 'codex', run: 1 } },
      { source: 'claude-code', result: { source: 'claude-code', run: 2 } }
    ])
    assert.equal(fs.files.has('/state/sync.lock'), false)
    assert.equal(fs.files.has('/state/run-logs.lock'), false)
  })
}

test('coordinator preserves sync evidence when checkpoint and lock release both fail', () => {
  const fs = memoryRuntime()
  let runs = 0
  let lockReleaseFailed = false
  let thrown

  try {
    coordinatedSync(
      { kind: 'notify', source: 'codex' },
      {
        ...fs,
        stateDir: '/state',
        maxFollowUps: 1,
        process: fakeProcess(211),
        writeFile: (path, value, options) => {
          if (memoryPathStartsWith(path, '/state/last-success.json')) throw new Error('checkpoint write failed')
          fs.writeFile(path, value, options)
        },
        unlink: (path) => {
          if (!lockReleaseFailed && memoryPathStartsWith(path, '/state/sync.lock.release-')) {
            lockReleaseFailed = true
            throw new Error('sync lock release failed')
          }
          fs.unlink(path)
        },
        executeSync: (trigger) => {
          runs += 1
          if (runs === 1) writeSignal(fs, 'claude-code')
          return { source: trigger.source, run: runs }
        }
      }
    )
  } catch (error) {
    thrown = error
  }

  assert.match(thrown?.message || '', /checkpoint write failed/)
  assert.match(thrown?.message || '', /sync lock release failed/)
  const lastRun = JSON.parse(fs.files.get('/state/last-run.json'))
  assert.equal(lastRun.status, 'error')
  assert.equal(lastRun.coordination.hadFollowUp, true)
  assert.equal(lastRun.coordination.followUpCount, 1)
  assert.deepEqual(lastRun.cycles, [
    { source: 'codex', result: { source: 'codex', run: 1 } },
    { source: 'claude-code', result: { source: 'claude-code', run: 2 } }
  ])
  assert.match(lastRun.error, /checkpoint write failed/)
  assert.match(lastRun.error, /sync lock release failed/)
  assert.equal(fs.files.has('/state/run-logs.lock'), false)
})

test('coordinator preserves sync evidence when lock release fails after a successful checkpoint', () => {
  const fs = memoryRuntime()
  let runs = 0
  let lockReleaseFailed = false

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      maxFollowUps: 1,
      now: () => Date.parse('2026-07-16T00:00:00.000Z'),
      process: fakeProcess(212),
      unlink: (path) => {
        if (!lockReleaseFailed && memoryPathStartsWith(path, '/state/sync.lock.release-')) {
          lockReleaseFailed = true
          throw new Error('sync lock release failed')
        }
        fs.unlink(path)
      },
      executeSync: (trigger) => {
        runs += 1
        if (runs === 1) writeSignal(fs, 'claude-code')
        return { source: trigger.source, run: runs }
      }
    }
  )

  assert.equal(result.error, 'sync lock release failed')
  assert.equal(result.hadFollowUp, true)
  assert.equal(result.followUpCount, 1)
  assert.deepEqual(result.cycles, [
    { source: 'codex', result: { source: 'codex', run: 1 } },
    { source: 'claude-code', result: { source: 'claude-code', run: 2 } }
  ])
  const lastRun = JSON.parse(fs.files.get('/state/last-run.json'))
  assert.deepEqual(lastRun.cycles, result.cycles)
  assert.equal(lastRun.status, 'error')
  assert.equal(fs.files.get('/state/last-success.json'), '2026-07-16T00:00:00.000Z')
  assert.equal(fs.files.has('/state/run-logs.lock'), false)
})

test('coordinator preserves sync evidence when deferred follow-up scheduling fails', () => {
  const fs = memoryRuntime()
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-07-19T00:00:00.000Z'),
      process: fakeProcess(213),
      scheduleTrailing: () => {
        throw new Error('deferred follow-up scheduling failed')
      },
      executeSync: (trigger) => {
        writeSignal(fs, 'claude-code')
        return { source: trigger.source, ok: true }
      }
    }
  )

  assert.equal(result.error, 'deferred follow-up scheduling failed')
  assert.deepEqual(result.deferredSources, ['claude-code'])
  assert.deepEqual(result.cycles, [
    {
      source: 'codex',
      result: { source: 'codex', ok: true }
    }
  ])
  assert.equal(fs.files.get('/state/last-success.json'), '2026-07-19T00:00:00.000Z')
  const lastRun = JSON.parse(fs.files.get('/state/last-run.json'))
  assert.equal(lastRun.status, 'error')
  assert.equal(lastRun.error, 'deferred follow-up scheduling failed')
  assert.deepEqual(lastRun.coordination.deferredSources, ['claude-code'])
  assert.deepEqual(lastRun.cycles, result.cycles)
  assert.equal(fs.files.has('/state/sync.lock'), false)
})

// A collector that could not take `collector-run.lock` exits 75 (deferred), because the lock may
// be held by a long preview or another sync. A hook never retries inline, so the skill turns 75
// into a plain failure — and the coordinator then recorded an error and scheduled nothing, leaving
// the source in the signal queue until some later trigger happened to cover it. A transient exit is
// retryable by definition, so the coordinator has to schedule the retry it decided not to run
// inline. The failure is still reported: the hook run really did not collect anything.
test('coordinator schedules a trailing retry after a transient collector exit', () => {
  const fs = memoryRuntime()
  const trailing = []
  const message = 'TokenBoard hook sync failed with exit code 75: TokenBoard collector lock timed out'
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-07-20T00:00:00.000Z'),
      process: fakeProcess(214),
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ source: trigger.source, delayMs })
        return true
      },
      executeSync: () => {
        const error = new Error(message)
        error.exitCode = 75
        error.transient = true
        throw error
      }
    }
  )

  assert.deepEqual(trailing, [{ source: 'codex', delayMs: 60_000 }])
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(result.trailingSources, ['codex'])
  assert.equal(result.error, message)
  assert.equal(JSON.parse(fs.files.get('/state/last-run.json')).status, 'error')
})

// The other half: a genuine source failure must never be retried by a trailing worker. Retrying it
// would fail the same way and schedule the next retry, chaining unattended background runs for a
// broken provider.
test('coordinator schedules no retry for a plain sync failure', () => {
  const fs = memoryRuntime()
  const trailing = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-07-20T00:00:00.000Z'),
      process: fakeProcess(215),
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ source: trigger.source, delayMs })
        return true
      },
      executeSync: () => {
        throw new Error('TokenBoard hook sync failed with exit code 1: codex transcript unreadable')
      }
    }
  )

  assert.deepEqual(trailing, [])
  assert.equal(result.trailingScheduled, undefined)
  assert.equal(result.error, 'TokenBoard hook sync failed with exit code 1: codex transcript unreadable')
})

for (const failure of [
  { name: 'an empty Error message', value: new Error(''), expected: 'Error' },
  { name: 'a whitespace Error message', value: new Error('   '), expected: 'Error' },
  { name: 'an empty thrown string', value: '', expected: 'Unknown error' },
  { name: 'a thrown null value', value: null, expected: 'null' },
  { name: 'a thrown undefined value', value: undefined, expected: 'undefined' }
]) {
  test(`coordinator treats ${failure.name} as a failed sync`, () => {
    const fs = memoryRuntime()
    const result = coordinatedSync(
      { kind: 'notify', source: 'codex' },
      {
        ...fs,
        stateDir: '/state',
        now: () => Date.parse('2026-05-22T10:00:00.000Z'),
        process: fakeProcess(209),
        executeSync: () => {
          throw failure.value
        }
      }
    )

    const lastRun = JSON.parse(fs.files.get('/state/last-run.json'))
    assert.equal(result.error, failure.expected)
    assert.equal(lastRun.status, 'error')
    assert.equal(lastRun.error, failure.expected)
    assert.equal(fs.files.has('/state/last-success.json'), false)
  })
}
