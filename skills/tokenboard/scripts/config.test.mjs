import assert from 'node:assert/strict'
import test from 'node:test'
import { stripUtf8Bom, packageManagerCommand } from './config.mjs'

test('strips UTF-8 BOM before parsing config content', () => {
  const parsed = JSON.parse(stripUtf8Bom('\ufeff{"configured":true}'))

  assert.deepEqual(parsed, { configured: true })
})

test('leaves non-BOM config content unchanged', () => {
  const config = '{"configured":true}'

  assert.equal(stripUtf8Bom(config), config)
})

test('uses bun.exe on Windows package manager commands', () => {
  assert.equal(packageManagerCommand('bun', 'win32'), 'bun.exe')
})

test('uses executable package manager commands on Windows when available', () => {
  assert.equal(packageManagerCommand('pnpm', 'win32'), 'pnpm.exe')
  assert.equal(packageManagerCommand('npm', 'win32'), 'npm.cmd')
})
