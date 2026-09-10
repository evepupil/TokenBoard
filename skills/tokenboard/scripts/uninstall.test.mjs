import assert from 'node:assert/strict'
import test from 'node:test'
import { uninstallClient } from './uninstall.mjs'

test('uninstalls schedule only by default', () => {
  const harness = createHarness()

  const removed = uninstallClient(harness.options)

  assert.deepEqual(removed, {
    hook: false,
    schedule: true,
    collector: false,
    config: false,
    configDir: false,
    deviceLink: false
  })
  assert.equal(harness.scheduleCalls, 1)
  assert.equal(harness.hookCalls, 0)
  assert.deepEqual(harness.removedPaths, [])
})

test('uninstalls hooks only when explicitly requested', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    argv: ['--remove-hooks']
  })

  assert.deepEqual(removed, {
    hook: true,
    schedule: true,
    collector: false,
    config: false,
    configDir: false,
    deviceLink: false
  })
  assert.equal(harness.scheduleCalls, 1)
  assert.equal(harness.hookCalls, 1)
})

test('removes collector and config only when explicitly requested', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    argv: ['--remove-collector', '--remove-config']
  })

  assert.deepEqual(removed, {
    hook: true,
    schedule: true,
    collector: true,
    config: true,
    configDir: false,
    deviceLink: false
  })
  assert.deepEqual(harness.removedPaths, [
    '/home/tokenboard/.tokenboard/TokenBoard',
    '/home/tokenboard/.tokenboard/config.json'
  ])
})

test('removes hooks when deleting only the config file', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    argv: ['--remove-config']
  })

  assert.deepEqual(removed, {
    hook: true,
    schedule: true,
    collector: false,
    config: true,
    configDir: false,
    deviceLink: false
  })
  assert.equal(harness.hookCalls, 1)
  assert.deepEqual(harness.removedPaths, ['/home/tokenboard/.tokenboard/config.json'])
})

test('removes whole config directory only when explicitly requested', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    argv: ['--remove-config-dir']
  })

  assert.deepEqual(removed, {
    hook: true,
    schedule: true,
    collector: false,
    config: false,
    configDir: true,
    deviceLink: true
  })
  assert.deepEqual(harness.removedPaths, ['/home/tokenboard/.tokenboard'])
})

test('removes collector and config directory with all flag', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    argv: ['--all']
  })

  assert.deepEqual(removed, {
    hook: true,
    schedule: true,
    collector: true,
    config: false,
    configDir: true,
    deviceLink: true
  })
  assert.deepEqual(harness.removedPaths, ['/home/tokenboard/.tokenboard/TokenBoard', '/home/tokenboard/.tokenboard'])
})

for (const flag of ['--all', '--remove-config-dir', '--remove-collector', '--remove-config', '--remove-hooks']) {
  test(`does not remove recovery state after an incomplete Antigravity uninstall with ${flag}`, () => {
    const harness = createHarness()

    assert.throws(
      () =>
        uninstallClient({
          ...harness.options,
          argv: [flag],
          uninstallHooks: () => {
            harness.recordHookCall()
            return {
              hooks: [
                {
                  source: 'antigravity-cli',
                  action: 'skip',
                  changed: false,
                  incomplete: true,
                  detail: 'Antigravity statusline not checked: Invalid Antigravity settings.json'
                }
              ]
            }
          }
        }),
      /Antigravity statusline restoration is incomplete/
    )
    assert.equal(harness.hookCalls, 1)
    assert.equal(harness.scheduleCalls, 1)
    assert.deepEqual(harness.removedPaths, [])
  })
}

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
  assert.deepEqual(harness.removedPaths, ['/home/tokenboard/.tokenboard/TokenBoard', '/home/tokenboard/.tokenboard'])
})

test('does not delete the config directory before the collector when they are the same path', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    collectorDir: '/home/tokenboard/.tokenboard',
    argv: ['--all']
  })

  assert.deepEqual(removed, {
    hook: true,
    schedule: true,
    collector: false,
    config: false,
    configDir: true,
    deviceLink: true
  })
  assert.deepEqual(harness.removedPaths, ['/home/tokenboard/.tokenboard'])
})

test('treats case-variant Windows collector and config paths as the same path', () => {
  const harness = createHarness()

  const removed = uninstallClient({
    ...harness.options,
    platform: 'win32',
    collectorDir: 'C:\\Users\\TokenBoard\\.tokenboard',
    configDir: 'c:\\users\\tokenboard\\.TOKENBOARD',
    configPath: 'c:\\users\\tokenboard\\.TOKENBOARD\\config.json',
    deviceLinkPath: 'c:\\users\\tokenboard\\.TOKENBOARD\\device-link.json',
    argv: ['--all'],
    exists: (path) => path.toLowerCase().includes('tokenboard')
  })

  assert.equal(removed.collector, false)
  assert.equal(removed.configDir, true)
})

test('does not change directory for a Windows cwd on another drive', () => {
  const harness = createHarness()
  let chdirCalls = 0

  const removed = uninstallClient({
    ...harness.options,
    platform: 'win32',
    collectorDir: 'C:\\Users\\TokenBoard\\.tokenboard\\TokenBoard',
    configDir: 'C:\\Users\\TokenBoard\\.tokenboard',
    configPath: 'C:\\Users\\TokenBoard\\.tokenboard\\config.json',
    deviceLinkPath: 'C:\\Users\\TokenBoard\\.tokenboard\\device-link.json',
    fallbackCwd: 'Z:\\missing',
    cwd: () => 'D:\\work',
    chdir: () => {
      chdirCalls += 1
      throw new Error('fallback directory should not be used')
    },
    exists: () => true,
    argv: ['--all']
  })

  assert.equal(chdirCalls, 0)
  assert.equal(removed.collector, true)
  assert.equal(removed.configDir, true)
})

test('changes directory for a Windows cwd in a child named ..cache', () => {
  const harness = createHarness()
  let chdirCalls = 0

  uninstallClient({
    ...harness.options,
    platform: 'win32',
    collectorDir: 'C:\\work\\.tokenboard\\TokenBoard',
    configDir: 'C:\\work\\.tokenboard',
    configPath: 'C:\\work\\.tokenboard\\config.json',
    deviceLinkPath: 'C:\\work\\.tokenboard\\device-link.json',
    fallbackCwd: 'C:\\safe',
    cwd: () => 'C:\\work\\.tokenboard\\..cache',
    chdir: () => {
      chdirCalls += 1
    },
    exists: () => true,
    argv: ['--all']
  })

  assert.equal(chdirCalls, 1)
})

function createHarness() {
  const existingPaths = new Set([
    '/home/tokenboard/.tokenboard',
    '/home/tokenboard/.tokenboard/TokenBoard',
    '/home/tokenboard/.tokenboard/config.json',
    '/home/tokenboard/.tokenboard/device-link.json'
  ])
  const removedPaths = []
  const changedDirectories = []
  const calls = {
    hook: 0,
    schedule: 0
  }
  return {
    get hookCalls() {
      return calls.hook
    },
    get scheduleCalls() {
      return calls.schedule
    },
    removedPaths,
    changedDirectories,
    recordHookCall() {
      calls.hook += 1
    },
    options: {
      collectorDir: '/home/tokenboard/.tokenboard/TokenBoard',
      configDir: '/home/tokenboard/.tokenboard',
      configPath: '/home/tokenboard/.tokenboard/config.json',
      deviceLinkPath: '/home/tokenboard/.tokenboard/device-link.json',
      fallbackCwd: '/home/tokenboard',
      log: () => {},
      exists: (path) => existingPaths.has(path),
      rm: (path) => {
        removedPaths.push(path)
        existingPaths.delete(path)
      },
      uninstallSchedule: () => {
        calls.schedule += 1
      },
      uninstallHooks: () => {
        calls.hook += 1
      }
    }
  }
}
