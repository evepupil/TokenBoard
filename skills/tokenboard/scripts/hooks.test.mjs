import assert from 'node:assert/strict'
import test from 'node:test'
import { win32 as windowsPath } from 'node:path'
import { runInNewContext } from 'node:vm'
import { normalizeMemoryPath } from './coordinator-test-helpers.mjs'
import {
  buildNotifyHandler,
  hookPaths,
  hookStatus,
  installHooks,
  refreshInstalledNotifyHandler,
  uninstallHooks
} from './hooks.mjs'

test('notify handler only enqueues signal and spawns background notify script', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /const SIGNAL_DIR = join\(STATE_DIR, "notify\.signal\.d"\)/)
  assert.match(source, /writeQueuedSignal\(signalPayload, source\)/)
  assert.match(source, /spawn\(NODE_PATH, \[NOTIFY_SCRIPT/)
  assert.match(source, /detached: true/)
  assert.equal(source.match(/windowsHide: true/g)?.length, 4)
  assert.match(source, /const PROCESS_START_IDENTITY_CACHE = new Map\(\)/)
  assert.match(source, /const shouldCache = pid === process\.pid/)
  assert.match(source, /const cached = shouldCache \? PROCESS_START_IDENTITY_CACHE\.get\(cacheKey\) : undefined/)
  assert.match(source, /if \(shouldCache\) PROCESS_START_IDENTITY_CACHE\.set\(cacheKey, result\)/)
  assert.doesNotMatch(source, /ccusage/)
})

test('notify handler preserves legacy signal append when queued signal rename fails', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /let queueError;/)
  assert.match(
    source,
    /if \(queueError\) \{\s+appendFileSync\(join\(STATE_DIR, "notify\.signal"\), signalPayload, "utf8"\);/
  )
  assert.match(source, /unlinkSync\(tempPath\);/)
})

test('notify handler passes its configured state directory to the background notify script', () => {
  const source = buildNotifyHandler({
    stateDir: '/custom/tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /TOKENBOARD_CONFIG_DIR: STATE_DIR/)
  assert.match(source, /TOKENBOARD_STATE_DIR: STATE_DIR/)
})

test('notify handler uses the current Unix runtime and the configured Windows runtime', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/old/node'
  })

  const declaration = source.match(/const NODE_PATH = [\s\S]*?;\n/)?.[0]
  assert.ok(declaration)
  const evaluate = (platform) => {
    const context = {
      process: { platform, execPath: '/current/node' },
      result: undefined
    }
    runInNewContext(`${declaration}\nresult = NODE_PATH;`, context)
    return context.result
  }

  assert.equal(evaluate('darwin'), '/current/node')
  assert.equal(evaluate('linux'), '/current/node')
  assert.equal(evaluate('win32'), '/old/node')
})

test('notify handler resolves Windows tasklist from an absolute System32 path instead of PATH', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /System32[\s\S]*tasklist\.exe/)
  assert.match(source, /\^\[A-Za-z\]:\[\\\\\//)
  assert.doesNotMatch(source, /TASKLIST_COMMAND = process\.platform/)
  assert.doesNotMatch(source, /:\s*"tasklist";/)
})

test('notify handler falls back to an absolute Windows system root for missing or drive-relative SystemRoot', () => {
  assertTasklistPaths(generatedTasklistPaths(), 'C:\\Windows')
  assertTasklistPaths(generatedTasklistPaths('C:relative'), 'C:\\Windows')
  assertTasklistPaths(generatedTasklistPaths('D:\\Windows'), 'D:\\Windows')
  assertTasklistPaths(generatedTasklistPaths('\\\\server\\share\\Windows'), 'C:\\Windows')
})

test('notify handler forwards Codex payload args to the preserved original notify command', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /const payloadArgs = \[\];/)
  assert.match(source, /spawnOriginalNotify\(cmd\[0\], \[\.\.\.cmd\.slice\(1\), \.\.\.payloadArgs\]\)/)
})

test('notify handler quotes Windows shim arguments and rejects shell metacharacters', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })
  const start = source.indexOf('function spawnOriginalNotify(')
  const end = source.indexOf('function acquireDispatchLock', start)
  assert.ok(start >= 0 && end > start)

  const calls = []
  const context = {
    process: { platform: 'win32', env: { ComSpec: 'C:\\\\Windows\\\\System32\\\\cmd.exe' } },
    spawn: (...args) => {
      calls.push(args)
      return { once() {}, unref() {} }
    },
    result: undefined
  }
  runInNewContext(
    `${source.slice(start, end)}\nresult = spawnOriginalNotify('C:\\\\Program Files (x86)\\\\notify.cmd', ['C:\\\\work\\\\', 'value with spaces']);`,
    context
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'C:\\\\Windows\\\\System32\\\\cmd.exe')
  assert.equal(calls[0][1][0], '/d')
  assert.equal(calls[0][1][1], '/s')
  assert.equal(calls[0][1][2], '/c')
  assert.equal(calls[0][1][3].startsWith('""C:\\Program Files (x86)\\notify.cmd" '), true)
  assert.equal(calls[0][1][3].includes('"C:\\work\\\\"'), true)
  assert.equal(calls[0][1][3].endsWith('"value with spaces""'), true)
  assert.throws(
    () =>
      runInNewContext(
        `${source.slice(start, end)}\nspawnOriginalNotify('C:\\\\notify.cmd', ['safe&unsafe']);`,
        context
      ),
    /Refusing unsafe Windows original notify argument/
  )
})

test('notify handler treats shell-string references to itself as self notify commands', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /part\.includes\(SELF_PATH\)/)
})

test('notify handler keeps forwarding when live stale-lock restoration throws', () => {
  const source = buildNotifyHandler({
    stateDir: '/state',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })
  const removeStart = source.indexOf('function removeStaleDispatchLock()')
  const releaseStart = source.indexOf('function releaseOwnedDispatchFile', removeStart)
  const restoreStart = source.indexOf('function restoreDispatchFile')
  const quarantineStart = source.indexOf('function dispatchQuarantinePath')
  assert.ok(
    removeStart >= 0 && releaseStart > removeStart && restoreStart > releaseStart && quarantineStart > restoreStart
  )

  const files = new Map([['/state/notify.dispatch.lock', '{"token":"owner"}']])
  const errors = []
  const context = {
    DISPATCH_LOCK_PATH: '/state/notify.dispatch.lock',
    process: { pid: 123 },
    renameSync(from, to) {
      files.set(to, files.get(from))
      files.delete(from)
    },
    readDispatchFile: () => ({ token: 'owner' }),
    isDispatchLockOwnerAlive: () => true,
    unlinkSync: (path) => files.delete(path),
    linkSync: () => {
      const error = new Error('restore failed')
      error.code = 'EACCES'
      throw error
    },
    removeDispatchWorker: () => {},
    recordHandlerError: (stage, error) => errors.push({ stage, message: error.message }),
    isMissingFileError: () => false,
    result: undefined
  }
  const declarations = [
    source.slice(removeStart, releaseStart),
    source.slice(restoreStart, quarantineStart),
    source.slice(quarantineStart, source.indexOf('function isDispatchLockOwnerAlive', quarantineStart))
  ].join('\n')
  runInNewContext(`${declarations}\nresult = removeStaleDispatchLock();`, context)
  assert.equal(context.result, false)
  assert.deepEqual(errors, [{ stage: 'dispatch-lock', message: 'restore failed' }])
})

test('generated handler keeps a live trailing worker when identity probing is unknown', () => {
  const source = buildNotifyHandler({
    stateDir: '/state',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })
  const start = source.indexOf('function hasLiveTrailingWorker()')
  const end = source.indexOf('function setDispatchWorkerPid', start)
  assert.ok(start >= 0 && end > start)
  const context = {
    STATE_DIR: '/state',
    process: { pid: 1 },
    join: (...parts) => parts.join('/'),
    readFileSync: () =>
      JSON.stringify({
        pid: 99,
        processStartIdentity: 'linux:boot-a:100'
      }),
    isProcessAlive: () => true,
    probeProcessStartIdentity: () => ({ status: 'unknown' }),
    result: undefined
  }

  runInNewContext(`${source.slice(start, end)}\nresult = hasLiveTrailingWorker();`, context)
  assert.equal(context.result, true)
})

test('generated handler keeps a live dispatch worker when identity probing is unknown', () => {
  const source = buildNotifyHandler({
    stateDir: '/state',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })
  const start = source.indexOf('function isDispatchLockOwnerAlive')
  const end = source.indexOf('function readDispatchFile', start)
  assert.ok(start >= 0 && end > start)
  const context = {
    process: { pid: 1 },
    readDispatchWorker: () => ({
      token: 'dispatch-token',
      pid: 99,
      processStartIdentity: 'linux:boot-a:100'
    }),
    isDispatchLockStarting: () => false,
    isProcessAlive: () => true,
    isDispatchWorkerIdentityProbeStarting: () => false,
    probeProcessStartIdentity: () => ({ status: 'unknown' }),
    result: undefined
  }

  runInNewContext(
    `${source.slice(start, end)}\nresult = isDispatchLockOwnerAlive({ token: 'dispatch-token' });`,
    context
  )
  assert.equal(context.result, true)
})

test('generated handler keeps an unverified dispatch worker during its identity probe grace period', () => {
  const source = buildNotifyHandler({
    stateDir: '/state',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })
  const start = source.indexOf('function isDispatchLockOwnerAlive')
  const end = source.indexOf('function readDispatchFile', start)
  assert.ok(start >= 0 && end > start)
  const context = {
    process: { pid: 1 },
    readDispatchWorker: () => ({
      token: 'dispatch-token',
      pid: 99,
      identityProbeStartedAt: new Date().toISOString()
    }),
    isDispatchLockStarting: () => false,
    isProcessAlive: () => true,
    isDispatchWorkerIdentityProbeStarting: () => true,
    probeProcessStartIdentity: () => ({ status: 'unknown' }),
    result: undefined
  }

  runInNewContext(
    `${source.slice(start, end)}\nresult = isDispatchLockOwnerAlive({ token: 'dispatch-token' });`,
    context
  )
  assert.equal(context.result, true)
})

test('hook paths prefer CLAUDE_CONFIG_DIR for Claude settings', () => {
  const paths = hookPaths({
    homeDir: '/home/user',
    stateDir: '/home/user/.tokenboard',
    env: {
      CLAUDE_CONFIG_DIR: '/custom/claude-config',
      CLAUDE_HOME: '/legacy/claude-home'
    }
  })

  assert.equal(normalizeMemoryPath(paths.claudeSettingsPath).endsWith('/custom/claude-config/settings.json'), true)
})

test('hook paths include Antigravity CLI, IDE, and standalone homes', () => {
  const paths = hookPaths({
    homeDir: '/home/user',
    stateDir: '/home/user/.tokenboard',
    env: {
      ANTIGRAVITY_CONFIG_DIR: '/custom/agy-cli',
      ANTIGRAVITY_IDE_CONFIG_DIR: '/custom/agy-ide',
      ANTIGRAVITY_APP_CONFIG_DIR: '/custom/agy-app'
    }
  })

  assert.equal(normalizeMemoryPath(paths.antigravitySettingsPath).endsWith('/custom/agy-cli/settings.json'), true)
  assert.equal(normalizeMemoryPath(paths.antigravityIdePath).endsWith('/custom/agy-ide'), true)
  assert.equal(normalizeMemoryPath(paths.antigravityPath).endsWith('/custom/agy-app'), true)
})

function generatedTasklistPaths(systemRoot) {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })
  const declarations = source.match(/const SYSTEM_ROOT = [\s\S]*?\n\);\n(?=const NODE_PATH)/)?.[0]
  assert.ok(declarations)
  const context = {
    process: { env: systemRoot === undefined ? {} : { SystemRoot: systemRoot } },
    windowsPath,
    result: undefined
  }

  runInNewContext(`${declarations}\nresult = { systemRoot: SYSTEM_ROOT, command: TASKLIST_COMMAND };`, context)
  return context.result
}

function assertTasklistPaths(result, systemRoot) {
  assert.equal(result.systemRoot, systemRoot)
  assert.equal(result.command, `${systemRoot}\\System32\\tasklist.exe`)
  assert.equal(windowsPath.isAbsolute(result.systemRoot), true)
  assert.equal(windowsPath.isAbsolute(result.command), true)
}

test('status detects Antigravity GUI products with local history support', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.antigravityIdePath]: '',
    [paths.antigravityPath]: ''
  })

  const status = hookStatus({ paths, fs })

  assert.equal(status.antigravityCli, 'not-installed')
  assert.equal(status.antigravityIde, 'installed-local-history')
  assert.equal(status.antigravity, 'installed-local-history')
})

test('rejects unsupported hook sources even when all is also present', () => {
  const paths = createPaths()
  const fs = memoryFs({})

  assert.throws(
    () => installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'all,typo' } }),
    /Unsupported hook source: typo/
  )
  assert.equal(fs.files.has(paths.notifyPath), false)
})

test('installs and restores Codex notify while preserving original command', () => {
  const fs = memoryFs({
    '/home/user/.codex/config.toml': 'model = "gpt-5"\nnotify = ["old", "--flag"]\n'
  })
  const paths = createPaths()

  const installed = installHooks({
    paths,
    fs,
    nodePath: '/usr/bin/node',
    platform: 'linux',
    flags: { source: 'codex' }
  })

  assert.equal(installed.hooks[0].changed, true)
  assert.match(
    fs.files.get(paths.codexConfigPath),
    /notify = \["\/usr\/bin\/env", "node", "\/home\/user\/\.tokenboard\/bin\/notify\.cjs", "--source=codex"\]/
  )
  assert.match(fs.files.get(paths.codexOriginalPath), /"old"/)
  assert.equal(hookStatus({ paths, fs }).codex, 'installed')

  const removed = uninstallHooks({ paths, fs, platform: 'linux', flags: { source: 'codex' } })

  assert.equal(removed.hooks[0].changed, true)
  assert.match(fs.files.get(paths.codexConfigPath), /notify = \["old", "--flag"\]/)
})

test('refreshes the generated handler for an already installed Codex hook', () => {
  const paths = createPaths()
  const codexConfig = `model = "gpt-5"\nnotify = ["/usr/bin/env", "node", "${paths.notifyPath}", "--source=codex"]\n`
  const fs = memoryFs({
    [paths.codexConfigPath]: codexConfig,
    [paths.notifyPath]: 'old handler'
  })

  const refreshed = refreshInstalledNotifyHandler({ paths, fs, nodePath: '/usr/bin/node' })

  assert.deepEqual(refreshed.sources, ['codex'])
  assert.equal(refreshed.changed, true)
  assert.equal(fs.files.get(paths.codexConfigPath), codexConfig)
  assert.match(fs.files.get(paths.notifyPath), /TOKENBOARD_NOTIFY_DISPATCH_LOCK_TOKEN/)
})

test('does not create a generated handler when no notifier hook is installed', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\n',
    [paths.claudeSettingsPath]: JSON.stringify({ hooks: {} })
  })

  const refreshed = refreshInstalledNotifyHandler({ paths, fs, nodePath: '/usr/bin/node' })

  assert.deepEqual(refreshed.sources, [])
  assert.equal(refreshed.changed, false)
  assert.equal(fs.files.has(paths.notifyPath), false)
  assert.equal(hookStatus({ paths, fs, nodePath: '/usr/bin/node' }).codex, 'not-installed')
  assert.equal(hookStatus({ paths, fs, nodePath: '/usr/bin/node' }).claudeCode, 'not-installed')
})

test('installs and restores Codex notify with an inline TOML comment', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\nnotify = ["old", "--flag"] # existing notify\n'
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', platform: 'linux', flags: { source: 'codex' } })
  uninstallHooks({ paths, fs, platform: 'linux', flags: { source: 'codex' } })

  assert.match(fs.files.get(paths.codexConfigPath), /notify = \["old", "--flag"\]/)
})

test('does not treat Codex commands that only mention notify args as installed hooks', () => {
  const paths = createPaths()
  const originalNotify = ['echo', paths.notifyPath, '--source=codex']
  const originalConfig = `model = "gpt-5"\nnotify = ${JSON.stringify(originalNotify)}\n`
  const fs = memoryFs({
    [paths.codexConfigPath]: originalConfig
  })

  assert.equal(hookStatus({ paths, fs }).codex, 'not-installed')
  const removed = uninstallHooks({ paths, fs, flags: { source: 'codex' } })
  assert.equal(removed.hooks[0].changed, false)
  assert.equal(fs.files.get(paths.codexConfigPath), originalConfig)

  const installed = installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })
  assert.equal(installed.hooks[0].changed, true)

  uninstallHooks({ paths, fs, flags: { source: 'codex' } })

  assert.match(
    fs.files.get(paths.codexConfigPath),
    /notify = \["echo", "\/home\/user\/\.tokenboard\/bin\/notify\.cjs", "--source=codex"\]/
  )
})

test('does not treat Codex commands that pass node notify as arguments as installed hooks', () => {
  const paths = createPaths()
  const originalNotify = ['echo', 'node', paths.notifyPath, '--source=codex']
  const originalConfig = `model = "gpt-5"\nnotify = ${JSON.stringify(originalNotify)}\n`
  const fs = memoryFs({
    [paths.codexConfigPath]: originalConfig
  })

  assert.equal(hookStatus({ paths, fs }).codex, 'not-installed')
  const removed = uninstallHooks({ paths, fs, flags: { source: 'codex' } })
  assert.equal(removed.hooks[0].changed, false)
  assert.equal(fs.files.get(paths.codexConfigPath), originalConfig)
})

test('install fails visibly when Codex notify exists but is not a string array', () => {
  const paths = createPaths()
  const originalConfig = 'model = "gpt-5"\nnotify = "old notify command"\n'
  const fs = memoryFs({
    [paths.codexConfigPath]: originalConfig
  })

  assert.throws(
    () => installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } }),
    /Unsupported Codex notify format/
  )

  assert.equal(fs.files.get(paths.codexConfigPath), originalConfig)
  assert.equal(fs.files.has(paths.notifyPath), false)
  assert.equal(fs.files.has(paths.codexOriginalPath), false)
})

test('reports Codex hook status as error when notify exists but is not a string array', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\nnotify = "old notify command"\n'
  })

  assert.equal(hookStatus({ paths, fs }).codex, 'error')
})

test('install fails visibly when Codex notify array contains non-string values', () => {
  const paths = createPaths()
  const originalConfig = 'model = "gpt-5"\nnotify = [1]\n'
  const fs = memoryFs({
    [paths.codexConfigPath]: originalConfig
  })

  assert.throws(
    () => installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } }),
    /Unsupported Codex notify format/
  )

  assert.equal(fs.files.get(paths.codexConfigPath), originalConfig)
  assert.equal(fs.files.has(paths.notifyPath), false)
  assert.equal(fs.files.has(paths.codexOriginalPath), false)
})

test('installs Codex hook when existing notify is an empty array', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\nnotify = []\n'
  })

  const installed = installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })

  assert.equal(installed.hooks[0].changed, true)
  assert.match(fs.files.get(paths.codexConfigPath), /--source=codex/)
  assert.equal(fs.files.has(paths.codexOriginalPath), false)
})

test('preserves Codex notify array values that contain closing brackets', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\nnotify = ["old", "arg ] kept"]\n'
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })
  uninstallHooks({ paths, fs, flags: { source: 'codex' } })

  assert.match(fs.files.get(paths.codexConfigPath), /notify = \["old", "arg \] kept"\]/)
})

test('uninstall fails visibly when Codex notify exists but is not a string array', () => {
  const paths = createPaths()
  const originalConfig = 'model = "gpt-5"\nnotify = "old notify command"\n'
  const fs = memoryFs({
    [paths.codexConfigPath]: originalConfig
  })

  assert.throws(() => uninstallHooks({ paths, fs, flags: { source: 'codex' } }), /Unsupported Codex notify format/)

  assert.equal(fs.files.get(paths.codexConfigPath), originalConfig)
})

test('recaptures current Codex notify when reinstalling over a stale original backup', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\nnotify = ["new-notify", "--new"]\n',
    [paths.codexOriginalPath]: `${JSON.stringify({ notify: ['old-notify', '--old'] })}\n`
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })
  uninstallHooks({ paths, fs, flags: { source: 'codex' } })

  assert.match(fs.files.get(paths.codexConfigPath), /notify = \["new-notify", "--new"\]/)
})

test('uninstall fails visibly when Codex original backup is invalid', () => {
  const paths = createPaths()
  const originalConfig = `model = "gpt-5"\nnotify = ["/usr/bin/env", "node", "${paths.notifyPath}", "--source=codex"]\n`
  const fs = memoryFs({
    [paths.codexConfigPath]: originalConfig,
    [paths.codexOriginalPath]: '{ invalid json'
  })

  assert.throws(() => uninstallHooks({ paths, fs, flags: { source: 'codex' } }), /Invalid Codex original backup/)

  assert.equal(fs.files.get(paths.codexConfigPath), originalConfig)
})

test('drops stale Codex original backup when installing over no existing notify', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\n',
    [paths.codexOriginalPath]: `${JSON.stringify({ notify: ['old-notify', '--old'] })}\n`
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })
  uninstallHooks({ paths, fs, flags: { source: 'codex' } })

  assert.equal(fs.files.get(paths.codexOriginalPath), undefined)
  assert.doesNotMatch(fs.files.get(paths.codexConfigPath), /notify =/)
})

test('ignores Codex original backup removal race when stale backup disappears', () => {
  const paths = createPaths()
  const baseFs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\n',
    [paths.codexOriginalPath]: `${JSON.stringify({ notify: ['old-notify', '--old'] })}\n`
  })
  const fs = {
    ...baseFs,
    unlink: (path) => {
      if (path === paths.codexOriginalPath) {
        baseFs.files.delete(path)
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
      baseFs.unlink(path)
    }
  }

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })

  assert.equal(fs.files.get(paths.codexOriginalPath), undefined)
})

test('installs and removes only top-level Codex notify without changing table notify keys', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: [
      'model = "gpt-5"',
      '[mcp_servers.local]',
      'command = "node"',
      'notify = ["nested", "--keep"]',
      ''
    ].join('\n')
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', platform: 'linux', flags: { source: 'codex' } })
  const installedConfig = fs.files.get(paths.codexConfigPath)

  assert.match(
    installedConfig,
    /^model = "gpt-5"\nnotify = \["\/usr\/bin\/env", "node", "\/home\/user\/\.tokenboard\/bin\/notify\.cjs", "--source=codex"\]\n\[mcp_servers\.local\]\ncommand = "node"\nnotify = \["nested", "--keep"\]\n$/
  )
  assert.equal(fs.files.get(paths.codexOriginalPath), undefined)

  uninstallHooks({ paths, fs, platform: 'linux', flags: { source: 'codex' } })

  assert.equal(
    fs.files.get(paths.codexConfigPath),
    'model = "gpt-5"\n[mcp_servers.local]\ncommand = "node"\nnotify = ["nested", "--keep"]\n'
  )
})

test('installs Windows-compatible Codex and Claude hook commands', () => {
  const fs = memoryFs({
    'C:\\Users\\user\\.codex\\config.toml': 'model = "gpt-5"\n',
    'C:\\Users\\user\\.claude\\settings.json': JSON.stringify({ hooks: {} })
  })
  const paths = createWindowsPaths()

  installHooks({
    paths,
    fs,
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
    flags: { source: 'all' }
  })

  assert.match(
    fs.files.get(paths.codexConfigPath),
    /notify = \["C:\\\\Program Files\\\\nodejs\\\\node\.exe", "C:\\\\Users\\\\user\\\\.tokenboard\\\\bin\\\\notify\.cjs", "--source=codex"\]/
  )
  const settings = JSON.parse(fs.files.get(paths.claudeSettingsPath))
  assert.equal(
    settings.hooks.SessionEnd[0].hooks[0].command,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\.tokenboard\\bin\\notify.cjs" --source=claude-code'
  )
})

test('recognizes and removes Windows Claude hook after Node path changes', () => {
  const paths = createWindowsPaths()
  const previousCommand =
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\.tokenboard\\bin\\notify.cjs" --source=claude-code'
  const fs = memoryFs({
    [paths.claudeSettingsPath]: JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: previousCommand }] }]
      }
    })
  })

  assert.equal(
    hookStatus({
      paths,
      fs,
      nodePath: 'D:\\Tools\\nodejs\\node.exe',
      platform: 'win32'
    }).claudeCode,
    'installed'
  )

  installHooks({
    paths,
    fs,
    nodePath: 'D:\\Tools\\nodejs\\node.exe',
    platform: 'win32',
    flags: { source: 'claude-code' }
  })
  let settings = JSON.parse(fs.files.get(paths.claudeSettingsPath))
  assert.equal(settings.hooks.SessionEnd.length, 1)

  uninstallHooks({
    paths,
    fs,
    nodePath: 'D:\\Tools\\nodejs\\node.exe',
    platform: 'win32',
    flags: { source: 'claude-code' }
  })
  settings = JSON.parse(fs.files.get(paths.claudeSettingsPath))
  assert.equal(settings.hooks, undefined)
})

test('recognizes Windows Codex hook after Node path changes without replacing original backup', () => {
  const paths = createWindowsPaths()
  const previousNotify = ['C:\\Program Files\\nodejs\\node.exe', paths.notifyPath, '--source=codex']
  const fs = memoryFs({
    [paths.codexConfigPath]: `model = "gpt-5"\nnotify = ${JSON.stringify(previousNotify)}\n`
  })

  assert.equal(hookStatus({ paths, fs }).codex, 'installed')

  const installed = installHooks({
    paths,
    fs,
    nodePath: 'D:\\Tools\\nodejs\\node.exe',
    platform: 'win32',
    flags: { source: 'codex' }
  })

  assert.equal(installed.hooks[0].changed, false)
  assert.equal(fs.files.has(paths.codexOriginalPath), false)
  assert.deepEqual(JSON.parse(JSON.stringify(fs.files.get(paths.codexConfigPath))).includes('D:\\Tools'), false)
})

test('installs and removes Claude SessionEnd hook without dropping other hooks', () => {
  const fs = memoryFs({
    '/home/user/.claude/settings.json': JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'echo old' }] }]
      }
    })
  })
  const paths = createPaths()

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'claude-code' } })
  const settings = JSON.parse(fs.files.get(paths.claudeSettingsPath))
  assert.equal(settings.hooks.SessionEnd.length, 2)
  assert.equal(hookStatus({ paths, fs }).claudeCode, 'installed')

  uninstallHooks({ paths, fs, flags: { source: 'claude-code' } })
  const restored = JSON.parse(fs.files.get(paths.claudeSettingsPath))
  assert.deepEqual(restored.hooks.SessionEnd, [{ hooks: [{ type: 'command', command: 'echo old' }] }])
})

test('recognizes and removes Claude hook when notify path contains a single quote', () => {
  const paths = {
    ...createPaths(),
    notifyPath: "/home/o'connor/.tokenboard/bin/notify.cjs"
  }
  const fs = memoryFs({
    [paths.claudeSettingsPath]: JSON.stringify({ hooks: {} })
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'claude-code' } })

  assert.equal(hookStatus({ paths, fs }).claudeCode, 'installed')
  const removed = uninstallHooks({ paths, fs, flags: { source: 'claude-code' } })
  assert.equal(removed.hooks[0].changed, true)
  assert.equal(JSON.parse(fs.files.get(paths.claudeSettingsPath)).hooks, undefined)
})

test('does not remove Claude commands that only mention the notify command text', () => {
  const paths = createPaths()
  const command = `echo "${paths.notifyPath} --source=claude-code"`
  const fs = memoryFs({
    [paths.claudeSettingsPath]: JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command }] }]
      }
    })
  })

  const removed = uninstallHooks({ paths, fs, flags: { source: 'claude-code' } })

  assert.equal(removed.hooks[0].changed, false)
  assert.equal(JSON.parse(fs.files.get(paths.claudeSettingsPath)).hooks.SessionEnd[0].hooks[0].command, command)
})

test('does not remove Claude commands that pass node notify as arguments', () => {
  const paths = createPaths()
  const command = `echo node "${paths.notifyPath}" --source=claude-code`
  const fs = memoryFs({
    [paths.claudeSettingsPath]: JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command }] }]
      }
    })
  })

  assert.equal(hookStatus({ paths, fs }).claudeCode, 'not-installed')
  const removed = uninstallHooks({ paths, fs, flags: { source: 'claude-code' } })
  assert.equal(removed.hooks[0].changed, false)
  assert.equal(JSON.parse(fs.files.get(paths.claudeSettingsPath)).hooks.SessionEnd[0].hooks[0].command, command)
})

test('keeps notify handler when uninstalling one source leaves the other installed', () => {
  const fs = memoryFs({
    '/home/user/.codex/config.toml': 'model = "gpt-5"\n',
    '/home/user/.claude/settings.json': JSON.stringify({ hooks: {} })
  })
  const paths = createPaths()

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'all' } })
  const removed = uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })

  assert.equal(removed.notifyRemoved, false)
  assert.equal(fs.files.has(paths.notifyPath), true)
  assert.equal(hookStatus({ paths, fs, nodePath: '/usr/bin/node' }).codex, 'not-installed')
  assert.equal(hookStatus({ paths, fs, nodePath: '/usr/bin/node' }).claudeCode, 'installed')
})

test('install all keeps Antigravity statusLine opt-in', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\n',
    [paths.claudeSettingsPath]: JSON.stringify({ hooks: {} }),
    [paths.antigravitySettingsPath]: JSON.stringify({ other: true })
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'all' } })

  assert.equal(fs.files.has(paths.antigravityOriginalStatuslinePath), false)
  assert.deepEqual(JSON.parse(fs.files.get(paths.antigravitySettingsPath)), { other: true })
  assert.equal(hookStatus({ paths, fs }).antigravityCli, 'not-installed')
})

test('uninstall all does not let invalid Antigravity settings block Codex and Claude cleanup', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\n',
    [paths.claudeSettingsPath]: JSON.stringify({ hooks: {} }),
    [paths.antigravitySettingsPath]: '{ invalid json'
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'all' } })
  const removed = uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'all' } })

  assert.equal(removed.notifyRemoved, true)
  assert.equal(fs.files.has(paths.notifyPath), false)
  assert.equal(hookStatus({ paths, fs, nodePath: '/usr/bin/node' }).codex, 'not-installed')
  assert.equal(hookStatus({ paths, fs, nodePath: '/usr/bin/node' }).claudeCode, 'not-installed')
  assert.deepEqual(
    removed.hooks.find((hook) => hook.source === 'antigravity-cli'),
    {
      source: 'antigravity-cli',
      action: 'skip',
      changed: false,
      incomplete: true,
      detail: 'Antigravity statusline not checked: Invalid Antigravity settings.json'
    }
  )
})

test('explicit Antigravity uninstall still fails visibly when settings are invalid', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: '{ invalid json'
  })

  assert.throws(
    () => uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'antigravity-cli' } }),
    /Invalid Antigravity settings\.json/
  )
})

test('explicit Antigravity uninstall validates before mutating other requested sources', () => {
  const paths = createPaths()
  const codexConfig = `model = "gpt-5"\nnotify = ["/usr/bin/env", "node", "${paths.notifyPath}", "--source=codex"]\n`
  const fs = memoryFs({
    [paths.notifyPath]: 'TOKENBOARD_NOTIFY_HANDLER',
    [paths.codexConfigPath]: codexConfig,
    [paths.antigravitySettingsPath]: '{ invalid json'
  })

  assert.throws(
    () => uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex,antigravity-cli' } }),
    /Invalid Antigravity settings\.json/
  )
  assert.equal(fs.files.get(paths.codexConfigPath), codexConfig)
  assert.equal(fs.files.has(paths.notifyPath), true)
})

test('multi-source uninstall validates Claude before mutating Codex', () => {
  const paths = createPaths()
  const codexConfig = `model = "gpt-5"\nnotify = ["/usr/bin/env", "node", "${paths.notifyPath}", "--source=codex"]\n`
  const fs = memoryFs({
    [paths.notifyPath]: 'TOKENBOARD_NOTIFY_HANDLER',
    [paths.codexConfigPath]: codexConfig,
    [paths.claudeSettingsPath]: '{ invalid json'
  })

  assert.throws(
    () => uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex,claude-code' } }),
    /Invalid Claude settings\.json/
  )
  assert.equal(fs.files.get(paths.codexConfigPath), codexConfig)
  assert.equal(fs.files.has(paths.notifyPath), true)
})

test('uninstall all validates Claude before mutating Codex', () => {
  const paths = createPaths()
  const codexConfig = `model = "gpt-5"\nnotify = ["/usr/bin/env", "node", "${paths.notifyPath}", "--source=codex"]\n`
  const fs = memoryFs({
    [paths.notifyPath]: 'TOKENBOARD_NOTIFY_HANDLER',
    [paths.codexConfigPath]: codexConfig,
    [paths.claudeSettingsPath]: '{ invalid json'
  })

  assert.throws(
    () => uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'all' } }),
    /Invalid Claude settings\.json/
  )
  assert.equal(fs.files.get(paths.codexConfigPath), codexConfig)
  assert.equal(fs.files.has(paths.notifyPath), true)
})

test('uninstall all fails visibly when installed Antigravity restore backup is invalid', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: JSON.stringify({
      statusLine: {
        enabled: true,
        command: `/usr/bin/env node ${paths.statuslineScriptPath} --state-dir ${paths.stateDir}`
      }
    }),
    [paths.antigravityOriginalStatuslinePath]: '{ invalid json'
  })

  assert.throws(
    () => uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'all' } }),
    /Invalid Antigravity original statusline backup/
  )
  assert.match(
    JSON.parse(fs.files.get(paths.antigravitySettingsPath)).statusLine.command,
    /antigravity-statusline\.mjs/
  )
})

test('uninstall all finalizes notify cleanup before Antigravity restore errors', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.notifyPath]: 'TOKENBOARD_NOTIFY_HANDLER',
    [paths.codexConfigPath]: `model = "gpt-5"\nnotify = ["/usr/bin/env", "node", "${paths.notifyPath}", "--source=codex"]\n`,
    [paths.claudeSettingsPath]: JSON.stringify({
      hooks: {
        SessionEnd: [
          {
            hooks: [
              {
                type: 'command',
                command: `/usr/bin/env node ${paths.notifyPath} --source=claude-code`
              }
            ]
          }
        ]
      }
    }),
    [paths.antigravitySettingsPath]: JSON.stringify({
      statusLine: {
        enabled: true,
        command: `/usr/bin/env node ${paths.statuslineScriptPath} --state-dir ${paths.stateDir}`
      }
    }),
    [paths.antigravityOriginalStatuslinePath]: '{ invalid json'
  })

  assert.throws(
    () => uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'all' } }),
    /Invalid Antigravity original statusline backup/
  )
  assert.equal(fs.files.has(paths.notifyPath), false)
  assert.equal(hookStatus({ paths, fs, nodePath: '/usr/bin/node' }).codex, 'not-installed')
  assert.equal(hookStatus({ paths, fs, nodePath: '/usr/bin/node' }).claudeCode, 'not-installed')
})

test('uninstall all preserves Antigravity restore error when notify cleanup fails', () => {
  const paths = createPaths()
  const baseFs = memoryFs({
    [paths.notifyPath]: 'TOKENBOARD_NOTIFY_HANDLER',
    [paths.codexConfigPath]: `model = "gpt-5"\nnotify = ["/usr/bin/env", "node", "${paths.notifyPath}", "--source=codex"]\n`,
    [paths.claudeSettingsPath]: JSON.stringify({
      hooks: {
        SessionEnd: [
          {
            hooks: [
              {
                type: 'command',
                command: `/usr/bin/env node ${paths.notifyPath} --source=claude-code`
              }
            ]
          }
        ]
      }
    }),
    [paths.antigravitySettingsPath]: JSON.stringify({
      statusLine: {
        enabled: true,
        command: `/usr/bin/env node ${paths.statuslineScriptPath} --state-dir ${paths.stateDir}`
      }
    }),
    [paths.antigravityOriginalStatuslinePath]: '{ invalid json'
  })
  const fs = {
    ...baseFs,
    unlink: (path) => {
      if (path === paths.notifyPath) {
        throw new Error('notify cleanup denied')
      }
      baseFs.unlink(path)
    }
  }

  assert.throws(
    () => uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'all' } }),
    (error) => {
      assert.match(error.message, /Invalid Antigravity original statusline backup/)
      assert.match(error.cleanupError.message, /notify cleanup denied/)
      return true
    }
  )
})

test('keeps notify handler when another source status is unreadable during uninstall', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.notifyPath]: 'TOKENBOARD_NOTIFY_HANDLER',
    [paths.codexConfigPath]: `model = "gpt-5"\nnotify = ["/usr/bin/env", "node", "${paths.notifyPath}", "--source=codex"]\n`,
    [paths.claudeSettingsPath]: '{ invalid json'
  })

  const removed = uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })

  assert.equal(removed.notifyRemoved, false)
  assert.equal(fs.files.has(paths.notifyPath), true)
  assert.equal(hookStatus({ paths, fs, nodePath: '/usr/bin/node' }).claudeCode, 'error')
})

test('fails visibly and removes notify handler when Claude settings are invalid', () => {
  const fs = memoryFs({
    '/home/user/.claude/settings.json': '{ invalid json'
  })
  const paths = createPaths()

  assert.throws(
    () => installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'all' } }),
    /Invalid Claude settings\.json/
  )

  assert.equal(fs.files.has(paths.notifyPath), false)
  assert.equal(hookStatus({ paths, fs, nodePath: '/usr/bin/node' }).notifyHandler, 'not-installed')
})

test('uninstall fails visibly when Claude settings are invalid', () => {
  const fs = memoryFs({
    '/home/user/.claude/settings.json': '{ invalid json'
  })
  const paths = createPaths()

  assert.throws(
    () => uninstallHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'claude-code' } }),
    /Invalid Claude settings\.json/
  )
})

function createPaths() {
  return {
    stateDir: '/home/user/.tokenboard',
    binDir: '/home/user/.tokenboard/bin',
    notifyPath: '/home/user/.tokenboard/bin/notify.cjs',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    statuslineScriptPath: '/repo/scripts/antigravity-statusline.mjs',
    codexConfigPath: '/home/user/.codex/config.toml',
    codexOriginalPath: '/home/user/.tokenboard/codex_notify_original.json',
    claudeSettingsPath: '/home/user/.claude/settings.json',
    antigravitySettingsPath: '/home/user/.gemini/antigravity-cli/settings.json',
    antigravityOriginalStatuslinePath: '/home/user/.tokenboard/antigravity_statusline_original.json',
    antigravityIdePath: '/home/user/.gemini/antigravity-ide',
    antigravityPath: '/home/user/.gemini/antigravity'
  }
}

function createWindowsPaths() {
  return {
    stateDir: 'C:\\Users\\user\\.tokenboard',
    binDir: 'C:\\Users\\user\\.tokenboard\\bin',
    notifyPath: 'C:\\Users\\user\\.tokenboard\\bin\\notify.cjs',
    notifyScriptPath: 'C:\\repo\\scripts\\notify.mjs',
    statuslineScriptPath: 'C:\\repo\\scripts\\antigravity-statusline.mjs',
    codexConfigPath: 'C:\\Users\\user\\.codex\\config.toml',
    codexOriginalPath: 'C:\\Users\\user\\.tokenboard\\codex_notify_original.json',
    claudeSettingsPath: 'C:\\Users\\user\\.claude\\settings.json',
    antigravitySettingsPath: 'C:\\Users\\user\\.gemini\\antigravity-cli\\settings.json',
    antigravityOriginalStatuslinePath: 'C:\\Users\\user\\.tokenboard\\antigravity_statusline_original.json',
    antigravityIdePath: 'C:\\Users\\user\\.gemini\\antigravity-ide',
    antigravityPath: 'C:\\Users\\user\\.gemini\\antigravity'
  }
}

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    exists: (path) => files.has(path),
    mkdir: () => {},
    readFile: (path) => {
      if (!files.has(path)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
      return files.get(path)
    },
    writeFile: (path, value) => {
      files.set(path, String(value))
    },
    unlink: (path) => {
      if (!files.delete(path)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
    }
  }
}
