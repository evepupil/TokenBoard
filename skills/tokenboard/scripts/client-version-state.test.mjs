import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClientVersionState, recordClientVersion, clientVersionStateFileName } from './client-version-state.mjs'

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
