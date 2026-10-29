import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { coordinatedSync } from './coordinator.mjs'
import { appendSignal } from './coordinator-signal.mjs'
import {
  fakeProcess,
  memoryPathStartsWith,
  memoryRuntime,
  normalizeMemoryPath,
  sameMemoryPath,
  writeSignal
} from './coordinator-test-helpers.mjs'
import { currentProcessStartIdentity } from './process-liveness.mjs'

test('coordinator fails clearly when state directory is missing', () => {
  assert.throws(
    () =>
      coordinatedSync(
        { kind: 'notify', source: 'codex' },
        {
          ...memoryRuntime(),
          process: fakeProcess(204),
          executeSync: () => {
            throw new Error('should not run')
          }
        }
      ),
    /coordinatedSync stateDir is required/
  )
})

test('coordinator binds the production lock to the current process identity', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tokenboard-coordinator-lock-'))
  const expectedIdentity = currentProcessStartIdentity()
  let lockIdentity

  try {
    coordinatedSync(
      { kind: 'notify', source: 'codex' },
      {
        stateDir,
        cooldownMs: 0,
        executeSync: () => {
          lockIdentity = JSON.parse(readFileSync(join(stateDir, 'sync.lock'), 'utf8')).processStartIdentity
          return { ok: true }
        }
      }
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }

  if (expectedIdentity) {
    assert.equal(lockIdentity, expectedIdentity)
  } else if (lockIdentity !== undefined) {
    // Windows process identity probes can be transiently unavailable when the
    // test runner is under load. The production lock may still bind
    // successfully on its first retry; validate the persisted shape without
    // turning that optional probe into a false failure.
    assert.match(lockIdentity, /^[a-z]+:[^\s]+$/)
  }
})

test('coordinator retries a transient process identity probe before the next lock', () => {
  const fs = memoryRuntime()
  let probes = 0

  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(205),
      readProcessStartIdentity: () => {
        probes += 1
        return probes === 1 ? { status: 'unknown' } : 'linux:test:205'
      },
      executeSync: () => ({ ok: true })
    }
  )

  assert.equal(probes, 2)
})

test('coordinator skips within cooldown without running sync', () => {
  const fs = memoryRuntime({
    '/state/last-success.json': '2026-05-22T10:00:00.000Z'
  })
  let runs = 0
  const trailing = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:01:00.000Z'),
      process: fakeProcess(101),
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )

  assert.equal(runs, 0)
  assert.equal(result.skippedReason, 'cooldown')
  assert.equal(result.cooldownRemainingMs, 240000)
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(trailing, [{ trigger: { kind: 'notify', source: 'codex' }, delayMs: 240000 }])
})

// A damaged checkpoint must not wedge the coordinator. The checkpoint only decides whether
// to debounce, and the sync is what rewrites it — so refusing to run on unreadable content
// leaves the damage in place permanently, with no recovery but deleting the file by hand.
// Running costs one extra sync and then a successful run has replaced the file.
test('coordinator recovers from an unparseable cooldown checkpoint instead of wedging', () => {
  const fs = memoryRuntime({
    '/state/last-success.json': '{not-a-timestamp'
  })
  let runs = 0

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:01:00.000Z'),
      process: fakeProcess(311),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )

  assert.equal(runs, 1, 'a damaged checkpoint must not stop the sync that repairs it')
  assert.notEqual(result.skippedReason, 'cooldown')
})

// A checkpoint dated in the future (a clock that jumped and was later corrected, or a
// restored snapshot) is as unusable as a damaged one, and worse: the remaining cooldown
// grows with the distance into the future. That value becomes `notify.mjs`'s continuation
// delay, where anything past setTimeout's 32-bit range is silently clamped to 1ms — turning
// the continuation loop into a 1ms spin that holds the lock and rewrites its run log.
// The delay must never exceed the cooldown it came from.
test('coordinator does not report a future checkpoint as a longer-than-cooldown delay', () => {
  const checkpoint = '2026-05-22T10:05:00.000Z'
  const fs = memoryRuntime({ '/state/last-success.json': checkpoint })
  const now = Date.parse('2026-05-22T10:00:00.000Z')
  const cooldownMs = 300_000

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      // The checkpoint is a minute in the future, so the naive remainder would be
      // cooldownMs + 60s.
      now: () => now,
      process: fakeProcess(312),
      cooldownMs,
      executeSync: () => ({})
    }
  )

  assert.notEqual(result.skippedReason, 'cooldown', 'a future checkpoint must not debounce')
  assert.ok(
    result.cooldownRemainingMs === undefined || result.cooldownRemainingMs <= cooldownMs,
    `cooldown remaining ${result.cooldownRemainingMs} must not exceed the cooldown ${cooldownMs}`
  )
})

// An empty checkpoint is the shape a write killed mid-flight leaves behind, which is why
// the checkpoint is now written through a temp file and a rename. If one is found anyway
// (an older collector wrote it), it must recover the same way a malformed one does.
test('coordinator recovers from an empty cooldown checkpoint', () => {
  const fs = memoryRuntime({ '/state/last-success.json': '' })
  let runs = 0

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:01:00.000Z'),
      process: fakeProcess(312),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )

  assert.equal(runs, 1)
  assert.notEqual(result.skippedReason, 'cooldown')
})

// A missing checkpoint is the first run, not damage: it must keep syncing immediately.
test('coordinator still runs when no cooldown checkpoint exists yet', () => {
  const fs = memoryRuntime({})
  let runs = 0
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:01:00.000Z'),
      process: fakeProcess(313),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )

  assert.equal(runs, 1)
  assert.notEqual(result.skippedReason, 'cooldown')
})

// A read failure is damage too, and must not be mistaken for an absent checkpoint.
// The override has to be passed as an option rather than patched onto the fixture
// afterwards: buildRuntime captures `options.readFile` by value, so a later assignment
// on the returned object never reaches it.
test('coordinator fails loudly when the cooldown checkpoint cannot be read', () => {
  const fs = memoryRuntime({ '/state/last-success.json': '2026-05-22T10:00:00.000Z' })
  let runs = 0

  assert.throws(
    () =>
      coordinatedSync(
        { kind: 'notify', source: 'codex' },
        {
          ...fs,
          // Fall through to the fixture's own reader for every other path: the lock
          // files are read before the cooldown, and returning undefined for them fails
          // the run long before this assertion could mean anything.
          readFile: (path) => {
            if (String(path).endsWith('last-success.json')) {
              const error = new Error('EACCES: permission denied')
              error.code = 'EACCES'
              throw error
            }
            return fs.readFile(path)
          },
          stateDir: '/state',
          now: () => Date.parse('2026-05-22T10:01:00.000Z'),
          process: fakeProcess(314),
          executeSync: () => {
            runs += 1
            return {}
          }
        }
      ),
    /EACCES/
  )
  assert.equal(runs, 0)
})

test('coordinator reads JSON encoded last success timestamp for cooldown', () => {
  const fs = memoryRuntime({
    '/state/last-success.json': `${JSON.stringify('2026-05-22T10:00:00.000Z')}\n`
  })
  let runs = 0
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:01:00.000Z'),
      process: fakeProcess(113),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )

  assert.equal(runs, 0)
  assert.equal(result.skippedReason, 'cooldown')
  assert.equal(result.cooldownRemainingMs, 240000)
})

test('appendSignal requires mkdir when queue rename is enabled', () => {
  assert.throws(
    () =>
      appendSignal(
        {
          stateDir: '/state',
          now: () => Date.parse('2026-05-22T10:00:00.000Z'),
          process: fakeProcess(203),
          writeFile: () => {},
          rename: () => {}
        },
        { source: 'codex' }
      ),
    /requires mkdir/
  )
})

test('appendSignal retains a legacy signal when the atomic queue is unavailable', () => {
  const written = new Map()
  appendSignal(
    {
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(204),
      writeFile: (path, value, options = {}) => {
        const key = normalizeMemoryPath(path)
        if (options.flag === 'a') {
          written.set(key, `${written.get(key) || ''}${value}`)
          return
        }
        written.set(key, String(value))
      }
    },
    { source: 'codex' }
  )

  assert.match(written.get('/state/notify.signal'), /"source":"codex"/)
})

test('appendSignal still appends legacy signal when queued rename fails', () => {
  const written = new Map()
  assert.throws(
    () =>
      appendSignal(
        {
          stateDir: '/state',
          now: () => Date.parse('2026-05-22T10:00:00.000Z'),
          process: fakeProcess(206),
          mkdir: () => {},
          writeFile: (path, value, options = {}) => {
            const key = normalizeMemoryPath(path)
            if (options.flag === 'a') {
              written.set(key, `${written.get(key) || ''}${value}`)
              return
            }
            written.set(key, String(value))
          },
          rename: () => {
            throw new Error('rename failed')
          },
          unlink: (path) => {
            written.delete(normalizeMemoryPath(path))
          }
        },
        { source: 'codex' }
      ),
    /rename failed/
  )

  assert.match(written.get('/state/notify.signal'), /"source":"codex"/)
  assert.equal(
    [...written.keys()].some((path) => path.endsWith('.tmp')),
    false
  )
})

test('appendSignal coalesces same-source queue entries without growing the legacy signal log', () => {
  const fs = memoryRuntime()
  const runtime = {
    ...fs,
    stateDir: '/state',
    now: () => Date.parse('2026-05-22T10:00:00.000Z'),
    process: fakeProcess(206)
  }

  appendSignal(runtime, { source: 'codex' })
  appendSignal(runtime, { source: 'codex' })

  assert.deepEqual(fs.readdir('/state/notify.signal.d'), ['codex.json'])
  assert.match(fs.files.get('/state/notify.signal.d/codex.json'), /"source":"codex"/)
  assert.equal(fs.files.has('/state/notify.signal'), false)
})

test('readSignalSources fails visibly on legacy signal read errors', () => {
  const fs = memoryRuntime()
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(207),
      readFile: (path) => {
        if (sameMemoryPath(path, '/state/notify.signal')) {
          const error = new Error('EACCES')
          error.code = 'EACCES'
          throw error
        }
        return fs.readFile(path)
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(result.error, 'EACCES')
  assert.equal(fs.files.has('/state/sync.lock'), false)
})

test('coordinator retains an unreadable drained queue signal for a later retry', () => {
  const fs = memoryRuntime({
    '/state/notify.signal.d/codex.json.208.1.retained.drain': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const first = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(208),
      readFile: (path) => {
        if (path.endsWith('.drain')) {
          const error = new Error('EACCES')
          error.code = 'EACCES'
          throw error
        }
        return fs.readFile(path)
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(first.error, 'EACCES')
  assert.equal(
    [...fs.files.keys()].some(
      (path) => path.startsWith('/state/notify.signal.d/codex.json.') && path.endsWith('.drain')
    ),
    true
  )

  const runs = []
  const second = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(209),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.equal(second.error, undefined)
  assert.deepEqual(runs, ['codex', 'claude-code'])
  assert.equal(
    [...fs.files.keys()].some(
      (path) => path.startsWith('/state/notify.signal.d/codex.json.') && path.endsWith('.drain')
    ),
    false
  )
})

test('coordinator retains every drained queue signal when a later read fails', () => {
  const fs = memoryRuntime({
    '/state/notify.signal.d/claude-code.json': `${JSON.stringify({ source: 'claude-code' })}\n`,
    '/state/notify.signal.d/codex.json': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const first = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(212),
      readFile: (path) => {
        if (memoryPathStartsWith(path, '/state/notify.signal.d/codex.json.') && path.endsWith('.drain')) {
          const error = new Error('EACCES')
          error.code = 'EACCES'
          throw error
        }
        return fs.readFile(path)
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(first.error, 'EACCES')
  assert.equal(
    [...fs.files.keys()].filter((path) => path.startsWith('/state/notify.signal.d/') && path.endsWith('.drain')).length,
    2
  )

  const runs = []
  const second = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(213),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.equal(second.error, undefined)
  assert.deepEqual(runs, ['claude-code', 'codex'])
  assert.equal(
    [...fs.files.keys()].filter((path) => path.startsWith('/state/notify.signal.d/') && path.endsWith('.drain')).length,
    0
  )
})

test('coordinator retains a recovery journal when drain cleanup fails', () => {
  const fs = memoryRuntime({
    '/state/notify.signal.d/claude-code.json': `${JSON.stringify({ source: 'claude-code' })}\n`,
    '/state/notify.signal.d/codex.json': `${JSON.stringify({ source: 'codex' })}\n`
  })
  let cleanupFailed = false
  const first = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(214),
      unlink: (path) => {
        if (!cleanupFailed && path.endsWith('.drain')) {
          cleanupFailed = true
          const error = new Error('EPERM')
          error.code = 'EPERM'
          throw error
        }
        fs.unlink(path)
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(first.error, 'TokenBoard signal cleanup failed; recovery journal retained: EPERM')
  assert.equal(
    [...fs.files.keys()].some((path) => path.startsWith('/state/notify.signal.recovery.') && path.endsWith('.json')),
    true
  )

  const runs = []
  const second = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(215),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.equal(second.error, undefined)
  assert.deepEqual(runs, ['claude-code', 'codex'])
  assert.equal(
    [...fs.files.keys()].some((path) => path.startsWith('/state/notify.signal.recovery.') && path.endsWith('.json')),
    false
  )
})

test('coordinator retains an unreadable drained legacy signal for a later retry', () => {
  const fs = memoryRuntime({
    '/state/notify.signal': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const first = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(210),
      readFile: (path) => {
        if (memoryPathStartsWith(path, '/state/notify.signal.') && path.endsWith('.drain')) {
          const error = new Error('EACCES')
          error.code = 'EACCES'
          throw error
        }
        return fs.readFile(path)
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(first.error, 'EACCES')
  assert.equal(fs.files.has('/state/notify.signal'), false)
  assert.equal(
    [...fs.files.keys()].some((path) => path.startsWith('/state/notify.signal.') && path.endsWith('.drain')),
    true
  )

  const runs = []
  const second = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(211),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.equal(second.error, undefined)
  assert.deepEqual(runs, ['codex', 'claude-code'])
  assert.equal(
    [...fs.files.keys()].some((path) => path.startsWith('/state/notify.signal.') && path.endsWith('.drain')),
    false
  )
})

test('coordinator consumes follow-up signal under the same lock', () => {
  const fs = memoryRuntime()
  const runs = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      maxFollowUps: 1,
      process: fakeProcess(102),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        if (runs.length === 1) {
          writeSignal(fs, 'codex')
        }
        return { run: runs.length }
      }
    }
  )

  assert.deepEqual(runs, ['claude-code', 'codex'])
  assert.equal(result.hadFollowUp, true)
  assert.equal(result.followUpCount, 1)
})

test('coordinator defers signals observed during a long hook run through cooldown', () => {
  const fs = memoryRuntime()
  const runs = []
  const trailing = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 900_000,
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(113),
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: (trigger) => {
        runs.push(trigger.source)
        writeSignal(fs, 'codex')
        return { run: runs.length }
      }
    }
  )

  assert.deepEqual(runs, ['codex'])
  assert.equal(result.hadFollowUp, false)
  assert.equal(result.followUpCount, 0)
  assert.deepEqual(result.deferredSources, ['codex'])
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(result.trailingSources, ['codex'])
  assert.deepEqual(trailing, [{ trigger: { kind: 'notify', source: 'codex' }, delayMs: 900_000 }])
  assert.match(fs.files.get('/state/notify.signal'), /"source":"codex"/)
  const lastRun = JSON.parse(fs.files.get('/state/last-run.json'))
  assert.deepEqual(lastRun.coordination.deferredSources, ['codex'])
})

test('coordinator keeps failed source signals for a later retry', () => {
  const fs = memoryRuntime()
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(107),
      executeSync: () => {
        throw new Error('sync failed')
      }
    }
  )

  assert.equal(result.error, 'sync failed')
  assert.match(fs.files.get('/state/notify.signal.d/codex.json'), /"source":"codex"/)
  assert.equal(JSON.parse(fs.files.get('/state/last-run.json')).status, 'error')
  assert.equal(fs.files.has('/state/last-success.json'), false)
})

test('coordinator only acknowledges recovery journals for sources whose sync succeeded', () => {
  const fs = memoryRuntime({
    '/state/notify.signal.d/claude-code.json': `${JSON.stringify({ source: 'claude-code' })}\n`,
    '/state/notify.signal.d/codex.json': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const runs = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(118),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        if (trigger.source === 'claude-code') throw new Error('claude sync failed')
        return { source: trigger.source }
      }
    }
  )

  assert.deepEqual(runs, ['claude-code', 'codex'])
  assert.equal(result.error, 'claude sync failed')
  assert.equal(fs.files.has('/state/notify.signal.recovery.codex.json'), false)
  assert.equal(fs.files.has('/state/notify.signal.recovery.claude-code.json'), true)
  assert.match(fs.files.get('/state/notify.signal.d/claude-code.json'), /"source":"claude-code"/)
})

test('coordinator retains retry evidence when recovery acknowledgement cleanup fails', () => {
  const fs = memoryRuntime({
    '/state/notify.signal.d/codex.json': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const unlink = fs.unlink
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(119),
      unlink: (path) => {
        if (sameMemoryPath(path, '/state/notify.signal.recovery.codex.json')) {
          const error = new Error('EACCES')
          error.code = 'EACCES'
          throw error
        }
        return unlink(path)
      },
      executeSync: () => ({ ok: true })
    }
  )

  assert.equal(result.error, 'EACCES')
  assert.equal(fs.files.has('/state/notify.signal.recovery.codex.json'), true)
  assert.match(fs.files.get('/state/notify.signal.d/codex.json'), /"source":"codex"/)
  assert.equal(fs.files.has('/state/last-success.json'), false)
})

test('coordinator keeps failed source signals when follow-up signal read fails', () => {
  const fs = memoryRuntime({
    '/state/notify.signal': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(114),
      readFile: (path) => {
        if (sameMemoryPath(path, '/state/notify.signal') && !fs.files.has(normalizeMemoryPath(path))) {
          const error = new Error('EACCES')
          error.code = 'EACCES'
          throw error
        }
        return fs.readFile(path)
      },
      executeSync: () => {
        throw new Error('sync failed')
      }
    }
  )

  assert.equal(result.error, 'EACCES')
  assert.match(fs.files.get('/state/notify.signal.d/codex.json'), /"source":"codex"/)
  assert.equal(fs.files.has('/state/last-success.json'), false)
})

test('coordinator clears failed source signal after same-run follow-up succeeds', () => {
  const fs = memoryRuntime()
  const runs = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      maxFollowUps: 1,
      process: fakeProcess(108),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        if (runs.length === 1) {
          writeSignal(fs, 'codex')
          throw new Error('sync failed')
        }
        return { ok: true }
      }
    }
  )

  assert.deepEqual(runs, ['codex', 'codex'])
  assert.equal(result.error, 'sync failed')
  assert.equal(fs.files.get('/state/notify.signal'), undefined)
  assert.equal(JSON.parse(fs.files.get('/state/last-run.json')).status, 'error')
  assert.equal(fs.files.has('/state/last-success.json'), false)
})

test('coordinator does not drop signals appended while draining queued work', () => {
  const fs = memoryRuntime({
    '/state/notify.signal': `${JSON.stringify({ source: 'claude-code' })}\n`
  })
  const runs = []
  let appendedDuringDrain = false
  const result = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      maxFollowUps: 1,
      process: fakeProcess(105),
      rename: (source, target) => {
        fs.rename(source, target)
        if (!appendedDuringDrain && sameMemoryPath(source, '/state/notify.signal')) {
          appendedDuringDrain = true
          writeSignal(fs, 'codex')
        }
      },
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.deepEqual(runs, ['claude-code', 'codex'])
  assert.equal(result.hadFollowUp, true)
  assert.equal(result.followUpCount, 1)
})

test('coordinator retains a same-source signal that replaces its stable queue marker during drain', () => {
  const fs = memoryRuntime({
    '/state/notify.signal.d/codex.json': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const queueRuntime = {
    ...fs,
    stateDir: '/state',
    now: () => Date.parse('2026-05-22T10:00:00.000Z'),
    process: fakeProcess(111)
  }
  const runs = []
  let appendedDuringDrain = false
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...queueRuntime,
      cooldownMs: 0,
      maxFollowUps: 1,
      rename: (source, target) => {
        fs.rename(source, target)
        if (!appendedDuringDrain && sameMemoryPath(source, '/state/notify.signal.d/codex.json')) {
          appendedDuringDrain = true
          appendSignal(queueRuntime, { source: 'codex' })
        }
      },
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.deepEqual(runs, ['codex', 'codex'])
  assert.equal(result.hadFollowUp, true)
  assert.equal(result.followUpCount, 1)
  assert.equal(fs.files.get('/state/notify.signal.d/codex.json'), undefined)
})

test('coordinator consumes queued signal files when legacy signal drain loses a raced append', () => {
  const fs = memoryRuntime({
    '/state/notify.signal': `${JSON.stringify({ source: 'claude-code' })}\n`,
    '/state/notify.signal.d/codex.json': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const runs = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(112),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.deepEqual([...runs].sort(), ['claude-code', 'codex'])
  assert.equal(result.skippedSync, false)
  assert.equal(fs.files.get('/state/notify.signal.d/codex.json'), undefined)
})

test('coordinator does not drop signals appended after initial pending read', () => {
  const fs = memoryRuntime()
  const runs = []
  let appendedAfterInitialRead = false
  const result = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(106),
      readFile: (path) => {
        try {
          return fs.readFile(path)
        } finally {
          if (!appendedAfterInitialRead && sameMemoryPath(path, '/state/notify.signal')) {
            appendedAfterInitialRead = true
            writeSignal(fs, 'codex')
          }
        }
      },
      rename: fs.rename,
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.deepEqual(runs, ['claude-code', 'codex'])
  assert.equal(result.hadFollowUp, false)
  assert.equal(result.followUpCount, 0)
})

test('coordinator consumes queued source signals once when it acquires a busy lock', () => {
  const fs = memoryRuntime({
    '/state/sync.lock': JSON.stringify({ pid: 200, startedAt: '2026-05-22T10:00:00.000Z' }),
    '/state/notify.signal': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const runs = []
  let lockChecks = 0
  const process = {
    pid: 201,
    kill: (pid) => {
      if (pid !== 200) return true
      lockChecks += 1
      if (lockChecks >= 2) {
        fs.unlink('/state/sync.lock')
        const error = new Error('ESRCH')
        error.code = 'ESRCH'
        throw error
      }
      return true
    }
  }

  const result = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process,
      sleep: () => {},
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.equal(result.waitedForLock, true)
  assert.deepEqual([...runs].sort(), ['claude-code', 'codex'])
  assert.equal(fs.files.get('/state/notify.signal'), undefined)
})

test('coordinator schedules a trailing retry when a shared sync lock remains busy', () => {
  const fs = memoryRuntime({
    '/state/sync.lock': JSON.stringify({ pid: 200, startedAt: '2026-05-22T10:00:00.000Z' })
  })
  const trailing = []
  let now = Date.parse('2026-05-22T10:00:00.000Z')
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 900_000,
      lockTimeoutMs: 1,
      now: () => now,
      sleep: (milliseconds) => {
        now += milliseconds
      },
      process: fakeProcess(201),
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(result.skippedSync, true)
  assert.equal(result.skippedReason, 'lock-timeout')
  assert.equal(result.error, 'lock timeout')
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(result.trailingSources, ['codex'])
  assert.deepEqual(trailing, [{ trigger: { kind: 'notify', source: 'codex' }, delayMs: 60_000 }])
  assert.match(fs.files.get('/state/notify.signal.d/codex.json'), /"source":"codex"/)
})

test('coordinator releases waited lock when pending signal read fails', () => {
  const fs = memoryRuntime({
    '/state/sync.lock': JSON.stringify({ pid: 200, startedAt: '2026-05-22T10:00:00.000Z' })
  })
  let lockChecks = 0
  const process = {
    pid: 201,
    kill: (pid) => {
      if (pid !== 200) return true
      lockChecks += 1
      if (lockChecks >= 2) {
        fs.unlink('/state/sync.lock')
        const error = new Error('ESRCH')
        error.code = 'ESRCH'
        throw error
      }
      return true
    }
  }

  const result = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process,
      sleep: () => {},
      readdir: () => {
        const error = new Error('EACCES')
        error.code = 'EACCES'
        throw error
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(result.error, 'EACCES')
  assert.equal(fs.files.has('/state/sync.lock'), false)
})

test('coordinator runs current trigger when other sources are already pending without cooldown', () => {
  const fs = memoryRuntime({
    '/state/notify.signal': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const runs = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      cooldownMs: 0,
      process: fakeProcess(111),
      executeSync: (trigger) => {
        runs.push(trigger.source)
        return { source: trigger.source }
      }
    }
  )

  assert.equal(result.skippedSync, false)
  assert.deepEqual(runs, ['codex', 'claude-code'])
  assert.equal(fs.files.get('/state/notify.signal'), undefined)
})

test('coordinator schedules trailing for each pending source during cooldown', () => {
  const fs = memoryRuntime({
    '/state/last-success.json': '2026-05-22T10:00:00.000Z',
    '/state/notify.signal': [
      JSON.stringify({ source: 'codex' }),
      JSON.stringify({ source: 'claude-code' }),
      JSON.stringify({ source: 'codex' })
    ].join('\n')
  })
  const trailing = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:01:00.000Z'),
      process: fakeProcess(103),
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(result.skippedReason, 'cooldown')
  assert.deepEqual(result.trailingSources, ['codex', 'claude-code'])
  assert.deepEqual(trailing, [
    { trigger: { kind: 'notify', source: 'codex' }, delayMs: 240000 },
    { trigger: { kind: 'notify', source: 'claude-code' }, delayMs: 240000 }
  ])
  assert.deepEqual(JSON.parse(fs.files.get('/state/last-run.json')).coordination.trailingSources, [
    'codex',
    'claude-code'
  ])
})

test('coordinator keeps a new cooldown trigger when other sources are already pending', () => {
  const fs = memoryRuntime({
    '/state/last-success.json': '2026-05-22T10:00:00.000Z',
    '/state/notify.signal': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const trailing = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:01:00.000Z'),
      process: fakeProcess(109),
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(result.skippedReason, 'cooldown')
  assert.deepEqual(result.trailingSources, ['codex', 'claude-code'])
  assert.match(fs.files.get('/state/notify.signal'), /"source":"codex"/)
  assert.match(fs.files.get('/state/notify.signal.d/claude-code.json'), /"source":"claude-code"/)
  assert.deepEqual(trailing, [
    { trigger: { kind: 'notify', source: 'codex' }, delayMs: 240000 },
    { trigger: { kind: 'notify', source: 'claude-code' }, delayMs: 240000 }
  ])
})

test('trailing process does not reschedule cooldown when no pending signal remains', () => {
  const fs = memoryRuntime({
    '/state/last-success.json': '2026-05-22T10:00:00.000Z'
  })
  let scheduled = 0
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:01:00.000Z'),
      process: fakeProcess(104),
      trailingProcess: true,
      scheduleTrailing: () => {
        scheduled += 1
        return true
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(result.skippedReason, 'cooldown')
  assert.equal(result.trailingScheduled, false)
  assert.equal(scheduled, 0)
})

test('trailing process keeps its trigger when another source is already pending during cooldown', () => {
  const fs = memoryRuntime({
    '/state/last-success.json': '2026-05-22T10:00:00.000Z',
    '/state/notify.signal': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const trailing = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'claude-code' },
    {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:01:00.000Z'),
      process: fakeProcess(110),
      trailingProcess: true,
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: () => {
        throw new Error('should not run')
      }
    }
  )

  assert.equal(result.skippedReason, 'cooldown')
  assert.deepEqual(result.trailingSources, ['codex', 'claude-code'])
  assert.match(fs.files.get('/state/notify.signal'), /"source":"codex"/)
  assert.match(fs.files.get('/state/notify.signal.d/claude-code.json'), /"source":"claude-code"/)
  assert.deepEqual(trailing, [
    { trigger: { kind: 'notify', source: 'codex' }, delayMs: 240000 },
    { trigger: { kind: 'notify', source: 'claude-code' }, delayMs: 240000 }
  ])
})

// The lock release in `runCoordinator`'s `finally` runs on the way out of *every* failure,
// so it is the one place where a cleanup error can overwrite an unrelated primary one. Both
// halves of that matter: the operator loses the reason the run actually failed, and — when
// the primary is the cooldown checkpoint error, which is rethrown to fail the hook — a
// cleanup failure changes the outcome from a thrown error to a normal return, so the
// fail-closed path silently becomes fail-open.
test('coordinator keeps the primary error when lock release also fails', () => {
  const fs = memoryRuntime({ '/state/last-success.json': '2026-05-22T10:00:00.000Z' })
  const rename = fs.rename
  let thrown

  try {
    coordinatedSync(
      { kind: 'notify', source: 'codex' },
      {
        ...fs,
        stateDir: '/state',
        cooldownMs: 60_000,
        process: fakeProcess(227),
        readFile: (path) => {
          if (sameMemoryPath(path, '/state/last-success.json')) throw new Error('EACCES')
          return fs.readFile(path)
        },
        rename: (source, target) => {
          if (String(source).includes('sync.lock')) {
            const error = new Error('EPERM')
            error.code = 'EPERM'
            throw error
          }
          return rename(source, target)
        },
        executeSync: () => {
          throw new Error('should not run')
        }
      }
    )
  } catch (error) {
    thrown = error
  }

  // Both are reported, primary first — the same shape the sibling checkpoint errors use.
  assert.match(thrown?.message ?? '', /^EACCES; sync lock release failed: EPERM$/)
  assert.equal(
    fs.files.get('/state/last-run.json').includes('EACCES'),
    true,
    'the run log must record the error the run failed on'
  )
})

// The class is what `coordinatedSync` tests to decide whether to rethrow the hook's
// fail-closed error, so a cleanup failure must not change it.
test('coordinator still fails closed when lock release fails after a checkpoint error', () => {
  const fs = memoryRuntime({ '/state/last-success.json': '2026-05-22T10:00:00.000Z' })
  const rename = fs.rename
  let thrown

  try {
    coordinatedSync(
      { kind: 'notify', source: 'codex' },
      {
        ...fs,
        stateDir: '/state',
        cooldownMs: 60_000,
        process: fakeProcess(228),
        readFile: (path) => {
          if (sameMemoryPath(path, '/state/last-success.json')) throw new Error('EACCES')
          return fs.readFile(path)
        },
        rename: (source, target) => {
          if (String(source).includes('sync.lock')) {
            const error = new Error('EPERM')
            error.code = 'EPERM'
            throw error
          }
          return rename(source, target)
        },
        executeSync: () => {
          throw new Error('should not run')
        }
      }
    )
  } catch (error) {
    thrown = error
  }

  // The point is that it throws at all: before the fix this path returned normally.
  assert.match(thrown?.message ?? '', /sync lock release failed/)
})

// Every other module that writes under the state directory pins the mode explicitly
// (`sync.mjs` and `scheduled-sync-state.mjs` chmod the state dir to 0700, `hooks.mjs` and
// `antigravity-statusline-log.mjs` create their directories 0700 and their files 0600).
// The run logs are the exception: they are written with no mode, so on a machine whose
// umask is the usual 022 they land world-readable. Their content is not inert — it carries
// absolute local paths and collector diagnostics. The scheduled path happens to be shielded
// by the plist's `Umask 63`, which is a property of that launcher rather than of this code,
// and the hook path runs from an interactive shell where the umask is typically 022.
// Windows has no POSIX mode bits: mkdir's `mode` is ignored and stat reports the
// synthetic 0o666/0o444 set, so there is nothing to assert here. The same guard
// pattern covers the equivalent permission tests in config.test.mjs. Windows
// state-directory privacy is inherited from the user profile ACL instead.
test('coordinator writes its run logs private regardless of umask', { skip: process.platform === 'win32' }, () => {
  // A directory that does not exist yet, so this exercises the modes the coordinator
  // chooses. `mkdtempSync` would hand back an already-private directory and hide them.
  const parent = mkdtempSync(join(tmpdir(), 'tokenboard-run-log-mode-'))
  const stateDir = join(parent, 'state')
  const previousUmask = process.umask(0o022)
  const mode = (path) => statSync(path).mode & 0o777

  try {
    coordinatedSync(
      { kind: 'notify', source: 'codex' },
      {
        stateDir,
        cooldownMs: 0,
        executeSync: () => ({ ok: true })
      }
    )

    assert.equal(mode(stateDir), 0o700, 'state directory')
    assert.equal(mode(join(stateDir, 'runs')), 0o700, 'run log directory')
    assert.equal(mode(join(stateDir, 'last-run.json')), 0o600, 'last-run pointer')
    const runLog = readdirSync(join(stateDir, 'runs')).find((name) => name.endsWith('.json'))
    assert.equal(mode(join(stateDir, 'runs', runLog)), 0o600, 'run log')
    assert.equal(mode(join(stateDir, 'last-success.json')), 0o600, 'sync checkpoint')
  } finally {
    process.umask(previousUmask)
    rmSync(parent, { recursive: true, force: true })
  }
})

// The test above uses a directory that does not exist yet, so `mkdir`'s mode applies. In a real
// install the state directory is created first by `writeConfig`, which passes no mode, and
// `mkdir(..., { mode })` does not touch the mode of a directory that already exists. The
// coordinator therefore has to chmod it, or the state directory stays world-listable under the
// usual 022 umask.
test('coordinator tightens an already-existing state directory', { skip: process.platform === 'win32' }, () => {
  const parent = mkdtempSync(join(tmpdir(), 'tokenboard-existing-state-'))
  const stateDir = join(parent, 'state')
  const runsDir = join(stateDir, 'runs')
  const previousUmask = process.umask(0o022)
  const mode = (path) => statSync(path).mode & 0o777

  try {
    // Simulate `writeConfig`: the directory exists and is world-readable before the coordinator
    // runs. `mkdir` alone would leave it that way. The runs directory gets the same treatment:
    // asserting it only ever after this run *creates* it would pass from `mkdir`'s mode alone,
    // so it must pre-exist world-readable with its bounded marker to prove chmod is what
    // tightens it — a run that is not created by this run is also the case a chmod can be
    // dropped from without the test noticing.
    mkdirSync(runsDir, { recursive: true })
    writeFileSync(join(runsDir, '.bounded-v1'), 'TokenBoard bounded run logs v1\n')
    assert.equal(mode(stateDir), 0o755, 'precondition: the state directory starts world-readable')
    assert.equal(mode(runsDir), 0o755, 'precondition: the runs directory starts world-readable')

    coordinatedSync(
      { kind: 'notify', source: 'codex' },
      {
        stateDir,
        cooldownMs: 0,
        executeSync: () => ({ ok: true })
      }
    )

    assert.equal(mode(stateDir), 0o700, 'state directory is tightened even though it pre-existed')
    assert.equal(mode(runsDir), 0o700, 'pre-existing run log directory is tightened too')
  } finally {
    process.umask(previousUmask)
    rmSync(parent, { recursive: true, force: true })
  }
})

// The coordinator chmods the state directory to pin it private. Through a symlink that chmod
// lands on the link's target — a directory this same run then refuses to use, because
// `sync.mjs` rejects a symlinked state directory outright. Matching that rejection here keeps
// the two paths from disagreeing about whether the directory is acceptable.
test('coordinator refuses a symlinked state directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'tokenboard-symlinked-state-'))
  const realTarget = join(parent, 'real-target')
  const stateDir = join(parent, 'state')
  const previousUmask = process.umask(0o022)

  try {
    mkdirSync(realTarget, { recursive: true })
    symlinkSync(realTarget, stateDir)

    assert.throws(
      () =>
        coordinatedSync(
          { kind: 'notify', source: 'codex' },
          {
            stateDir,
            cooldownMs: 0,
            executeSync: () => ({ ok: true })
          }
        ),
      /must not be a symbolic link/
    )
    // The refusal itself is what matters and runs everywhere; the "left untouched"
    // check can only be expressed with POSIX mode bits (Windows ignores chmod for
    // directories and stat reports a synthetic mode).
    if (process.platform !== 'win32') {
      assert.equal(statSync(realTarget).mode & 0o777, 0o755, "the link's target is left untouched")
    }
  } finally {
    process.umask(previousUmask)
    rmSync(parent, { recursive: true, force: true })
  }
})

// Only a missing directory is an expected inspection outcome (the first run, before the
// mkdir). Any other lstat failure — EACCES, ELOOP — means the symlink check could not run
// at all, and skipping it would chmod a path this run never verified. `sync.mjs` rethrows
// the same way; this pins that the coordinator does not quietly continue instead.
test('coordinator fails closed when the state directory cannot be inspected', () => {
  const parent = mkdtempSync(join(tmpdir(), 'tokenboard-lstat-failure-'))
  const stateDir = join(parent, 'state')
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })

  try {
    assert.throws(
      () =>
        coordinatedSync(
          { kind: 'notify', source: 'codex' },
          {
            stateDir,
            cooldownMs: 0,
            executeSync: () => ({ ok: true }),
            lstat: () => {
              throw denied
            }
          }
        ),
      /EACCES: permission denied/
    )
    assert.equal(existsSync(stateDir), false, 'nothing is created when the inspection fails')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
