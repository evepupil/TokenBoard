import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInvocation } from './tokenboard.mjs'

test('builds bun invocation with bun x tsx', () => {
  assert.deepEqual(
    buildInvocation({ packageManager: 'bun', platform: 'darwin', passthroughArgs: ['preview'] }),
    {
      command: 'bun',
      args: ['x', 'tsx', 'src/cli.ts', 'preview']
    }
  )
})

test('uses bun.exe on Windows', () => {
  assert.deepEqual(
    buildInvocation({ packageManager: 'bun', platform: 'win32', passthroughArgs: ['sync'] }),
    {
      command: 'bun.exe',
      args: ['x', 'tsx', 'src/cli.ts', 'sync']
    }
  )
})
