import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  closeScheduledLogRuntime,
  createScheduledLogRuntime,
  rotateScheduledLogs
} from './logs.mjs'

test('rotates scheduled logs over the size limit and removes expired rotations', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'tokenboard-logs-'))
  const now = new Date('2026-05-13T09:00:00+08:00')
  const expired = join(logDir, 'daily-sync.out.log.20260501000000')

  writeFileSync(join(logDir, 'daily-sync.out.log'), 'x'.repeat(11))
  writeFileSync(join(logDir, 'daily-sync.err.log'), 'short')
  writeFileSync(expired, 'expired')
  utimesSync(expired, new Date('2026-05-01T00:00:00.000Z'), new Date('2026-05-01T00:00:00.000Z'))

  rotateScheduledLogs({
    logDir,
    now,
    maxBytes: 10,
    retentionDays: 7
  })

  const entries = readdirSync(logDir).sort()
  assert.deepEqual(entries, [
    'daily-sync.err.log',
    'daily-sync.out.log',
    'daily-sync.out.log.20260513090000'
  ])
  assert.equal(statSync(join(logDir, 'daily-sync.err.log')).size, 5)
  assert.equal(statSync(join(logDir, 'daily-sync.out.log')).size, 0)
  assert.equal(
    readFileSync(join(logDir, 'daily-sync.out.log.20260513090000'), 'utf8'),
    'xxxxxxxxxx'
  )
})

test('scheduled log runtime opens managed stdout and stderr files', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'tokenboard-home-'))
  const logDir = join(homeDir, '.tokenboard', 'logs')
  const runtime = createScheduledLogRuntime({
    env: {
      TOKENBOARD_SCHEDULED_SYNC: '1'
    },
    homeDir,
    now: new Date('2026-05-13T01:00:00.000Z')
  })

  assert.ok(runtime)
  writeSync(runtime.stdoutFd, 'ok\n')
  writeSync(runtime.stderrFd, 'err\n')
  closeScheduledLogRuntime(runtime, {
    now: new Date('2026-05-13T01:00:01.000Z')
  })

  assert.equal(statSync(join(logDir, 'daily-sync.out.log')).size, 3)
  assert.equal(statSync(join(logDir, 'daily-sync.err.log')).size, 4)
})

test('scheduled flag enables log management without scheduler environment variables', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'tokenboard-home-'))
  const runtime = createScheduledLogRuntime({
    env: {},
    homeDir,
    scheduled: true
  })

  assert.ok(runtime)
  closeScheduledLogRuntime(runtime)
})

test('rotated log names do not overwrite existing archives in the same second', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'tokenboard-logs-'))
  const now = new Date('2026-05-13T09:00:00+08:00')

  writeFileSync(join(logDir, 'daily-sync.err.log'), 'first-over-limit')
  rotateScheduledLogs({
    logDir,
    now,
    maxBytes: 5,
    retentionDays: 7
  })

  writeFileSync(join(logDir, 'daily-sync.err.log'), 'second-over-limit')
  rotateScheduledLogs({
    logDir,
    now,
    maxBytes: 5,
    retentionDays: 7
  })

  assert.deepEqual(readdirSync(logDir).sort(), [
    'daily-sync.err.log',
    'daily-sync.err.log.20260513090000',
    'daily-sync.err.log.20260513090000.1'
  ])
})

test('rotates logs by reading only the retained tail bytes', () => {
  const calls = []
  const fileSystem = {
    mkdirSync() {},
    existsSync() {
      return false
    },
    statSync(filePath) {
      if (filePath.endsWith('daily-sync.out.log')) {
        return { size: 20, mtime: new Date('2026-05-13T01:00:00.000Z') }
      }
      return { size: 0, mtime: new Date('2026-05-13T01:00:00.000Z') }
    },
    renameSync() {},
    openSync() {
      return 1
    },
    readSync(_fd, buffer, offset, length, position) {
      calls.push({ length, position })
      buffer.write('klmnopqrst', offset, length, 'utf8')
      return length
    },
    closeSync() {},
    writeFileSync(_filePath, content) {
      calls.push({ content: String(content) })
    },
    readdirSync() {
      return []
    },
    unlinkSync() {}
  }

  rotateScheduledLogs({
    logDir: '/tmp/tokenboard-logs',
    now: new Date('2026-05-13T09:00:00+08:00'),
    maxBytes: 10,
    retentionDays: 7,
    fileSystem
  })

  assert.deepEqual(calls, [
    { length: 10, position: 10 },
    { content: 'klmnopqrst' },
    { content: '' }
  ])
})

test('ignores log rotation races when another process already moved the active file', () => {
  const fileSystem = {
    mkdirSync() {},
    existsSync() {
      return false
    },
    statSync(filePath) {
      if (filePath.endsWith('daily-sync.out.log')) {
        return { size: 20, mtime: new Date('2026-05-13T01:00:00.000Z') }
      }
      return { size: 0, mtime: new Date('2026-05-13T01:00:00.000Z') }
    },
    renameSync() {
      const error = new Error('missing')
      error.code = 'ENOENT'
      throw error
    },
    openSync() {
      throw new Error('should not trim missing file')
    },
    readSync() {},
    closeSync() {},
    writeFileSync() {
      throw new Error('should not recreate a file moved by another process')
    },
    readdirSync() {
      return []
    },
    unlinkSync() {}
  }

  assert.doesNotThrow(() => rotateScheduledLogs({
    logDir: '/tmp/tokenboard-logs',
    now: new Date('2026-05-13T09:00:00+08:00'),
    maxBytes: 10,
    retentionDays: 7,
    fileSystem
  }))
})
