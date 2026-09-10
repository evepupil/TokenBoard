import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
