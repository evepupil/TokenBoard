import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNotifyHandler, hookPaths, hookStatus, installHooks, uninstallHooks } from './hooks.mjs'

test('notify handler only enqueues signal and spawns background notify script', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /appendFileSync\(join\(STATE_DIR, "notify\.signal"\)/)
  assert.match(source, /const SIGNAL_DIR = join\(STATE_DIR, "notify\.signal\.d"\)/)
  assert.match(source, /writeQueuedSignal\(signalPayload\)/)
  assert.match(source, /spawn\(NODE_PATH, \[NOTIFY_SCRIPT/)
  assert.match(source, /detached: true/)
  assert.doesNotMatch(source, /ccusage/)
})

test('notify handler preserves legacy signal append when queued signal rename fails', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /let queueError;/)
  assert.match(source, /appendFileSync\(join\(STATE_DIR, "notify\.signal"\), signalPayload, "utf8"\);/)
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

test('notify handler uses the runtime node executable for the background process', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/old/node'
  })

  assert.match(source, /const NODE_PATH = process\.execPath;/)
  assert.doesNotMatch(source, /const NODE_PATH = "\/old\/node"/)
})

test('notify handler forwards Codex payload args to the preserved original notify command', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /const payloadArgs = \[\];/)
  assert.match(source, /spawn\(cmd\[0\], \[\.\.\.cmd\.slice\(1\), \.\.\.payloadArgs\]/)
})

test('notify handler treats shell-string references to itself as self notify commands', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /part\.includes\(SELF_PATH\)/)
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

  assert.equal(paths.claudeSettingsPath, '/custom/claude-config/settings.json')
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

  const installed = installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })

  assert.equal(installed.hooks[0].changed, true)
  assert.match(fs.files.get(paths.codexConfigPath), /notify = \["\/usr\/bin\/env", "node", "\/home\/user\/\.tokenboard\/bin\/notify\.cjs", "--source=codex"\]/)
  assert.match(fs.files.get(paths.codexOriginalPath), /"old"/)
  assert.equal(hookStatus({ paths, fs }).codex, 'installed')

  const removed = uninstallHooks({ paths, fs, flags: { source: 'codex' } })

  assert.equal(removed.hooks[0].changed, true)
  assert.match(fs.files.get(paths.codexConfigPath), /notify = \["old", "--flag"\]/)
})

test('installs and restores Codex notify with an inline TOML comment', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.codexConfigPath]: 'model = "gpt-5"\nnotify = ["old", "--flag"] # existing notify\n'
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })
  uninstallHooks({ paths, fs, flags: { source: 'codex' } })

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

  assert.match(fs.files.get(paths.codexConfigPath), /notify = \["echo", "\/home\/user\/\.tokenboard\/bin\/notify\.cjs", "--source=codex"\]/)
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

  assert.throws(
    () => uninstallHooks({ paths, fs, flags: { source: 'codex' } }),
    /Unsupported Codex notify format/
  )

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

  assert.throws(
    () => uninstallHooks({ paths, fs, flags: { source: 'codex' } }),
    /Invalid Codex original backup/
  )

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

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'codex' } })
  const installedConfig = fs.files.get(paths.codexConfigPath)

  assert.match(
    installedConfig,
    /^model = "gpt-5"\nnotify = \["\/usr\/bin\/env", "node", "\/home\/user\/\.tokenboard\/bin\/notify\.cjs", "--source=codex"\]\n\[mcp_servers\.local\]\ncommand = "node"\nnotify = \["nested", "--keep"\]\n$/
  )
  assert.equal(fs.files.get(paths.codexOriginalPath), undefined)

  uninstallHooks({ paths, fs, flags: { source: 'codex' } })

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
  const previousCommand = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\.tokenboard\\bin\\notify.cjs" --source=claude-code'
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
  const previousNotify = [
    'C:\\Program Files\\nodejs\\node.exe',
    paths.notifyPath,
    '--source=codex'
  ]
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
    codexConfigPath: '/home/user/.codex/config.toml',
    codexOriginalPath: '/home/user/.tokenboard/codex_notify_original.json',
    claudeSettingsPath: '/home/user/.claude/settings.json'
  }
}

function createWindowsPaths() {
  return {
    stateDir: 'C:\\Users\\user\\.tokenboard',
    binDir: 'C:\\Users\\user\\.tokenboard\\bin',
    notifyPath: 'C:\\Users\\user\\.tokenboard\\bin\\notify.cjs',
    notifyScriptPath: 'C:\\repo\\scripts\\notify.mjs',
    codexConfigPath: 'C:\\Users\\user\\.codex\\config.toml',
    codexOriginalPath: 'C:\\Users\\user\\.tokenboard\\codex_notify_original.json',
    claudeSettingsPath: 'C:\\Users\\user\\.claude\\settings.json'
  }
}

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
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
