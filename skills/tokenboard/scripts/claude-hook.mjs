import {
  claudeSource,
  loadJsonObject,
  normalizeArray,
  normalizeObject,
  quoteShellArg,
  writeJsonWithBackup
} from './hooks-utils.mjs'

export function installClaudeHook({ paths, fs, nodePath = process.execPath, platform = process.platform }) {
  const loaded = loadJsonObject(paths.claudeSettingsPath, fs)
  if (loaded.status === 'invalid') {
    throw new Error('Invalid Claude settings.json')
  }
  const settings = loaded.value || {}
  const command = buildClaudeHookCommand({ notifyPath: paths.notifyPath, nodePath, platform })
  const hooks = normalizeObject(settings.hooks)
  const entries = normalizeArray(hooks.SessionEnd)
  if (hasClaudeCommand(entries, paths.notifyPath)) {
    return { source: claudeSource, action: 'install', changed: false, detail: 'Claude hook already installed' }
  }

  const next = {
    ...settings,
    hooks: {
      ...hooks,
      SessionEnd: [...entries, { hooks: [{ type: 'command', command }] }]
    }
  }
  const backupPath = writeJsonWithBackup(paths.claudeSettingsPath, next, loaded.raw, fs)
  return { source: claudeSource, action: 'install', changed: true, detail: 'Claude hook installed', backupPath }
}

export function uninstallClaudeHook({ paths, fs, nodePath = process.execPath, platform = process.platform }) {
  const loaded = loadJsonObject(paths.claudeSettingsPath, fs)
  if (loaded.status === 'missing') {
    return { source: claudeSource, action: 'skip', changed: false, detail: 'Claude settings.json not found' }
  }
  if (loaded.status === 'invalid') {
    throw new Error('Invalid Claude settings.json')
  }

  const settings = loaded.value
  const hooks = normalizeObject(settings.hooks)
  const entries = normalizeArray(hooks.SessionEnd)
  let removed = false
  const nextEntries = entries
    .map((entry) => {
      const hookList = Array.isArray(entry.hooks) ? entry.hooks : []
      const filtered = hookList.filter((hook) => !isClaudeNotifyHook(hook, paths.notifyPath))
      if (filtered.length !== hookList.length) removed = true
      return filtered.length > 0 ? { ...entry, hooks: filtered } : null
    })
    .filter(Boolean)

  if (!removed) {
    return { source: claudeSource, action: 'skip', changed: false, detail: 'Claude hook not installed' }
  }

  const nextHooks = { ...hooks }
  if (nextEntries.length > 0) nextHooks.SessionEnd = nextEntries
  else delete nextHooks.SessionEnd

  const nextSettings = { ...settings }
  if (Object.keys(nextHooks).length > 0) nextSettings.hooks = nextHooks
  else delete nextSettings.hooks

  const backupPath = writeJsonWithBackup(paths.claudeSettingsPath, nextSettings, loaded.raw, fs)
  return { source: claudeSource, action: 'uninstall', changed: true, detail: 'Claude hook removed', backupPath }
}

export function getClaudeHookStatus({ paths, fs, nodePath = process.execPath, platform = process.platform }) {
  const loaded = loadJsonObject(paths.claudeSettingsPath, fs)
  if (loaded.status === 'missing') return 'not-installed'
  if (loaded.status === 'invalid') return 'error'
  return hasClaudeCommand(
    normalizeArray(normalizeObject(loaded.value.hooks).SessionEnd),
    paths.notifyPath
  ) ? 'installed' : 'not-installed'
}

export function assertClaudeSettingsValid({ paths, fs }) {
  const loaded = loadJsonObject(paths.claudeSettingsPath, fs)
  if (loaded.status === 'invalid') {
    throw new Error('Invalid Claude settings.json')
  }
}

function buildClaudeHookCommand({ notifyPath, nodePath, platform }) {
  if (platform === 'win32') {
    return `${quoteWindowsCommandArg(nodePath)} ${quoteWindowsCommandArg(notifyPath)} --source=${claudeSource}`
  }
  return `/usr/bin/env node ${quoteShellArg(notifyPath)} --source=${claudeSource}`
}

function hasClaudeCommand(entries, notifyPath) {
  return entries.some((entry) => {
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : []
    return hooks.some((hook) => isClaudeNotifyHook(hook, notifyPath))
  })
}

function isClaudeNotifyHook(hook, notifyPath) {
  if (!hook || typeof hook !== 'object' || typeof hook.command !== 'string') return false
  const argv = splitCommandArgs(hook.command)
  const notifyIndex = argv.findIndex((arg) => arg === notifyPath)
  return isNodeExecutingNotify(argv, notifyIndex) &&
    hasSourceArg(argv, notifyIndex + 1, claudeSource)
}

function hasSourceArg(argv, startIndex, source) {
  for (let index = startIndex; index < argv.length; index += 1) {
    if (argv[index] === `--source=${source}`) return true
    if (argv[index] === '--source' && argv[index + 1] === source) return true
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

function isNodeExecutingNotify(argv, notifyIndex) {
  if (notifyIndex === 1) {
    return isNodeCommand(argv[0])
  }
  if (notifyIndex === 2) {
    return isEnvCommand(argv[0]) && isNodeCommand(argv[1])
  }
  return false
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
      const parsed = readQuotedChar(command, index, quote)
      current += parsed.value
      index = parsed.nextIndex
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
    return { value: next, nextIndex: index + 1 }
  }
  return { value: char, nextIndex: index }
}

function quoteWindowsCommandArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}
