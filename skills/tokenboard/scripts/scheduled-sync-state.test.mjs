import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isScheduledSyncState,
  readScheduledSyncState,
  scheduledSyncStatePath,
  writeScheduledSyncState
} from './scheduled-sync-state.mjs'

test('scheduled sync state is written atomically with canonical timestamps', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tokenboard-scheduled-state-'))
  try {
    const state = writeScheduledSyncState({
      stateDir,
      source: 'all',
      status: 'success',
      startedAt: '2026-09-20T09:00:00+08:00',
      updatedAt: Date.parse('2026-09-20T01:05:00.000Z'),
      completedAt: new Date('2026-09-20T01:05:00.000Z'),
      exitCode: 0,
      error: 'private detail must not be exposed by status'
    })

    assert.deepEqual(state, {
      schemaVersion: 'tokenboard-scheduled-sync/v1',
      source: 'all',
      status: 'success',
      startedAt: '2026-09-20T01:00:00.000Z',
      updatedAt: '2026-09-20T01:05:00.000Z',
      completedAt: '2026-09-20T01:05:00.000Z',
      exitCode: 0,
      error: 'private detail must not be exposed by status'
    })
    assert.deepEqual(readScheduledSyncState(scheduledSyncStatePath(stateDir)), state)
    assert.doesNotMatch(readFileSync(scheduledSyncStatePath(stateDir), 'utf8'), /\.tmp-/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

// An exit code outside 0-255 cannot come from a process, so writing one would put a value
// in the state file that no reader can act on. Silently dropping it is worse: an absent
// exitCode is how a still-running or never-finished run reads. The module already throws
// for an out-of-contract `status`, and this follows that treatment.
test('scheduled sync state rejects an exit code outside the process range', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tokenboard-scheduled-state-'))
  try {
    for (const exitCode of [-1, 256, 1.5, Number.NaN]) {
      assert.throws(
        () =>
          writeScheduledSyncState({
            stateDir,
            source: 'all',
            status: 'failed',
            updatedAt: Date.parse('2026-09-20T01:05:00.000Z'),
            exitCode
          }),
        /Invalid TokenBoard scheduled sync exit code/
      )
    }
    // The boundary values are still accepted.
    for (const exitCode of [0, 1, 75, 255]) {
      const state = writeScheduledSyncState({
        stateDir,
        source: 'all',
        status: 'failed',
        updatedAt: Date.parse('2026-09-20T01:05:00.000Z'),
        exitCode
      })
      assert.equal(state.exitCode, exitCode)
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('scheduled sync state isolates non-all sources while preserving the all-source path', () => {
  const stateDir = join(tmpdir(), 'tokenboard-scheduled-state-paths')

  assert.equal(scheduledSyncStatePath(stateDir), join(stateDir, 'scheduled-sync-state.json'))
  assert.equal(scheduledSyncStatePath(stateDir, 'all'), join(stateDir, 'scheduled-sync-state.json'))
  assert.equal(scheduledSyncStatePath(stateDir, 'codex'), join(stateDir, 'scheduled-sync-state.codex.json'))
  assert.equal(scheduledSyncStatePath(stateDir, 'claude-code'), join(stateDir, 'scheduled-sync-state.claude-code.json'))
  assert.notEqual(scheduledSyncStatePath(stateDir, 'codex'), scheduledSyncStatePath(stateDir, 'claude-code'))
})

test('scheduled sync state rejects malformed timestamps and exposes invalid state', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tokenboard-scheduled-state-invalid-'))
  try {
    const path = scheduledSyncStatePath(stateDir)
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 'tokenboard-scheduled-sync/v1',
        source: 'all',
        status: 'success',
        startedAt: '2026-09-20',
        updatedAt: '2026-09-20T01:05:00.000Z'
      })
    )
    assert.deepEqual(readScheduledSyncState(path), { status: 'invalid' })
    assert.equal(isScheduledSyncState({}), false)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('scheduled sync state reports an unreadable state path instead of treating it as missing', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tokenboard-scheduled-state-unreadable-'))
  try {
    const path = scheduledSyncStatePath(stateDir)
    writeFileSync(path, '{}')
    const error = new Error('permission denied')
    error.code = 'EACCES'
    assert.throws(
      () =>
        readScheduledSyncState(path, {
          readFile: () => {
            throw error
          }
        }),
      /permission denied/
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
