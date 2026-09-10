import assert from 'node:assert/strict'
import test from 'node:test'
import { acknowledgeSignalSource, appendSignal, drainSignalSources, readSignalSources } from './coordinator-signal.mjs'
import { fakeProcess, memoryPathIncludes, memoryRuntime } from './coordinator-test-helpers.mjs'

function signal(source) {
  return `${JSON.stringify({ source })}\n`
}

function recoveryPaths(files) {
  return [...files.keys()].filter((path) => memoryPathIncludes(path, '/notify.signal.recovery.'))
}

function runtime(files, overrides = {}) {
  return {
    ...memoryRuntime(files),
    stateDir: '/state',
    now: () => Date.parse('2026-07-29T00:00:00.000Z'),
    process: fakeProcess(901),
    ...overrides
  }
}

test('signal drain leaves every source in place when the recovery journal cannot be written', () => {
  const fs = runtime({
    '/state/notify.signal.d/codex.json': signal('codex'),
    '/state/notify.signal': signal('claude-code')
  })
  const writeFile = fs.writeFile
  fs.writeFile = (path, value, options) => {
    if (memoryPathIncludes(path, '/notify.signal.recovery.')) {
      const error = new Error('EACCES')
      error.code = 'EACCES'
      throw error
    }
    return writeFile(path, value, options)
  }

  assert.throws(() => drainSignalSources(fs), /EACCES/)
  assert.equal([...fs.files.keys()].filter((path) => path.endsWith('.drain')).length, 2)
  assert.equal(recoveryPaths(fs.files).length, 0)
  assert.deepEqual(readSignalSources(fs), ['codex', 'claude-code'])
})

test('signal drain validates a malformed recovery journal before rotating new signals', () => {
  const fs = runtime({
    '/state/notify.signal.recovery.900.1.deadbeef.json': '{not-json}\n',
    '/state/notify.signal.d/codex.json': signal('codex'),
    '/state/notify.signal': signal('claude-code')
  })

  assert.throws(() => drainSignalSources(fs), /Invalid TokenBoard signal recovery journal/)
  assert.equal(fs.files.has('/state/notify.signal.d/codex.json'), true)
  assert.equal(fs.files.has('/state/notify.signal'), true)
  assert.equal(
    [...fs.files.keys()].some((path) => path.endsWith('.drain')),
    false
  )
  assert.equal(recoveryPaths(fs.files).length, 1)
})

test('signal drain keeps a cross-format recovery journal when cleanup fails after an earlier drain was removed', () => {
  const fs = runtime({
    '/state/notify.signal.d/codex.json': signal('codex'),
    '/state/notify.signal': signal('claude-code')
  })
  const unlink = fs.unlink
  let deletedDrain = false
  fs.unlink = (path) => {
    if (path.endsWith('.drain') && !deletedDrain) {
      deletedDrain = true
      return unlink(path)
    }
    if (path.endsWith('.drain')) {
      const error = new Error('EPERM')
      error.code = 'EPERM'
      throw error
    }
    return unlink(path)
  }

  assert.throws(() => drainSignalSources(fs), /recovery journal retained: EPERM/)
  assert.equal([...fs.files.keys()].filter((path) => path.endsWith('.drain')).length, 1)
  const journals = recoveryPaths(fs.files)
  assert.equal(journals.length, 2)
  assert.deepEqual(journals.map((path) => JSON.parse(fs.files.get(path)).source).sort(), ['claude-code', 'codex'])
  assert.deepEqual(readSignalSources(fs), ['claude-code', 'codex'])
})

test('signal drain reuses its recovery journal while cleanup keeps failing', () => {
  const fs = runtime({
    '/state/notify.signal.d/codex.json': signal('codex'),
    '/state/notify.signal': signal('claude-code')
  })
  const unlink = fs.unlink
  fs.unlink = (path) => {
    if (path.endsWith('.drain')) {
      const error = new Error('EPERM')
      error.code = 'EPERM'
      throw error
    }
    return unlink(path)
  }

  assert.throws(() => drainSignalSources(fs), /recovery journal retained: EPERM/)
  const firstJournals = recoveryPaths(fs.files)
  assert.equal(firstJournals.length, 2)

  assert.throws(() => drainSignalSources(fs), /recovery journal retained: EPERM/)
  const secondJournals = recoveryPaths(fs.files)
  assert.deepEqual(secondJournals, firstJournals)
  assert.deepEqual(secondJournals.map((path) => JSON.parse(fs.files.get(path)).source).sort(), ['claude-code', 'codex'])
})

test('signal drain preserves a legacy source journal while adding a newly drained source', () => {
  const fs = runtime({
    '/state/notify.signal.recovery.900.1.deadbeef.json': `${JSON.stringify({
      version: 1,
      sources: ['codex']
    })}\n`,
    '/state/notify.signal.d/claude-code.json': signal('claude-code')
  })

  assert.deepEqual(drainSignalSources(fs), ['codex', 'claude-code'])
  const journals = recoveryPaths(fs.files)
  assert.equal(journals.length, 2)
  assert.deepEqual(
    journals
      .map((path) => {
        const parsed = JSON.parse(fs.files.get(path))
        return parsed.version === 1 ? parsed.sources[0] : parsed.source
      })
      .sort(),
    ['claude-code', 'codex']
  )
})

test('signal reader fails visibly and preserves a malformed recovery journal', () => {
  const fs = runtime({
    '/state/notify.signal.recovery.900.1.deadbeef.json': '{not-json}\n'
  })

  assert.throws(() => readSignalSources(fs), /Invalid TokenBoard signal recovery journal/)
  assert.equal(recoveryPaths(fs.files).length, 1)
})

test('a later drain migrates a multi-source journal and preserves it until each source acknowledges', () => {
  const fs = runtime({
    '/state/notify.signal.recovery.900.1.deadbeef.json': `${JSON.stringify({
      version: 1,
      sources: ['claude-code', 'codex']
    })}\n`,
    '/state/notify.signal.d/codex.json.900.1.deadbeef.drain': signal('codex')
  })

  assert.deepEqual(drainSignalSources(fs), ['claude-code', 'codex'])
  assert.equal(
    [...fs.files.keys()].some((path) => path.endsWith('.drain')),
    false
  )
  assert.equal(recoveryPaths(fs.files).length, 2)
  assert.deepEqual(readSignalSources(fs), ['claude-code', 'codex'])

  acknowledgeSignalSource(fs, 'codex')
  assert.deepEqual(readSignalSources(fs), ['claude-code'])
  assert.equal(recoveryPaths(fs.files).length, 1)

  acknowledgeSignalSource(fs, 'claude-code')
  assert.equal(recoveryPaths(fs.files).length, 0)
  assert.deepEqual(readSignalSources(fs), [])
})

test('signal drain without rename consumes retained legacy drains through the recovery journal', () => {
  const fs = runtime({
    '/state/notify.signal.900.1.deadbeef.drain': signal('codex')
  })
  delete fs.rename

  assert.deepEqual(drainSignalSources(fs), ['codex'])
  assert.equal(
    [...fs.files.keys()].some((path) => path.endsWith('.drain')),
    false
  )
  assert.equal(recoveryPaths(fs.files).length, 1)

  acknowledgeSignalSource(fs, 'codex')
  assert.equal(recoveryPaths(fs.files).length, 0)
})

test('acknowledging a completed source does not erase a signal queued during its sync', () => {
  const fs = runtime({
    '/state/notify.signal.d/codex.json': signal('codex')
  })

  assert.deepEqual(drainSignalSources(fs), ['codex'])
  appendSignal(fs, { source: 'codex' })
  acknowledgeSignalSource(fs, 'codex')

  assert.equal(recoveryPaths(fs.files).length, 0)
  assert.equal(fs.files.has('/state/notify.signal.d/codex.json'), true)
  assert.deepEqual(readSignalSources(fs), ['codex'])
})

test('drains legacy per-event queue files and retained drains through the recovery journal', () => {
  const fs = runtime({
    '/state/notify.signal.d/1785302092394-95086-5lxdll72uc.json': signal('codex'),
    '/state/notify.signal.d/1785302092395-95087-r5z2h9.json.900.1.deadbeef.drain': signal('claude-code')
  })

  assert.deepEqual(drainSignalSources(fs), ['codex', 'claude-code'])
  assert.equal(fs.files.has('/state/notify.signal.d/1785302092394-95086-5lxdll72uc.json'), false)
  assert.equal(fs.files.has('/state/notify.signal.d/1785302092395-95087-r5z2h9.json.900.1.deadbeef.drain'), false)
  assert.deepEqual(readSignalSources(fs), ['claude-code', 'codex'])

  acknowledgeSignalSource(fs, 'codex')
  acknowledgeSignalSource(fs, 'claude-code')
  assert.deepEqual(readSignalSources(fs), [])
})

test('signal drain tolerates a drained file removed by another worker', () => {
  let reads = 0
  const fs = runtime(
    {
      '/state/notify.signal.900.1.deadbeef.drain': signal('codex')
    },
    {
      readFile(path) {
        reads += 1
        if (path.endsWith('.drain')) {
          const error = new Error('drained signal already consumed')
          error.code = 'ENOENT'
          throw error
        }
        return fs.files.get(path)
      }
    }
  )

  assert.deepEqual(drainSignalSources(fs), [])
  assert.equal(reads, 1)
})
