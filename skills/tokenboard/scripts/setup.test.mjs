import assert from 'node:assert/strict'
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
