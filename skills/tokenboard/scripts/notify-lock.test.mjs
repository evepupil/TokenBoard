import assert from 'node:assert/strict'
import test from 'node:test'
import { runNotify } from './notify.mjs'

test('notify reports trailing lock acquisition failure without recursive stack overflow', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/trailing.lock', JSON.stringify({ pid: 900 })]
  ])

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
    unlink: () => {},
    process: {
      pid: 900,
      kill: () => true
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.match(result.error, /trailing lock/)
  assert.doesNotMatch(result.error, /Maximum call stack size exceeded/)
})

test('notify reports trailing lock cleanup failures after spawn errors', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z']
  ])

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
    unlink: (path) => {
      if (path === '/state/trailing.lock') {
        const error = new Error('EPERM')
        error.code = 'EPERM'
        throw error
      }
      files.delete(path)
    },
    process: {
      pid: 901,
      kill: () => true
    },
    spawnDetached: () => {
      throw new Error('spawn failed')
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.match(result.error, /spawn failed/)
  assert.match(result.error, /trailing lock cleanup failed: EPERM/)
})

test('notify reports trailing lock ownership read failures', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/trailing.lock', JSON.stringify({ pid: 902 })]
  ])

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => {
      if (path === '/state/trailing.lock') {
        const error = new Error('EACCES')
        error.code = 'EACCES'
        throw error
      }
      return files.get(path) || ''
    },
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
      pid: 903,
      kill: () => true
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, 'EACCES')
  assert.equal(files.has('/state/trailing.lock'), true)
})
