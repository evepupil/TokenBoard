import { dirname } from 'node:path'
import {
  codexSource,
  inspectTomlStringArray,
  readOptional,
  removeTomlKey,
  setTomlStringArray,
  timestamp
} from './hooks-utils.mjs'

export function installCodexHook({ paths, fs, nodePath, platform = process.platform }) {
  const text = readOptional(paths.codexConfigPath, fs)
  if (text === null) {
    return { source: codexSource, action: 'skip', changed: false, detail: 'Codex config.toml not found' }
  }

  const notify = buildCodexNotifyCommand({
    notifyPath: paths.notifyPath,
    nodePath,
    platform
  })
  const current = readCodexNotifyForWrite(text)
  if (isCodexNotifyCommand(current, paths.notifyPath)) {
    return { source: codexSource, action: 'install', changed: false, detail: 'Codex hook already installed' }
  }

  captureOriginalCodexNotify({ current, paths, fs })

  fs.mkdir(dirname(paths.codexConfigPath), { recursive: true })
  const backupPath = `${paths.codexConfigPath}.bak.${timestamp()}`
  fs.writeFile(backupPath, text)
  fs.writeFile(paths.codexConfigPath, setTomlStringArray(text, 'notify', notify))
  return { source: codexSource, action: 'install', changed: true, detail: 'Codex hook installed', backupPath }
}

export function uninstallCodexHook({ paths, fs }) {
  const text = readOptional(paths.codexConfigPath, fs)
  if (text === null) {
    return { source: codexSource, action: 'skip', changed: false, detail: 'Codex config.toml not found' }
  }

  const current = readCodexNotifyForWrite(text)
  if (!isCodexNotifyCommand(current, paths.notifyPath)) {
    return { source: codexSource, action: 'skip', changed: false, detail: 'Codex hook not installed' }
  }

  const original = readOriginalCodexNotify(paths, fs)
  const next = original ? setTomlStringArray(text, 'notify', original) : removeTomlKey(text, 'notify')
  const backupPath = `${paths.codexConfigPath}.bak.${timestamp()}`
  fs.writeFile(backupPath, text)
  fs.writeFile(paths.codexConfigPath, next)
  return { source: codexSource, action: 'uninstall', changed: true, detail: original ? 'Codex hook restored' : 'Codex hook removed', backupPath }
}

export function getCodexHookStatus({ paths, fs }) {
  const text = readOptional(paths.codexConfigPath, fs)
  if (text === null) return 'not-installed'
  const inspected = inspectTomlStringArray(text, 'notify')
  if (inspected.status === 'invalid') return 'error'
  const current = inspected.value
  return isCodexNotifyCommand(current, paths.notifyPath) ? 'installed' : 'not-installed'
}

export function assertCodexNotifyWritable({ paths, fs }) {
  const text = readOptional(paths.codexConfigPath, fs)
  if (text === null) return
  readCodexNotifyForWrite(text)
}

function readCodexNotifyForWrite(text) {
  const result = inspectTomlStringArray(text, 'notify')
  if (result.status === 'invalid') {
    throw new Error('Unsupported Codex notify format: expected top-level notify to be a TOML string array')
  }
  return result.value
}

function isCodexNotifyCommand(value, notifyPath) {
  if (!Array.isArray(value)) return false
  const notifyIndex = value.findIndex((part) => part === notifyPath)
  return isNodeExecutingNotify(value, notifyIndex) &&
    hasSourceArg(value, notifyIndex + 1, codexSource)
}

function hasSourceArg(args, startIndex, source) {
  for (let index = startIndex; index < args.length; index += 1) {
    if (args[index] === `--source=${source}`) return true
    if (args[index] === '--source' && args[index + 1] === source) return true
  }
  return false
}

function isNodeCommand(value) {
  const command = String(value).split(/[\\/]/).pop().toLowerCase()
  return command === 'node' || command === 'node.exe'
}

function isEnvCommand(value) {
  const command = String(value).split(/[\\/]/).pop().toLowerCase()
  return command === 'env' || command === 'env.exe'
}

function isNodeExecutingNotify(args, notifyIndex) {
  if (notifyIndex === 1) {
    return isNodeCommand(args[0])
  }
  if (notifyIndex === 2) {
    return isEnvCommand(args[0]) && isNodeCommand(args[1])
  }
  return false
}

function buildCodexNotifyCommand({ notifyPath, nodePath, platform }) {
  if (platform === 'win32') {
    return [nodePath, notifyPath, '--source=codex']
  }
  return ['/usr/bin/env', 'node', notifyPath, '--source=codex']
}

function readOriginalCodexNotify(paths, fs) {
  const raw = readOptional(paths.codexOriginalPath, fs)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('invalid backup payload')
    }
    if (!Array.isArray(parsed.notify) || !parsed.notify.every((item) => typeof item === 'string')) {
      throw new Error('invalid notify array')
    }
    return parsed.notify
  } catch (error) {
    throw new Error('Invalid Codex original backup: expected JSON with a notify string array', { cause: error })
  }
}

function captureOriginalCodexNotify({ current, paths, fs }) {
  if (current && current.length > 0) {
    fs.mkdir(dirname(paths.codexOriginalPath), { recursive: true })
    fs.writeFile(paths.codexOriginalPath, `${JSON.stringify({ notify: current, capturedAt: new Date().toISOString() }, null, 2)}\n`)
    return
  }

  if (readOptional(paths.codexOriginalPath, fs) === null) return
  try {
    fs.unlink(paths.codexOriginalPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
