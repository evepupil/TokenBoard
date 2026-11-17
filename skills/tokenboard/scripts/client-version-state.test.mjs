import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clientVersionStateFileName,
  clientVersionStatePath,
  readClientVersionState,
  recordClientVersion
} from './client-version-state.mjs'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-clientver-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a version is recorded with the time it was first seen', (t) => {
  const dir = tempDir(t)
  const result = recordClientVersion({
    stateDir: dir,
    version: '0.2.0',
    now: () => Date.parse('2026-11-17T00:00:00Z')
  })

  assert.equal(result.changed, true)
  assert.equal(result.version, '0.2.0')
  const state = readClientVersionState(dir)
  assert.equal(state.version, '0.2.0')
  assert.equal(state.since, '2026-11-17T00:00:00.000Z')
})

test('recording the same version again does not move since', (t) => {
  const dir = tempDir(t)
  recordClientVersion({ stateDir: dir, version: '0.2.0', now: () => Date.parse('2026-11-17T00:00:00Z') })
  const again = recordClientVersion({
    stateDir: dir,
    version: '0.2.0',
    now: () => Date.parse('2026-11-17T06:00:00Z')
  })

  assert.equal(again.changed, false)
  assert.equal(readClientVersionState(dir).since, '2026-11-17T00:00:00.000Z')
})

test('a version change reports the previous one and restarts since', (t) => {
  const dir = tempDir(t)
  recordClientVersion({ stateDir: dir, version: '0.2.0', now: () => Date.parse('2026-11-17T00:00:00Z') })
  const changed = recordClientVersion({
    stateDir: dir,
    version: '0.2.1',
    now: () => Date.parse('2026-11-18T00:00:00Z')
  })

  assert.equal(changed.changed, true)
  assert.equal(changed.previous, '0.2.0')
  const state = readClientVersionState(dir)
  assert.equal(state.version, '0.2.1')
  assert.equal(state.previous, '0.2.0')
  assert.equal(state.since, '2026-11-18T00:00:00.000Z')
})

test('a missing or corrupt state file reads as null rather than throwing', (t) => {
  const dir = tempDir(t)
  assert.equal(readClientVersionState(dir), null)

  writeFileSync(join(dir, clientVersionStateFileName), '{not json')
  assert.equal(readClientVersionState(dir), null)
})

// A record that exists but cannot be read is not a first run. Answering null
// here reset `since` and dropped `previous`, so an upgrade that broke the
// machine lost exactly the history that answers "did this happen when the
// version changed?".
test('an unreadable record is reported instead of treated as a first run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-version-unreadable-'))
  writeFileSync(clientVersionStatePath(dir), '{"schemaVersion":"tokenboard-client-version/v1"}', { mode: 0o000 })
  try {
    assert.throws(() => readClientVersionState(dir), /EACCES/)
  } finally {
    chmodSync(clientVersionStatePath(dir), 0o600)
    rmSync(dir, { recursive: true, force: true })
  }
})
