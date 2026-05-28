import assert from 'node:assert/strict'
import test from 'node:test'
import { runNotify } from './notify.mjs'

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
    executeSync: (trigger) => {
      calls.push(trigger)
      return { source: trigger.source }
    }
  })

  assert.equal(result.skippedSync, false)
  assert.deepEqual(calls, [{ kind: 'notify', source: 'codex' }])
})

test('notify replaces malformed trailing lock during cooldown', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/trailing.lock', '{ invalid json']
  ])
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
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
    spawnDetached: () => {
      spawned.push('spawned')
      return { pid: 704, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(spawned, ['spawned'])
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 704)
})

test('trailing process reschedules itself when pending signals remain in cooldown', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:02:00.000Z'],
    ['/state/notify.signal', `${JSON.stringify({ source: 'codex' })}\n`],
    ['/state/trailing.lock', JSON.stringify({ pid: 800 })]
  ])
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
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
  assert.deepEqual(spawned, ['spawned'])
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 801)
})
