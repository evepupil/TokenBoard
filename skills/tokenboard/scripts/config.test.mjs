import assert from 'node:assert/strict'
import test from 'node:test'
import { packageManagerCommand } from './config.mjs'

test('uses bun.exe on Windows package manager commands', () => {
  assert.equal(packageManagerCommand('bun', 'win32'), 'bun.exe')
})

test('uses cmd shims for npm and pnpm on Windows', () => {
  assert.equal(packageManagerCommand('pnpm', 'win32'), 'pnpm.cmd')
  assert.equal(packageManagerCommand('npm', 'win32'), 'npm.cmd')
})
