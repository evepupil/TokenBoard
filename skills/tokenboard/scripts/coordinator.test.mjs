import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseLock } from './coordinator-lock.mjs'
import { coordinatedSync } from './coordinator.mjs'
import { appendSignal } from './coordinator-signal.mjs'

test('coordinator writes run logs and last success for successful sync', () => {
  const fs = memoryRuntime()
  let now = Date.parse('2026-05-22T10:00:00.000Z')
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    now: () => now,
    process: fakeProcess(100),
    executeSync: () => ({ ok: true })
  })

  assert.equal(result.skippedSync, false)
  assert.equal(JSON.parse(fs.files.get('/state/last-run.json')).status, 'success')
  assert.equal(fs.files.get('/state/last-success.json'), '2026-05-22T10:00:00.000Z')
})

test('coordinator uses a Windows-safe run log filename', () => {
  const fs = memoryRuntime()
  coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    now: () => Date.parse('2026-05-22T10:00:00.000Z'),
    process: fakeProcess(115),
    executeSync: () => ({ ok: true })
  })

  const runLogPath = [...fs.files.keys()].find((path) => path.startsWith('/state/runs/'))
  const runLogName = runLogPath?.split('/').pop() || ''
  assert.match(runLogName, /\.json$/)
  assert.doesNotMatch(runLogName, /[<>:"\\|?*]/)
})

test('coordinator fails visibly when run log writing fails', () => {
  const fs = memoryRuntime()
  assert.throws(
    () => coordinatedSync({ kind: 'notify', source: 'codex' }, {
      ...fs,
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(208),
      writeFile: (path, value, options) => {
        if (path === '/state/last-run.json') {
          const error = new Error('log write failed')
          error.code = 'EACCES'
          throw error
        }
        fs.writeFile(path, value, options)
      },
      executeSync: () => ({ ok: true })
    }),
    /log write failed/
  )
  assert.equal(fs.files.has('/state/sync.lock'), false)
})

test('coordinator fails clearly when state directory is missing', () => {
  assert.throws(
    () => coordinatedSync({ kind: 'notify', source: 'codex' }, {
      ...memoryRuntime(),
      process: fakeProcess(204),
      executeSync: () => {
        throw new Error('should not run')
      }
    }),
    /coordinatedSync stateDir is required/
  )
})

test('coordinator skips within cooldown without running sync', () => {
  const fs = memoryRuntime({
    '/state/last-success.json': '2026-05-22T10:00:00.000Z'
  })
  let runs = 0
  const trailing = []
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
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
  })

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
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    process: fakeProcess(113),
    executeSync: () => {
      runs += 1
      return {}
    }
  })

  assert.equal(runs, 0)
  assert.equal(result.skippedReason, 'cooldown')
  assert.equal(result.cooldownRemainingMs, 240000)
})

test('coordinator stops retrying stale lock cleanup when unlink cannot remove it', () => {
  const fs = memoryRuntime({
    '/state/sync.lock': JSON.stringify({ pid: 200, startedAt: '2026-05-22T10:00:00.000Z' })
  })
  let unlinkAttempts = 0
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    process: {
      pid: 201,
      kill: (pid) => {
        if (pid === 200) {
          const error = new Error('ESRCH')
          error.code = 'ESRCH'
          throw error
        }
        return true
      }
    },
    lockTimeoutMs: 0,
    unlink: (path) => {
      if (path === '/state/sync.lock') {
        unlinkAttempts += 1
        const error = new Error('EPERM')
        error.code = 'EPERM'
        throw error
      }
      fs.unlink(path)
    },
    sleep: () => {},
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.skippedSync, true)
  assert.equal(result.error, 'lock timeout')
  assert.equal(unlinkAttempts, 1)
})

test('releaseLock removes malformed lock files', () => {
  const removed = []
  releaseLock('/state/sync.lock', {
    process: fakeProcess(202),
    readFile: () => 'not-json',
    unlink: (path) => removed.push(path)
  })

  assert.deepEqual(removed, ['/state/sync.lock'])
})

test('releaseLock does not remove locks with unreadable ownership', () => {
  const removed = []
  assert.throws(
    () => releaseLock('/state/sync.lock', {
      process: fakeProcess(205),
      readFile: () => {
        const error = new Error('EACCES')
        error.code = 'EACCES'
        throw error
      },
      unlink: (path) => removed.push(path)
    }),
    /EACCES/
  )

  assert.deepEqual(removed, [])
})

test('releaseLock ignores lock removal races while reading ownership', () => {
  const removed = []
  releaseLock('/state/sync.lock', {
    process: fakeProcess(206),
    readFile: () => {
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    },
    unlink: (path) => {
      removed.push(path)
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    }
  })

  assert.deepEqual(removed, ['/state/sync.lock'])
})

test('coordinator reacquires a stale lock even if the file is recreated during cleanup', () => {
  const fs = memoryRuntime({
    '/state/sync.lock': JSON.stringify({ pid: 300, startedAt: '2026-05-22T10:00:00.000Z' })
  })
  let recreated = false
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    process: {
      pid: 301,
      kill: (pid) => {
        if (pid === 300 || pid === 302) {
          const error = new Error('ESRCH')
          error.code = 'ESRCH'
          throw error
        }
        return true
      }
    },
    unlink: (path) => {
      if (path === '/state/sync.lock') {
        fs.unlink(path)
        if (!recreated) {
          recreated = true
          fs.writeFile('/state/sync.lock', JSON.stringify({ pid: 302, startedAt: '2026-05-22T10:00:01.000Z' }))
        }
        return
      }
      fs.unlink(path)
    },
    executeSync: () => ({ ok: true })
  })

  assert.equal(result.skippedSync, false)
  assert.equal(result.error, undefined)
  assert.equal(fs.files.get('/state/sync.lock'), undefined)
})

test('appendSignal requires mkdir when queue rename is enabled', () => {
  assert.throws(
    () => appendSignal({
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(203),
      writeFile: () => {},
      rename: () => {}
    }, { source: 'codex' }),
    /requires mkdir/
  )
})

test('appendSignal still appends legacy signal when queued rename fails', () => {
  const written = new Map()
  assert.throws(
    () => appendSignal({
      stateDir: '/state',
      now: () => Date.parse('2026-05-22T10:00:00.000Z'),
      process: fakeProcess(206),
      mkdir: () => {},
      writeFile: (path, value, options = {}) => {
        if (options.flag === 'a') {
          written.set(path, `${written.get(path) || ''}${value}`)
          return
        }
        written.set(path, String(value))
      },
      rename: () => {
        throw new Error('rename failed')
      },
      unlink: (path) => {
        written.delete(path)
      }
    }, { source: 'codex' }),
    /rename failed/
  )

  assert.match(written.get('/state/notify.signal'), /"source":"codex"/)
  assert.equal([...written.keys()].some((path) => path.endsWith('.tmp')), false)
})

test('readSignalSources fails visibly on legacy signal read errors', () => {
  const fs = memoryRuntime()
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process: fakeProcess(207),
    readFile: (path) => {
      if (path === '/state/notify.signal') {
        const error = new Error('EACCES')
        error.code = 'EACCES'
        throw error
      }
      return fs.readFile(path)
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, 'EACCES')
  assert.equal(fs.files.has('/state/sync.lock'), false)
})

test('coordinator consumes follow-up signal under the same lock', () => {
  const fs = memoryRuntime()
  const runs = []
  const result = coordinatedSync({ kind: 'notify', source: 'claude-code' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process: fakeProcess(102),
    executeSync: (trigger) => {
      runs.push(trigger.source)
      if (runs.length === 1) {
        writeSignal(fs, 'codex')
      }
      return { run: runs.length }
    }
  })

  assert.deepEqual(runs, ['claude-code', 'codex'])
  assert.equal(result.hadFollowUp, true)
  assert.equal(result.followUpCount, 1)
})

test('coordinator keeps failed source signals for a later retry', () => {
  const fs = memoryRuntime()
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process: fakeProcess(107),
    executeSync: () => {
      throw new Error('sync failed')
    }
  })

  assert.equal(result.error, 'sync failed')
  assert.match(fs.files.get('/state/notify.signal'), /"source":"codex"/)
  assert.equal(JSON.parse(fs.files.get('/state/last-run.json')).status, 'error')
  assert.equal(fs.files.has('/state/last-success.json'), false)
})

test('coordinator keeps failed source signals when follow-up signal read fails', () => {
  const fs = memoryRuntime({
    '/state/notify.signal': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process: fakeProcess(114),
    readFile: (path) => {
      if (path === '/state/notify.signal' && !fs.files.has(path)) {
        const error = new Error('EACCES')
        error.code = 'EACCES'
        throw error
      }
      return fs.readFile(path)
    },
    executeSync: () => {
      throw new Error('sync failed')
    }
  })

  assert.equal(result.error, 'EACCES')
  assert.match(fs.files.get('/state/notify.signal'), /"source":"codex"/)
  assert.equal(fs.files.has('/state/last-success.json'), false)
})

test('coordinator clears failed source signal after same-run follow-up succeeds', () => {
  const fs = memoryRuntime()
  const runs = []
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process: fakeProcess(108),
    executeSync: (trigger) => {
      runs.push(trigger.source)
      if (runs.length === 1) {
        writeSignal(fs, 'codex')
        throw new Error('sync failed')
      }
      return { ok: true }
    }
  })

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
  const result = coordinatedSync({ kind: 'notify', source: 'claude-code' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process: fakeProcess(105),
    rename: (source, target) => {
      fs.rename(source, target)
      if (!appendedDuringDrain && source === '/state/notify.signal') {
        appendedDuringDrain = true
        writeSignal(fs, 'codex')
      }
    },
    executeSync: (trigger) => {
      runs.push(trigger.source)
      return { source: trigger.source }
    }
  })

  assert.deepEqual(runs, ['claude-code', 'codex'])
  assert.equal(result.hadFollowUp, true)
  assert.equal(result.followUpCount, 1)
})

test('coordinator consumes queued signal files when legacy signal drain loses a raced append', () => {
  const fs = memoryRuntime({
    '/state/notify.signal': `${JSON.stringify({ source: 'claude-code' })}\n`,
    '/state/notify.signal.d/codex.json': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const runs = []
  const result = coordinatedSync({ kind: 'notify', source: 'claude-code' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process: fakeProcess(112),
    executeSync: (trigger) => {
      runs.push(trigger.source)
      return { source: trigger.source }
    }
  })

  assert.deepEqual([...runs].sort(), ['claude-code', 'codex'])
  assert.equal(result.skippedSync, false)
  assert.equal(fs.files.get('/state/notify.signal.d/codex.json'), undefined)
})

test('coordinator does not drop signals appended after initial pending read', () => {
  const fs = memoryRuntime()
  const runs = []
  let appendedAfterInitialRead = false
  const result = coordinatedSync({ kind: 'notify', source: 'claude-code' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process: fakeProcess(106),
    readFile: (path) => {
      try {
        return fs.readFile(path)
      } finally {
        if (!appendedAfterInitialRead && path === '/state/notify.signal') {
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
  })

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

  const result = coordinatedSync({ kind: 'notify', source: 'claude-code' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process,
    sleep: () => {},
    executeSync: (trigger) => {
      runs.push(trigger.source)
      return { source: trigger.source }
    }
  })

  assert.equal(result.waitedForLock, true)
  assert.deepEqual([...runs].sort(), ['claude-code', 'codex'])
  assert.equal(fs.files.get('/state/notify.signal'), undefined)
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

  const result = coordinatedSync({ kind: 'notify', source: 'claude-code' }, {
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
  })

  assert.equal(result.error, 'EACCES')
  assert.equal(fs.files.has('/state/sync.lock'), false)
})

test('coordinator runs current trigger when other sources are already pending without cooldown', () => {
  const fs = memoryRuntime({
    '/state/notify.signal': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const runs = []
  const result = coordinatedSync({ kind: 'notify', source: 'claude-code' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process: fakeProcess(111),
    executeSync: (trigger) => {
      runs.push(trigger.source)
      return { source: trigger.source }
    }
  })

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
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
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
  })

  assert.equal(result.skippedReason, 'cooldown')
  assert.deepEqual(result.trailingSources, ['codex', 'claude-code'])
  assert.deepEqual(trailing, [
    { trigger: { kind: 'notify', source: 'codex' }, delayMs: 240000 },
    { trigger: { kind: 'notify', source: 'claude-code' }, delayMs: 240000 }
  ])
  assert.deepEqual(JSON.parse(fs.files.get('/state/last-run.json')).coordination.trailingSources, ['codex', 'claude-code'])
})

test('coordinator keeps a new cooldown trigger when other sources are already pending', () => {
  const fs = memoryRuntime({
    '/state/last-success.json': '2026-05-22T10:00:00.000Z',
    '/state/notify.signal': `${JSON.stringify({ source: 'codex' })}\n`
  })
  const trailing = []
  const result = coordinatedSync({ kind: 'notify', source: 'claude-code' }, {
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
  })

  assert.equal(result.skippedReason, 'cooldown')
  assert.deepEqual(result.trailingSources, ['codex', 'claude-code'])
  assert.match(fs.files.get('/state/notify.signal'), /"source":"codex"/)
  assert.match(fs.files.get('/state/notify.signal'), /"source":"claude-code"/)
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
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
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
  })

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
  const result = coordinatedSync({ kind: 'notify', source: 'claude-code' }, {
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
  })

  assert.equal(result.skippedReason, 'cooldown')
  assert.deepEqual(result.trailingSources, ['codex', 'claude-code'])
  assert.match(fs.files.get('/state/notify.signal'), /"source":"codex"/)
  assert.match(fs.files.get('/state/notify.signal'), /"source":"claude-code"/)
  assert.deepEqual(trailing, [
    { trigger: { kind: 'notify', source: 'codex' }, delayMs: 240000 },
    { trigger: { kind: 'notify', source: 'claude-code' }, delayMs: 240000 }
  ])
})

function writeSignal(fs, source) {
  fs.writeFile('/state/notify.signal', `${JSON.stringify({ source })}\n`, { flag: 'a' })
}

function memoryRuntime(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => {
      if (!files.has(path)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
      return files.get(path)
    },
    writeFile: (path, value, options = {}) => {
      if (typeof options.flag === 'string' && options.flag.includes('x') && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      if (options.flag === 'a') {
        files.set(path, `${files.get(path) || ''}${value}`)
        return
      }
      files.set(path, String(value))
    },
    unlink: (path) => {
      files.delete(path)
    },
    rename: (source, target) => {
      if (!files.has(source)) {
        const error = new Error(`ENOENT: ${source}`)
        error.code = 'ENOENT'
        throw error
      }
      files.set(target, files.get(source))
      files.delete(source)
    },
    readdir: (path) => {
      const prefix = `${path}/`
      return [...files.keys()]
        .filter((filePath) => filePath.startsWith(prefix))
        .map((filePath) => filePath.slice(prefix.length))
        .filter((name) => !name.includes('/'))
    },
    sleep: () => {}
  }
}

function fakeProcess(pid) {
  return {
    pid,
    kill: () => true
  }
}
