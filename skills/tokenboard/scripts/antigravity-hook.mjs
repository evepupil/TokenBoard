import { dirname } from 'node:path'
import {
  antigravitySource,
  loadJsonObject,
  normalizeObject,
  quoteShellArg,
  readOptional,
  timestamp,
  writeJsonWithBackup
} from './hooks-utils.mjs'

export function installAntigravityHook({ paths, fs, nodePath = process.execPath, platform = process.platform }) {
  const loaded = loadAntigravitySettings(paths, fs)
  const settings = loaded.value || {}
  const statusLine = readStatusLineForWrite(settings)
  const currentCommand = readStatusLineCommand(statusLine)
  const command = buildAntigravityStatuslineCommand({ paths, nodePath, platform })

  if (isAntigravityStatuslineCommand(currentCommand, paths.statuslineScriptPath)) {
    if (isStatusLineEnabled(statusLine)) {
      return {
        source: antigravitySource,
        action: 'install',
        changed: false,
        detail: 'Antigravity statusline already installed'
      }
    }
    const next = {
      ...settings,
      statusLine: {
        ...statusLine,
        enabled: true
      }
    }
    const backupPath = writeJsonWithBackup(paths.antigravitySettingsPath, next, loaded.raw, fs)
    return {
      source: antigravitySource,
      action: 'install',
      changed: true,
      detail: 'Antigravity statusline enabled',
      backupPath
    }
  }

  captureOriginalAntigravityStatusLine({ settings, paths, fs })
  const next = {
    ...settings,
    statusLine: {
      ...statusLine,
      enabled: true,
      command
    }
  }
  const backupPath = writeJsonWithBackup(paths.antigravitySettingsPath, next, loaded.raw, fs)
  return {
    source: antigravitySource,
    action: 'install',
    changed: true,
    detail: 'Antigravity statusline installed',
    backupPath
  }
}

export function uninstallAntigravityHook({ paths, fs }) {
  const loaded = loadAntigravitySettings(paths, fs)
  if (loaded.status === 'missing') {
    return { source: antigravitySource, action: 'skip', changed: false, detail: 'Antigravity settings.json not found' }
  }

  const settings = loaded.value
  const statusLine = readStatusLineForWrite(settings)
  if (!isAntigravityStatuslineCommand(readStatusLineCommand(statusLine), paths.statuslineScriptPath)) {
    return { source: antigravitySource, action: 'skip', changed: false, detail: 'Antigravity statusline not installed' }
  }

  const next = restoreOriginalAntigravityStatusLine(settings, readOriginalAntigravityStatusLine(paths, fs))
  const backupPath = writeJsonWithBackup(paths.antigravitySettingsPath, next, loaded.raw, fs)
  removeStaleOriginal(paths, fs)
  return {
    source: antigravitySource,
    action: 'uninstall',
    changed: true,
    detail: 'Antigravity statusline restored',
    backupPath
  }
}

export function getAntigravityHookStatus({ paths, fs }) {
  const loaded = loadJsonObject(paths.antigravitySettingsPath, fs)
  if (loaded.status === 'missing') return 'not-installed'
  if (loaded.status === 'invalid') return 'error'
  try {
    const statusLine = readStatusLineForWrite(loaded.value)
    return isStatusLineEnabled(statusLine) &&
      isAntigravityStatuslineCommand(readStatusLineCommand(statusLine), paths.statuslineScriptPath)
      ? 'installed'
      : 'not-installed'
  } catch {
    return 'error'
  }
}

export function assertAntigravitySettingsValid({ paths, fs }) {
  loadAntigravitySettings(paths, fs)
}

function loadAntigravitySettings(paths, fs) {
  const loaded = loadJsonObject(paths.antigravitySettingsPath, fs)
  if (loaded.status === 'invalid') {
    throw new Error('Invalid Antigravity settings.json')
  }
  if (loaded.status === 'ok') readStatusLineForWrite(loaded.value)
  return loaded
}

function readStatusLineForWrite(settings) {
  if (!Object.hasOwn(settings, 'statusLine')) return {}
  const statusLine = settings.statusLine
  if (!statusLine || typeof statusLine !== 'object' || Array.isArray(statusLine)) {
    throw new Error('Unsupported Antigravity statusLine format: expected object')
  }
  return normalizeObject(statusLine)
}

function readStatusLineCommand(statusLine) {
  return typeof statusLine.command === 'string' ? statusLine.command : ''
}

function isStatusLineEnabled(statusLine) {
  return statusLine.enabled === true
}

function buildAntigravityStatuslineCommand({ paths, nodePath, platform }) {
  const args = [
    paths.statuslineScriptPath,
    '--state-dir',
    paths.stateDir,
    '--original-command-file',
    paths.antigravityOriginalStatuslinePath
  ]
  if (platform === 'win32') {
    return [nodePath, ...args].map(quoteWindowsCommandArg).join(' ')
  }
  return ['/usr/bin/env', 'node', ...args].map(quoteShellArg).join(' ')
}

function isAntigravityStatuslineCommand(command, statuslineScriptPath) {
  if (!command) return false
  const argv = splitCommandArgs(command)
  return (
    argv.some((arg) => samePathArg(arg, statuslineScriptPath)) ||
    normalizePathArg(command).includes(normalizePathArg(statuslineScriptPath))
  )
}

function captureOriginalAntigravityStatusLine({ settings, paths, fs }) {
  fs.mkdir(dirname(paths.antigravityOriginalStatuslinePath), { recursive: true })
  if (Object.hasOwn(settings, 'statusLine')) {
    writePrivateFile(
      paths.antigravityOriginalStatuslinePath,
      `${JSON.stringify(
        {
          statusLine: settings.statusLine,
          command: readStatusLineCommand(readStatusLineForWrite(settings)),
          capturedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      fs
    )
    return
  }
  removeStaleOriginal(paths, fs)
}

function writePrivateFile(filePath, value, fs) {
  fs.writeFile(filePath, value, { mode: 0o600 })
  fs.chmod?.(filePath, 0o600)
}

function restoreOriginalAntigravityStatusLine(settings, original) {
  const next = { ...settings }
  if (Object.hasOwn(original, 'statusLine')) {
    next.statusLine = original.statusLine
  } else {
    delete next.statusLine
  }
  return next
}

function readOriginalAntigravityStatusLine(paths, fs) {
  const raw = readOptional(paths.antigravityOriginalStatuslinePath, fs)
  if (raw === null) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid backup payload')
    }
    if (Object.hasOwn(parsed, 'statusLine')) {
      const statusLine = parsed.statusLine
      if (statusLine !== null && (typeof statusLine !== 'object' || Array.isArray(statusLine))) {
        throw new Error('invalid statusLine')
      }
      return statusLine === null ? {} : { statusLine }
    }
    if (typeof parsed.command === 'string') {
      return { statusLine: { command: parsed.command, enabled: true } }
    }
    return {}
  } catch (error) {
    throw new Error('Invalid Antigravity original statusline backup: expected JSON object', { cause: error })
  }
}

function removeStaleOriginal(paths, fs) {
  if (readOptional(paths.antigravityOriginalStatuslinePath, fs) === null) return
  try {
    fs.unlink(paths.antigravityOriginalStatuslinePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function splitCommandArgs(command) {
  const args = []
  let current = ''
  let quote = ''
  let started = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === quote) {
        quote = ''
        continue
      }
      current += readQuotedChar(command, index, quote).value
      if (quote === '"' && char === '\\') index += 1
      continue
    }
    if (/\s/.test(char)) {
      if (started) args.push(current)
      current = ''
      started = false
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && command[index + 1]) {
      current += command[index + 1]
      index += 1
      started = true
      continue
    }
    current += char
    started = true
  }
  if (quote) return []
  if (started) args.push(current)
  return args
}

function readQuotedChar(command, index, quote) {
  const char = command[index]
  const next = command[index + 1]
  if (quote === '"' && char === '\\' && ['"', '\\', '$', '`', '\n'].includes(next)) {
    return { value: next }
  }
  return { value: char }
}

function quoteWindowsCommandArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}

function samePathArg(left, right) {
  return normalizePathArg(left) === normalizePathArg(right)
}

function normalizePathArg(value) {
  return String(value).replaceAll('\\', '/').toLowerCase()
}
