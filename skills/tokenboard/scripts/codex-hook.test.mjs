import assert from 'node:assert/strict'
import test from 'node:test'
import { getCodexHookStatus, installCodexHook, isCodexNotifyCommand, uninstallCodexHook } from './codex-hook.mjs'

// The Codex half of the same defect ca13a21 fixed for Claude: `path.join` yields backslashes
// on Windows while a config written elsewhere (the macOS side of a shared setup, a hand-edit,
// an older install) spells the same file with forward slashes. Comparing them as plain
// strings made `installCodexHook` append a second `notify` array entry — every hook event then
// dispatched the sync twice — and made `uninstallCodexHook` unable to find the stale one.
const notifyPathBackslash = 'C:\\Users\\me\\.tokenboard\\bin\\notify.cjs'
const notifyPathForward = 'C:/Users/me/.tokenboard/bin/notify.cjs'

const codexConfigPath = 'C:\\Users\\me\\.codex\\config.toml'

function tomlNotify(executable, notifyPath) {
  const quote = (value) => JSON.stringify(value).replaceAll('"', '\\"')
  return `notify = ["${executable.replaceAll('\\', '\\\\')}", "${notifyPath.replaceAll('"', '\\"')}", "--source=codex"]`
}

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
    exists: (path) => files.has(path),
    existsSync: (path) => files.has(path),
    readFile: read,
    readFileSync: read,
    writeFile: (path, value) => files.set(path, String(value)),
    writeFileSync: (path, value) => files.set(path, String(value)),
    mkdir: () => {},
    mkdirSync: () => {},
    copyFile: (from, to) => files.set(to, files.get(from)),
    copyFileSync: (from, to) => files.set(to, files.get(from)),
    rename: (from, to) => {
      files.set(to, files.get(from))
      files.delete(from)
    },
    renameSync: (from, to) => {
      files.set(to, files.get(from))
      files.delete(from)
    },
    unlink: (path) => files.delete(path),
    unlinkSync: (path) => files.delete(path),
    rm: (path) => files.delete(path),
    rmSync: (path) => files.delete(path),
    chmod: () => {},
    chmodSync: () => {}
  }
}

const nodeExe = 'C:\\Program Files\\nodejs\\node.exe'

test('a codex notify path written with forward slashes is recognised', () => {
  const value = [nodeExe, notifyPathForward, '--source=codex']
  assert.equal(isCodexNotifyCommand(value, notifyPathBackslash), true)
})

test('a codex notify path written with backslashes is recognised', () => {
  const value = [nodeExe, notifyPathBackslash, '--source=codex']
  assert.equal(isCodexNotifyCommand(value, notifyPathForward), true)
})

test('the codex path comparison ignores case, as Windows paths do', () => {
  const value = [nodeExe, 'c:/users/ME/.tokenboard/bin/Notify.cjs', '--source=codex']
  assert.equal(isCodexNotifyCommand(value, notifyPathBackslash), true)
})

test('a different codex notify path is not the hook', () => {
  const value = [nodeExe, 'C:/Users/me/other/bin/notify.cjs', '--source=codex']
  assert.equal(isCodexNotifyCommand(value, notifyPathBackslash), false)
})

test('installing over a forward-slash codex notify does not append a duplicate', () => {
  const files = new Map([[codexConfigPath, `${tomlNotify(nodeExe, notifyPathForward)}\n`]])
  const result = installCodexHook({
    paths: {
      codexConfigPath,
      codexOriginalPath: 'C:\\Users\\me\\.tokenboard\\codex_notify_original.json',
      notifyPath: notifyPathBackslash
    },
    fs: memoryFs(files),
    nodePath: nodeExe,
    platform: 'win32'
  })

  assert.equal(result.changed, false)
  const written = files.get(codexConfigPath)
  assert.equal(written.match(/^notify\s*=/gm).length, 1)
})

test('the codex hook status is installed for a forward-slash notify path', () => {
  const files = new Map([[codexConfigPath, `${tomlNotify(nodeExe, notifyPathForward)}\n`]])
  const status = getCodexHookStatus({
    paths: { codexConfigPath, notifyPath: notifyPathBackslash },
    fs: memoryFs(files)
  })
  assert.equal(status, 'installed')
})

test('uninstalling finds a forward-slash codex notify and removes it', () => {
  const files = new Map([[codexConfigPath, `${tomlNotify(nodeExe, notifyPathForward)}\n`]])
  const result = uninstallCodexHook({
    paths: {
      codexConfigPath,
      codexOriginalPath: 'C:\\Users\\me\\.tokenboard\\codex_notify_original.json',
      notifyPath: notifyPathBackslash
    },
    fs: memoryFs(files)
  })

  assert.equal(result.changed, true)
  assert.doesNotMatch(files.get(codexConfigPath) ?? '', /notify\s*=\s*\[/)
})
