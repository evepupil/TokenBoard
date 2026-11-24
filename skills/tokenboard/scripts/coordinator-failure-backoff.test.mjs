import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatedSync } from './coordinator.mjs'
import { fakeProcess, memoryRuntime } from './coordinator-test-helpers.mjs'

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
