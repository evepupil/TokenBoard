import assert from 'node:assert/strict'
import test from 'node:test'
import { uninstallClient } from './uninstall.mjs'

test('uninstalls schedule only by default', () => {
  const harness = createHarness()

  const removed = uninstallClient(harness.options)

  assert.deepEqual(removed, {
    schedule: true,
    collector: false,
    config: false,
    configDir: false
  })
  assert.equal(harness.scheduleCalls, 1)
  assert.deepEqual(harness.removedPaths, [])
})

test('removes collector and config only when explicitly requested', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    argv: ['--remove-collector', '--remove-config']
  })

  assert.deepEqual(removed, {
    schedule: true,
    collector: true,
    config: true,
    configDir: false
  })
  assert.deepEqual(harness.removedPaths, [
    '/home/tokenboard/.tokenboard/TokenBoard',
    '/home/tokenboard/.tokenboard/config.json'
  ])
})

test('removes whole config directory only when explicitly requested', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    argv: ['--remove-config-dir']
  })

  assert.deepEqual(removed, {
    schedule: true,
    collector: false,
    config: false,
    configDir: true
  })
  assert.deepEqual(harness.removedPaths, [
    '/home/tokenboard/.tokenboard'
  ])
})

test('removes collector and config directory with all flag', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    argv: ['--all']
  })

  assert.deepEqual(removed, {
    schedule: true,
    collector: true,
    config: false,
    configDir: true
  })
  assert.deepEqual(harness.removedPaths, [
    '/home/tokenboard/.tokenboard/TokenBoard',
    '/home/tokenboard/.tokenboard'
  ])
})

test('leaves collector directory before removing it', () => {
  const harness = createHarness()
  let currentDirectory = '/home/tokenboard/.tokenboard/TokenBoard/skills/tokenboard'

  uninstallClient({
    ...harness.options,
    argv: ['--all'],
    cwd: () => currentDirectory,
    chdir: (path) => {
      currentDirectory = path
      harness.changedDirectories.push(path)
    }
  })

  assert.deepEqual(harness.changedDirectories, ['/home/tokenboard'])
  assert.deepEqual(harness.removedPaths, [
    '/home/tokenboard/.tokenboard/TokenBoard',
    '/home/tokenboard/.tokenboard'
  ])
})

test('does not delete the config directory before the collector when they are the same path', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    collectorDir: '/home/tokenboard/.tokenboard',
    argv: ['--all']
  })

  assert.deepEqual(removed, {
    schedule: true,
    collector: false,
    config: false,
    configDir: true
  })
  assert.deepEqual(harness.removedPaths, [
    '/home/tokenboard/.tokenboard'
  ])
})

function createHarness() {
  const existingPaths = new Set([
    '/home/tokenboard/.tokenboard',
    '/home/tokenboard/.tokenboard/TokenBoard',
    '/home/tokenboard/.tokenboard/config.json'
  ])
  const removedPaths = []
  const changedDirectories = []
  const harness = {
    scheduleCalls: 0,
    removedPaths,
    changedDirectories,
    options: {
      collectorDir: '/home/tokenboard/.tokenboard/TokenBoard',
      configDir: '/home/tokenboard/.tokenboard',
      configPath: '/home/tokenboard/.tokenboard/config.json',
      fallbackCwd: '/home/tokenboard',
      log: () => {},
      exists: (path) => existingPaths.has(path),
      rm: (path) => {
        removedPaths.push(path)
        existingPaths.delete(path)
      },
      uninstallSchedule: () => {
        harness.scheduleCalls += 1
      }
    }
  }
  return harness
}
