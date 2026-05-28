import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildInstallCollectorArgs } from './setup-options.mjs'

test('passes setup repo-url override to install collector', () => {
  assert.deepEqual(
    buildInstallCollectorArgs({
      flags: { 'repo-url': 'https://github.com/example/TokenBoard.git' },
      packageManager: 'pnpm',
      installCollectorScript: '/repo/scripts/install-collector.mjs'
    }),
    [
      '/repo/scripts/install-collector.mjs',
      '--repo-url',
      'https://github.com/example/TokenBoard.git',
      '--package-manager',
      'pnpm'
    ]
  )
})

test('setup installs hooks only after initial sync succeeds', () => {
  const source = readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8')
  const syncIndex = source.indexOf("scriptPath('./sync.mjs')")
  const hookIndex = source.indexOf("scriptPath('./install-hook.mjs')")

  assert.notEqual(syncIndex, -1)
  assert.notEqual(hookIndex, -1)
  assert.ok(syncIndex < hookIndex)
})
