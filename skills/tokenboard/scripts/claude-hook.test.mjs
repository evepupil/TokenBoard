import assert from 'node:assert/strict'
import test from 'node:test'
import { installClaudeHook, isClaudeNotifyHook, uninstallClaudeHook } from './claude-hook.mjs'

// Windows reports the same file as `C:\Users\me\.tokenboard\bin\notify.cjs` from Node's
// `path.join`, while a hook written by an older install — or by hand, or by the macOS side
// of a shared settings file — spells it `C:/Users/me/.tokenboard/bin/notify.cjs`. Comparing
// the two as plain strings said "different file", so install appended a second copy of the
// hook (firing the sync twice per session) and uninstall could not remove the stale one at
// all. The command's node/env parts already compare case- and separator-insensitively; only
// the notify path argument did not.
const notifyPathBackslash = 'C:\\Users\\me\\.tokenboard\\bin\\notify.cjs'
const notifyPathForward = 'C:/Users/me/.tokenboard/bin/notify.cjs'

test('a hook that spells the notify path with forward slashes is recognised', () => {
  const hook = {
    type: 'command',
    command: `"/c/Program Files/nodejs/node.exe" "${notifyPathForward}" --source=claude-code`
  }
  assert.equal(isClaudeNotifyHook(hook, notifyPathBackslash), true)
})

test('a hook that spells the notify path with backslashes is recognised', () => {
  const hook = {
    type: 'command',
    command: `"/c/Program Files/nodejs/node.exe" "${notifyPathBackslash}" --source=claude-code`
  }
  assert.equal(isClaudeNotifyHook(hook, notifyPathForward), true)
})

test('the path comparison is case-insensitive, as Windows paths are', () => {
  const hook = { type: 'command', command: `node "c:/users/ME/.tokenboard/bin/Notify.cjs" --source=claude-code` }
  assert.equal(isClaudeNotifyHook(hook, notifyPathBackslash), true)
})

test('a different notify path is still not the hook', () => {
  const hook = { type: 'command', command: `node "C:/Users/me/other/bin/notify.cjs" --source=claude-code` }
  assert.equal(isClaudeNotifyHook(hook, notifyPathBackslash), false)
})

test('a differently cased directory that is not the same path is not the hook', () => {
  const hook = { type: 'command', command: `node "C:/Users/me/.tokenboard/other/notify.cjs" --source=claude-code` }
  assert.equal(isClaudeNotifyHook(hook, notifyPathBackslash), false)
})

test('installing over a forward-slash hook does not append a duplicate', () => {
  const files = new Map([
    [
      'C:\\Users\\me\\.claude\\settings.json',
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ type: 'command', command: `node "${notifyPathForward}" --source=claude-code` }] }]
        }
      })
    ]
  ])
  const result = installClaudeHook({
    paths: { claudeSettingsPath: 'C:\\Users\\me\\.claude\\settings.json', notifyPath: notifyPathBackslash },
    fs: memoryFs(files),
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe'
  })

  assert.equal(result.changed, false)
  const written = JSON.parse(files.get('C:\\Users\\me\\.claude\\settings.json'))
  assert.equal(written.hooks.SessionEnd.length, 1)
})

test('uninstalling removes a forward-slash hook', () => {
  const files = new Map([
    [
      'C:\\Users\\me\\.claude\\settings.json',
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ type: 'command', command: `node "${notifyPathForward}" --source=claude-code` }] }]
        }
      })
    ]
  ])
  const result = uninstallClaudeHook({
    paths: { claudeSettingsPath: 'C:\\Users\\me\\.claude\\settings.json', notifyPath: notifyPathBackslash },
    fs: memoryFs(files),
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe'
  })

  assert.equal(result.changed, true)
  const written = JSON.parse(files.get('C:\\Users\\me\\.claude\\settings.json'))
  assert.equal(written.hooks, undefined)
})

function memoryFs(files) {
  const read = (path) => {
    const value = files.get(path)
    if (value === undefined) {
      const error = new Error(`ENOENT: ${path}`)
      error.code = 'ENOENT'
      throw error
    }
    return value
  }
  return {
    existsSync: (path) => files.has(path),
    readFileSync: read,
    readFile: read,
    writeFileSync: (path, value) => files.set(path, String(value)),
    writeFile: (path, value) => files.set(path, String(value)),
    chmod: () => {},
    chmodSync: () => {},
    copyFileSync: (from, to) => files.set(to, files.get(from)),
    mkdirSync: () => {},
    mkdir: () => {},
    renameSync: (from, to) => {
      files.set(to, files.get(from))
      files.delete(from)
    },
    rmSync: (path) => files.delete(path)
  }
}
