import assert from 'node:assert/strict'
import test from 'node:test'
import { hookStatus, installHooks, uninstallHooks } from './hooks.mjs'
import { readSources, readUninstallSources } from './hooks-utils.mjs'

test('all installs Codex and Claude Code hooks while Antigravity CLI stays explicit opt-in', () => {
  assert.deepEqual(readSources('all'), ['codex', 'claude-code'])
  assert.deepEqual(readSources('all,antigravity-cli'), ['codex', 'claude-code', 'antigravity-cli'])
  assert.deepEqual(readUninstallSources('all'), ['codex', 'claude-code', 'antigravity-cli'])
})

test('installs and restores Antigravity statusLine command without notify handler', () => {
  const paths = createPaths()
  const originalSettings = {
    statusLine: {
      enabled: false,
      command: 'node /custom/statusline.mjs',
      color: 'blue'
    },
    other: true
  }
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: JSON.stringify(originalSettings)
  })

  const installed = installHooks({
    paths,
    fs,
    nodePath: '/usr/bin/node',
    flags: { source: 'antigravity-cli' }
  })

  assert.equal(installed.hooks[0].changed, true)
  assert.equal(fs.files.has(paths.notifyPath), false)
  const settings = JSON.parse(fs.files.get(paths.antigravitySettingsPath))
  assert.equal(settings.statusLine.enabled, true)
  assert.match(settings.statusLine.command, /antigravity-statusline\.mjs/)
  assert.match(settings.statusLine.command, /--state-dir/)
  assert.deepEqual(
    JSON.parse(fs.files.get(paths.antigravityOriginalStatuslinePath)).statusLine,
    originalSettings.statusLine
  )
  assert.equal(fs.modes.get(paths.antigravityOriginalStatuslinePath), 0o600)
  assert.equal(hookStatus({ paths, fs }).antigravityCli, 'installed')

  const removed = uninstallHooks({ paths, fs, flags: { source: 'antigravity-cli' } })

  assert.equal(removed.hooks[0].changed, true)
  assert.equal(removed.notifyRemoved, false)
  assert.deepEqual(JSON.parse(fs.files.get(paths.antigravitySettingsPath)), originalSettings)
  assert.equal(fs.files.has(paths.antigravityOriginalStatuslinePath), false)
})

test('re-enables a disabled TokenBoard Antigravity statusLine without replacing original backup', () => {
  const paths = createPaths()
  const installedCommand = `/usr/bin/env node ${paths.statuslineScriptPath} --state-dir ${paths.stateDir}`
  const originalBackup = {
    statusLine: {
      enabled: true,
      command: 'node /custom/statusline.mjs'
    }
  }
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: JSON.stringify({
      statusLine: {
        enabled: false,
        command: installedCommand,
        color: 'blue'
      }
    }),
    [paths.antigravityOriginalStatuslinePath]: `${JSON.stringify(originalBackup)}\n`
  })

  assert.equal(hookStatus({ paths, fs }).antigravityCli, 'not-installed')

  const installed = installHooks({
    paths,
    fs,
    nodePath: '/usr/bin/node',
    flags: { source: 'antigravity-cli' }
  })

  const settings = JSON.parse(fs.files.get(paths.antigravitySettingsPath))
  assert.equal(installed.hooks[0].changed, true)
  assert.equal(installed.hooks[0].detail, 'Antigravity statusline enabled')
  assert.equal(settings.statusLine.enabled, true)
  assert.equal(settings.statusLine.command, installedCommand)
  assert.equal(settings.statusLine.color, 'blue')
  assert.deepEqual(JSON.parse(fs.files.get(paths.antigravityOriginalStatuslinePath)), originalBackup)
  assert.equal(hookStatus({ paths, fs }).antigravityCli, 'installed')
})

test('all uninstall restores an opted-in Antigravity statusLine', () => {
  const paths = createPaths()
  const originalSettings = {
    statusLine: {
      enabled: false,
      command: 'node /custom/statusline.mjs'
    }
  }
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: JSON.stringify(originalSettings)
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'antigravity-cli' } })
  assert.equal(hookStatus({ paths, fs }).antigravityCli, 'installed')

  const removed = uninstallHooks({ paths, fs, flags: { source: 'all' } })

  assert.equal(
    removed.hooks.some((hook) => hook.source === 'antigravity-cli' && hook.changed),
    true
  )
  assert.deepEqual(JSON.parse(fs.files.get(paths.antigravitySettingsPath)), originalSettings)
  assert.equal(fs.files.has(paths.antigravityOriginalStatuslinePath), false)
})

test('removes TokenBoard Antigravity statusLine when no original command existed', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: JSON.stringify({ other: true }),
    [paths.antigravityOriginalStatuslinePath]: JSON.stringify({ statusLine: { command: 'stale' } })
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'antigravity-cli' } })
  assert.equal(fs.files.has(paths.antigravityOriginalStatuslinePath), false)

  uninstallHooks({ paths, fs, flags: { source: 'antigravity-cli' } })

  assert.deepEqual(JSON.parse(fs.files.get(paths.antigravitySettingsPath)), { other: true })
})

test('detects Windows Antigravity statusLine commands with backslash paths', () => {
  const paths = {
    ...createPaths(),
    stateDir: 'C:\\Users\\QDM\\.tokenboard',
    statuslineScriptPath:
      'C:\\Users\\QDM\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\antigravity-statusline.mjs',
    antigravitySettingsPath: 'C:\\Users\\QDM\\.gemini\\antigravity-cli\\settings.json',
    antigravityOriginalStatuslinePath: 'C:\\Users\\QDM\\.tokenboard\\antigravity_statusline_original.json'
  }
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: JSON.stringify({
      statusLine: {
        enabled: true,
        command: String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\QDM\.tokenboard\TokenBoard\skills\tokenboard\scripts\antigravity-statusline.mjs" "--state-dir" "C:\Users\QDM\.tokenboard"`
      }
    })
  })

  assert.equal(hookStatus({ paths, fs }).antigravityCli, 'installed')
})

test('fails visibly when Antigravity statusLine has an unsupported format', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: JSON.stringify({ statusLine: 'bad' })
  })

  assert.throws(
    () => installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'antigravity-cli' } }),
    /Unsupported Antigravity statusLine format/
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
    antigravityOriginalStatuslinePath: '/home/user/.tokenboard/antigravity_statusline_original.json'
  }
}

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const modes = new Map()
  return {
    files,
    modes,
    mkdir: () => {},
    readFile: (path) => {
      if (!files.has(path)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
      return files.get(path)
    },
    writeFile: (path, value, options = {}) => {
      files.set(path, String(value))
      if (typeof options.mode === 'number') modes.set(path, options.mode)
    },
    chmod: (path, mode) => {
      modes.set(path, mode)
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
