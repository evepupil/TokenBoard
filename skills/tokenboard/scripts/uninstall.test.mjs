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

// `TOKENBOARD_CONFIG_DIR` is unvalidated and the removal is recursive, so a value like
// `$HOME` or `/` used to delete that whole tree with no prompt. A TokenBoard config
// directory is always the tool's own `~/.tokenboard` (or a `.tokenboard-*` variant), never
// a home directory, a filesystem root, or another dot-directory the user happens to own.
for (const unsafe of [
  '/home/tokenboard',
  '/',
  '/tmp',
  '/home',
  'relative-config',
  '/Users/example',
  // Dot-directories the tool never created: an "any dot-directory" guard would delete these
  // recursively, taking SSH keys, cloud credentials, or the user's Claude config with them.
  '/Users/example/.ssh',
  '/Users/example/.aws',
  '/Users/example/.claude',
  '/Users/example/.config',
  '/home/tokenboard/.gnupg'
]) {
  test(`refuses to remove an unsafe config directory: ${unsafe}`, () => {
    const harness = createHarness()

    // The harness only reports its seeded paths as existing, so the unsafe directory has
    // to be seeded too — otherwise the handler skips the branch before the guard runs.
    harness.options.exists = (p) => p === unsafe || p.startsWith('/home/tokenboard/.tokenboard')

    assert.throws(
      () => uninstallClient({ ...harness.options, configDir: unsafe, argv: ['--remove-config-dir'] }),
      /Refusing to remove/
    )
    assert.deepEqual(harness.removedPaths, [])
  })
}

for (const safe of [
  '/home/tokenboard/.tokenboard',
  '/home/tokenboard/.tokenboard-work',
  // A user whose home is `/root` installs into `/root/.tokenboard`: two segments, but
  // still the tool's own directory. The old three-segment minimum refused it, so
  // `sudo` installs could not be uninstalled at all.
  '/root/.tokenboard'
]) {
  test(`still removes the tool's own config dir: ${safe}`, () => {
    const harness = createHarness()

    const removed = uninstallClient({
      ...harness.options,
      configDir: safe,
      exists: (p) => p === safe,
      argv: ['--remove-config-dir']
    })

    assert.equal(removed.configDir, true)
    assert.deepEqual(harness.removedPaths, [safe])
  })
}

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
    // The schedule is removed even on this abort: what the throw preserves is the recovery
    // data (the collector and config directories), and stopping the scheduled syncs is
    // part of the uninstall the user asked for.
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

// `TOKENBOARD_COLLECTOR_DIR` is unvalidated and the collector checkout is removed
// recursively, so a value like `$HOME` used to delete that whole tree. The checkout has no
// fixed name — an override may point at any clone — so identity is checked by content: a
// real checkout carries package.json and skills/tokenboard, and anything else is refused.
// Validation runs before the hooks and schedule are touched, so a refusal leaves the
// machine exactly as it was.
for (const unsafe of ['/home/tokenboard', '/', '/tmp', '/home/tokenboard/.ssh', '/home/tokenboard/notes']) {
  test(`refuses to remove a collector directory without checkout markers: ${unsafe}`, () => {
    const harness = createHarness()

    assert.throws(
      () =>
        uninstallClient({
          ...harness.options,
          collectorDir: unsafe,
          argv: ['--remove-collector'],
          exists: (p) => p === unsafe || p.startsWith('/home/tokenboard/.tokenboard')
        }),
      /Refusing to remove/
    )
    assert.deepEqual(harness.removedPaths, [])
    assert.equal(harness.hookCalls, 0)
    assert.equal(harness.scheduleCalls, 0)
  })
}

test('refuses a home directory even when it carries checkout markers', () => {
  const harness = createHarness()

  assert.throws(
    () =>
      uninstallClient({
        ...harness.options,
        collectorDir: '/home/tokenboard',
        argv: ['--remove-collector'],
        exists: () => true
      }),
    /Refusing to remove/
  )
  assert.deepEqual(harness.removedPaths, [])
  assert.equal(harness.hookCalls, 0)
  assert.equal(harness.scheduleCalls, 0)
})

// The collector is removed before the config directory in the `--all` flow. Validating both
// targets up front is what keeps a refused config directory from leaving the machine with
// the collector already gone — and, since the guards run before any teardown, with the
// hooks or schedule already removed either.
test('validates the config directory before removing the collector', () => {
  const harness = createHarness()

  assert.throws(
    () =>
      uninstallClient({
        ...harness.options,
        configDir: '/home/tokenboard/.ssh',
        argv: ['--all'],
        exists: (p) => p === '/home/tokenboard/.ssh' || p.startsWith('/home/tokenboard/.tokenboard')
      }),
    /Refusing to remove/
  )
  assert.deepEqual(harness.removedPaths, [])
  assert.equal(harness.hookCalls, 0)
  assert.equal(harness.scheduleCalls, 0)
})

// `--remove-config` deletes the single config file without the directory guard the
// recursive delete has. The file only ever lives inside the tool's own config directory,
// so a stray `TOKENBOARD_CONFIG_DIR` must not turn this into "delete some other
// directory's config.json".
test('refuses to remove the config file from a directory that is not a TokenBoard directory', () => {
  const harness = createHarness()

  assert.throws(
    () =>
      uninstallClient({
        ...harness.options,
        configDir: '/home/tokenboard/.ssh',
        configPath: '/home/tokenboard/.ssh/config.json',
        argv: ['--remove-config'],
        exists: (p) => p === '/home/tokenboard/.ssh/config.json' || p.startsWith('/home/tokenboard/.tokenboard')
      }),
    /Refusing to remove/
  )
  assert.deepEqual(harness.removedPaths, [])
  assert.equal(harness.hookCalls, 0)
  assert.equal(harness.scheduleCalls, 0)
})

function createHarness() {
  const existingPaths = new Set([
    '/home/tokenboard/.tokenboard',
    '/home/tokenboard/.tokenboard/TokenBoard',
    '/home/tokenboard/.tokenboard/TokenBoard/package.json',
    '/home/tokenboard/.tokenboard/TokenBoard/skills/tokenboard',
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
      homeDir: '/home/tokenboard',
      // The seeded paths above are POSIX, so the guard must resolve them with the
      // POSIX path API regardless of the host. The Windows-specific tests pass
      // `platform: 'win32'` alongside Windows-style paths of their own.
      platform: 'linux',
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
