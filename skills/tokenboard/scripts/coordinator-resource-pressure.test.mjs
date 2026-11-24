import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatedSync } from './coordinator.mjs'
import { fakeProcess, memoryRuntime } from './coordinator-test-helpers.mjs'
import { appendSignal } from './coordinator-signal.mjs'

// The hook path is the one place a sync is optional: the scheduled run collects the same
// usage. On a machine that is out of memory or swapping, starting a scan that costs
// 4.6-7.6 GB only makes the host worse and the upload slower — a 26.4-minute hook run on
// 2026-11-24 still ended in a TLS handshake timeout. A skipped trigger must leave its
// source queued, the way the cooldown and schedule-window skips do, so nothing is lost.
test('coordinator defers a hook run while the machine is under pressure', () => {
  const fs = memoryRuntime()
  let runs = 0
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(601),
      resourcePressure: () => ({ pressured: true, reason: 'memory', detail: 'memory free 3% < 10%' }),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )

  assert.equal(runs, 0, 'a pressured machine must not start a scan')
  assert.equal(result.skippedSync, true)
  assert.equal(result.skippedReason, 'resource-pressure')
  assert.equal(result.resourcePressure, 'memory free 3% < 10%')
  assert.equal(result.error, undefined, 'a deferral is not a failure')
  assert.deepEqual(fs.readdir('/state/notify.signal.d'), ['codex.json'], 'the source stays queued')
})

test('coordinator still runs when the probe reports no pressure', () => {
  const fs = memoryRuntime()
  const runs = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(602),
      resourcePressure: () => ({ pressured: false }),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.deepEqual(runs, ['codex'])
  assert.equal(result.skippedSync, false)
  assert.equal(result.cycles?.[0]?.source, 'codex')
})

// A queued signal from an earlier run has to survive a pressured skip and then be picked up
// by the next unpressured trigger — otherwise a busy afternoon would silently drop sources.
test('a pressured skip keeps earlier queued sources for the next run', () => {
  const fs = memoryRuntime()
  appendSignal({ ...memorySignalRuntime(fs) }, { kind: 'notify', source: 'claude-code' })
  const skipped = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(603),
      resourcePressure: () => ({ pressured: true, reason: 'load', detail: 'load 80 (5/cpu, 1m) > 2/cpu' }),
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )
  assert.equal(skipped.skippedReason, 'resource-pressure')

  const runs = []
  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(604),
      resourcePressure: () => ({ pressured: false }),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )
  // The skip re-queued codex; the next run collects both, queued source first.
  assert.deepEqual(runs, ['claude-code', 'codex'])
})

function memorySignalRuntime(fs) {
  return {
    stateDir: '/state',
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    unlink: fs.unlink,
    rename: fs.rename,
    link: fs.link,
    readdir: fs.readdir,
    now: () => Date.parse('2026-05-22T10:00:00.000Z'),
    process: fakeProcess(600),
    platform: 'linux',
    nodeVersion: '22.16.0'
  }
}
