import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildInitialSyncArgs,
  buildInstallCollectorArgs,
  buildWarmHookCursorArgs,
  readSetupBaseUrl,
  shouldWarmHookCursorsBeforeInstall
} from './setup-options.mjs'

test('initial setup sync uses a full history scan by default', () => {
  assert.deepEqual(
    buildInitialSyncArgs({ flags: {} }),
    ['--mode', 'sync', '--source', 'all', '--since', 'all']
  )
})

test('initial setup sync forwards an explicit since value', () => {
  assert.deepEqual(
    buildInitialSyncArgs({ flags: { since: '20260501' } }),
    ['--mode', 'sync', '--source', 'all', '--since', '20260501']
  )
})

test('setup warms hook cursors before installing hooks when initial sync is skipped', () => {
  assert.equal(shouldWarmHookCursorsBeforeInstall({ 'skip-initial-sync': true }), true)
})

test('setup warms hook cursors before installing hooks when initial sync is bounded', () => {
  assert.equal(shouldWarmHookCursorsBeforeInstall({ since: '20260501' }), true)
})

test('setup does not warm hook cursors after a full initial sync', () => {
  assert.equal(shouldWarmHookCursorsBeforeInstall({}), false)
  assert.equal(shouldWarmHookCursorsBeforeInstall({ since: 'all' }), false)
})

test('setup hook cursor warm command uses all sources', () => {
  assert.deepEqual(
    buildWarmHookCursorArgs({ packageManager: 'pnpm' }),
    ['--mode', 'warm-hooks', '--source', 'all', '--skip-upgrade', '--package-manager', 'pnpm']
  )
})

test('setup base url must come from flags or environment', () => {
  assert.equal(readSetupBaseUrl({ flags: {}, env: {} }), null)
  assert.equal(
    readSetupBaseUrl({ flags: {}, env: { TOKENBOARD_BASE_URL: 'https://tokenboard.example.com/' } }),
    'https://tokenboard.example.com'
  )
  assert.equal(
    readSetupBaseUrl({
      flags: { 'base-url': 'https://install.tokenboard.example.com/' },
      env: { TOKENBOARD_BASE_URL: 'https://tokenboard.example.com' }
    }),
    'https://install.tokenboard.example.com'
  )
})

test('setup passes repo-url override to install collector', () => {
  assert.deepEqual(
    buildInstallCollectorArgs({
      flags: { 'repo-url': 'https://github.com/example/TokenBoard.git' },
      installCollectorScript: '/repo/scripts/install-collector.mjs'
    }),
    [
      '/repo/scripts/install-collector.mjs',
      '--repo-url',
      'https://github.com/example/TokenBoard.git'
    ]
  )
})
