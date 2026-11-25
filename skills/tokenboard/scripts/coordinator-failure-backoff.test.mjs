import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatedSync } from './coordinator.mjs'
import { fakeProcess, memoryRuntime, sameMemoryPath, writeSignal } from './coordinator-test-helpers.mjs'

// A failed hook run used to leave no trace in the coordinator: the cooldown checkpoint is
// written only on success, so the very next trigger started another full scan of the same
// tree and failed the same way. On 2026-11-24 that was 26.4 minutes per attempt at an upload
// endpoint that could not complete a TLS handshake.
const failureBackoffMs = 10 * 60_000

test('a failed non-transient run makes the next trigger wait', () => {
  const fs = memoryRuntime()
  let runs = 0
  const failed = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => Date.parse('2026-11-24T09:12:50.000Z'),
      process: fakeProcess(701),
      executeSync: () => {
        runs += 1
        throw new Error('Post "https://tokenboard.example": net/http: TLS handshake timeout')
      }
    }
  )
  assert.equal(runs, 1)
  assert.equal(failed.error, 'Post "https://tokenboard.example": net/http: TLS handshake timeout')
  assert.equal(fs.files.get('/state/last-failure.json'), '2026-11-24T09:12:50.000Z')

  const skipped = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => Date.parse('2026-11-24T09:13:50.000Z'),
      process: fakeProcess(702),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )
  assert.equal(runs, 1, 'the retry must not start a second scan')
  assert.equal(skipped.skippedReason, 'failure-backoff')
  assert.equal(skipped.error, undefined, 'a deferral is not a failure')
  assert.equal(skipped.failureBackoffRemainingMs, failureBackoffMs - 60_000)
  assert.deepEqual(fs.readdir('/state/notify.signal.d'), ['codex.json'], 'the source stays queued')
})

test('the backoff expires and a later trigger runs again', () => {
  const fs = memoryRuntime()
  const runs = []
  const runAt = (pid) => (trigger) => {
    runs.push(trigger.source)
    return { source: trigger.source }
  }
  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => Date.parse('2026-11-24T09:12:50.000Z'),
      process: fakeProcess(703),
      executeSync: () => {
        throw new Error('boom')
      }
    }
  )
  const after = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => Date.parse('2026-11-24T09:23:00.000Z'),
      process: fakeProcess(704),
      executeSync: runAt(704)
    }
  )
  assert.equal(after.skippedSync, false)
  assert.deepEqual(runs, ['codex'])
})

test('a transient failure does not engage the backoff', () => {
  const fs = memoryRuntime()
  let runs = 0
  const first = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => Date.parse('2026-11-24T09:00:00.000Z'),
      process: fakeProcess(705),
      executeSync: () => {
        runs += 1
        throw Object.assign(new Error('collector lock is held'), { transient: true, exitCode: 75 })
      }
    }
  )
  assert.equal(first.transientSources?.[0], 'codex')
  assert.equal(fs.files.has('/state/last-failure.json'), false)

  const second = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => Date.parse('2026-11-24T09:01:00.000Z'),
      process: fakeProcess(706),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )
  assert.equal(runs, 2, 'the transient retry chain must not be starved')
  assert.equal(second.skippedSync, false)
})

test('a success newer than the failure clears the backoff', () => {
  const fs = memoryRuntime({
    '/state/last-failure.json': '2026-11-24T09:00:00.000Z',
    '/state/last-success.json': '2026-11-24T09:05:00.000Z'
  })
  let runs = 0
  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => Date.parse('2026-11-24T09:06:00.000Z'),
      process: fakeProcess(707),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )
  assert.equal(runs, 1)
})

test('an explicit zero disables the backoff', () => {
  const fs = memoryRuntime({ '/state/last-failure.json': '2026-11-24T09:00:00.000Z' })
  let runs = 0
  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs: 0,
      now: () => Date.parse('2026-11-24T09:01:00.000Z'),
      process: fakeProcess(708),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )
  assert.equal(runs, 1)
})

test('a damaged failure checkpoint fails open instead of wedging every trigger', () => {
  const fs = memoryRuntime({ '/state/last-failure.json': 'not-a-timestamp' })
  let runs = 0
  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => Date.parse('2026-11-24T09:01:00.000Z'),
      process: fakeProcess(709),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )
  assert.equal(runs, 1)
})

// A success record in the future — reachable by a clock rollback after an NTP correction —
// must not supersede the failure. Without the guard every later trigger re-scans and fails
// again (the exact loop this backoff exists to stop), because the stale future success keeps
// beating the failure timestamp. `cooldownRemainingMs` treats a future timestamp as unusable
// for the same reason.
test('a future success checkpoint does not cancel the failure backoff', () => {
  const fs = memoryRuntime({
    '/state/last-failure.json': '2026-11-24T09:00:00.000Z',
    '/state/last-success.json': '2026-11-24T10:00:00.000Z'
  })
  const runs = []
  for (const [pid, at] of [
    [711, '2026-11-24T09:01:00.000Z'],
    [712, '2026-11-24T09:02:00.000Z'],
    [713, '2026-11-24T09:03:00.000Z']
  ]) {
    const result = coordinatedSync(
      { kind: 'notify', source: 'codex' },
      {
        ...fs,
        stateDir: '/state',
        cooldownMs: 0,
        failureBackoffMs,
        now: () => Date.parse(at),
        process: fakeProcess(pid),
        executeSync: (trigger) => {
          runs.push([pid, trigger.source])
          throw new Error('upload unreachable')
        }
      }
    )
    assert.equal(result.skippedReason, 'failure-backoff', `trigger at ${at} re-scanned anyway`)
  }
  assert.deepEqual(runs, [], 'a future success record must not keep unlocking the backoff')
})

// The mixed case is reachable whenever both sources are queued (two session ends, one busy
// collector, one dead endpoint): runLockedCycles runs one cycle per source. Skipping the
// checkpoint whenever ANY transient source is present would let the permanently failing
// source re-scan (and re-fail) on every trigger — the 26-minute scan repeated indefinitely.
// Only a run where EVERY failure is transient has nothing to back off from.
test('a mixed run still records the non-transient failure', () => {
  const fs = memoryRuntime()
  writeSignal(fs, 'claude-code')
  writeSignal(fs, 'codex')
  const runs = []
  const mixed = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => Date.parse('2026-11-24T09:00:00.000Z'),
      process: fakeProcess(721),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        if (trigger.source === 'claude-code') throw new Error('upload unreachable')
        throw Object.assign(new Error('collector lock is held'), { transient: true, exitCode: 75 })
      }
    }
  )
  assert.deepEqual(mixed.transientSources, ['codex'])
  assert.equal(fs.files.get('/state/last-failure.json'), '2026-11-24T09:00:00.000Z')

  runs.length = 0
  const next = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => Date.parse('2026-11-24T09:01:00.000Z'),
      process: fakeProcess(722),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return {}
      }
    }
  )
  assert.equal(next.skippedReason, 'failure-backoff')
  assert.deepEqual(runs, [], 'the queued sources wait out the backoff together')
})

// A silently unwritable checkpoint means the backoff never engages and nothing records why —
// on 2026-11-19 an unwritten success checkpoint hid a stuck cooldown for weeks the same way.
// The write error rides on the result into the run log (and status.mjs reads the same entry).
test('a failed checkpoint write is recorded instead of swallowed', () => {
  const fs = memoryRuntime()
  const realRename = fs.rename
  let tick = 0
  const clock = () => Date.parse('2026-11-24T09:00:00.000Z') + tick
  let runs = 0
  const failed = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => clock(),
      process: fakeProcess(731),
      rename: (source, target) => {
        // Only the failure checkpoint's rename fails; the run log and the lock use other paths.
        // Compared through the helper: the coordinator builds this path with `node:path`, so on
        // Windows it arrives with backslashes and a literal === never matches.
        if (sameMemoryPath(target, '/state/last-failure.json')) {
          const error = new Error(`EIO: ${source}`)
          error.code = 'EIO'
          throw error
        }
        return realRename(source, target)
      },
      executeSync: () => {
        runs += 1
        tick += 1
        throw new Error('upload unreachable')
      }
    }
  )
  assert.match(failed.failureCheckpointError, /EIO/)
  assert.equal(fs.files.has('/state/last-failure.json'), false)

  // The defect this closes: with no checkpoint and no diagnostic, every later trigger re-scans.
  tick += 60_000
  const next = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      failureBackoffMs,
      now: () => clock(),
      process: fakeProcess(732),
      executeSync: () => {
        runs += 1
        throw new Error('upload unreachable')
      }
    }
  )
  assert.equal(
    runs,
    2,
    'a lost checkpoint costs at most one extra scan — the recorded error is what makes that visible'
  )
  assert.equal(next.skippedSync, false)
})
