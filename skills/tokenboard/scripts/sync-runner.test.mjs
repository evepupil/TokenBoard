import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSyncInvocation } from './sync.mjs'

test('builds Windows sync invocation with semicolon PATH delimiter', () => {
  const invocation = buildSyncInvocation({
    flags: { mode: 'sync' },
    config: {
      collectorDir: 'C:\\Users\\tokenboard\\.tokenboard\\TokenBoard',
      endpoint: 'https://tokenboard.example',
      uploadToken: 'token',
      timezone: 'Asia/Shanghai',
      source: 'all',
      packageManager: 'pnpm'
    },
    pathEnv: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    homeDir: 'C:\\Users\\tokenboard',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32'
  })

  assert.equal(invocation.env.PATH, 'C:\\Users\\tokenboard\\.bun\\bin;C:\\Users\\tokenboard\\.local\\bin;C:\\Program Files\\nodejs;C:\\Windows\\System32')
})

test('builds Windows bun sync invocation with bun executable', () => {
  const invocation = buildSyncInvocation({
    flags: { mode: 'preview', 'package-manager': 'bun' },
    config: {
      collectorDir: 'C:\\Users\\tokenboard\\.tokenboard\\TokenBoard',
      endpoint: 'https://tokenboard.example',
      uploadToken: 'token',
      timezone: 'Asia/Shanghai',
      source: 'all'
    },
    pathEnv: 'C:\\Windows\\System32',
    homeDir: 'C:\\Users\\tokenboard',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32'
  })

  assert.equal(invocation.command, 'bun.exe')
  assert.equal(invocation.shell, false)
  assert.deepEqual(invocation.args, ['run', 'preview', '--source', 'all'])
})
