import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const notifyHandlerMarker = 'TOKENBOARD_NOTIFY_HANDLER'
export { antigravitySource, claudeSource, codexSource, readSources, readUninstallSources } from './hook-sources.mjs'

export function removeNotifyHandler({ paths, fs }) {
  const text = readOptional(paths.notifyPath, fs)
  if (text === null || !isTokenBoardNotifyHandler(text)) return false
  fs.unlink(paths.notifyPath)
  return true
}

export function isTokenBoardNotifyHandler(text) {
  return typeof text === 'string' && text.includes(notifyHandlerMarker)
}

export function inspectTomlStringArray(text, key) {
  const lines = text.split(/\r?\n/)
  const keyPattern = tomlKeyPattern(key)
  for (let index = 0; index < topLevelLineCount(lines); index += 1) {
    const match = lines[index].match(keyPattern)
    if (!match) continue
    const literal = readTomlArrayLiteral(lines, index, match[1].trim())
    if (!literal) return { status: 'invalid', value: null }
    const value = parseTomlStringArray(literal)
    return value === null ? { status: 'invalid', value: null } : { status: 'ok', value }
  }
  return { status: 'missing', value: null }
}

export function setTomlStringArray(text, key, values) {
  const lines = text.split(/\r?\n/)
  const out = []
  let replaced = false
  const keyPattern = tomlKeyPattern(key)
  const topLevelEnd = topLevelLineCount(lines)
  for (let index = 0; index < lines.length; index += 1) {
    const match = index < topLevelEnd ? lines[index].match(keyPattern) : null
    if (!match) {
      out.push(lines[index])
      continue
    }
    if (!replaced) {
      out.push(`${key} = ${formatTomlStringArray(values)}`)
      replaced = true
    }
    index = findTomlArrayBlockEnd(lines, index, match[1].trim())
  }
  if (!replaced) {
    const firstTable = out.findIndex((line) => /^\s*\[/.test(line))
    out.splice(firstTable === -1 ? out.length : firstTable, 0, `${key} = ${formatTomlStringArray(values)}`)
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

export function removeTomlKey(text, key) {
  const lines = text.split(/\r?\n/)
  const out = []
  const keyPattern = tomlKeyPattern(key)
  const topLevelEnd = topLevelLineCount(lines)
  for (let index = 0; index < lines.length; index += 1) {
    const match = index < topLevelEnd ? lines[index].match(keyPattern) : null
    if (!match) {
      out.push(lines[index])
      continue
    }
    index = findTomlArrayBlockEnd(lines, index, match[1].trim())
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

export function loadJsonObject(filePath, fs) {
  const raw = readOptional(filePath, fs)
  if (raw === null) return { status: 'missing', raw: null, value: null }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { status: 'invalid', raw, value: null }
    }
    return { status: 'ok', raw, value }
  } catch {
    return { status: 'invalid', raw, value: null }
  }
}

export function writeJsonWithBackup(filePath, value, previousRaw, fs) {
  fs.mkdir(dirname(filePath), { recursive: true })
  let backupPath
  if (previousRaw !== null) {
    backupPath = `${filePath}.bak.${timestamp()}`
    writePrivateFile(backupPath, previousRaw, fs)
  }
  fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
  return backupPath
}

// Hook backups hold the previous settings verbatim — the original notify argv or statusLine
// command, which can carry a webhook URL or a command-line token. `~/.codex`, `~/.claude` and
// `~/.gemini` are commonly 0755, so a backup left at the default umask (0644) would be
// world-readable. Same intent as `antigravity-hook`'s private original-statusline write.
export function writePrivateFile(filePath, value, fs) {
  fs.writeFile(filePath, value, { mode: 0o600 })
  fs.chmod?.(filePath, 0o600)
}

export function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
}

export function normalizeArray(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : []
}

export function readOptional(filePath, fs) {
  try {
    return fs.readFile(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function nodeFs() {
  return {
    chmod: (path, mode) => chmodSync(path, mode),
    exists: (path) => existsSync(path),
    mkdir: (path, options) => mkdirSync(path, options),
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, value, options) => writeFileSync(path, value, options),
    unlink: (path) => unlinkSync(path)
  }
}

export function quoteShellArg(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function readTomlArrayLiteral(lines, startIndex, rhs) {
  if (rhs.startsWith('[')) {
    const endIndex = findTomlArrayLiteralEnd(rhs)
    if (endIndex !== -1) return rhs.slice(0, endIndex + 1)
  }
  if (!rhs.startsWith('[')) return ''
  const parts = [rhs]
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    parts.push(lines[index])
    if (findTomlArrayLiteralEnd(parts.join('\n')) !== -1) break
  }
  return parts.join('\n')
}

function findTomlArrayBlockEnd(lines, startIndex, rhs) {
  if (!rhs.startsWith('[') || findTomlArrayLiteralEnd(rhs) !== -1) return startIndex
  const parts = [rhs]
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    parts.push(lines[index])
    if (findTomlArrayLiteralEnd(parts.join('\n')) !== -1) return index
  }
  return startIndex
}

function topLevelLineCount(lines) {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line))
  return firstTable === -1 ? lines.length : firstTable
}

function tomlKeyPattern(key) {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)\\s*$`)
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function parseTomlStringArray(text) {
  if (!text.startsWith('[') || !text.endsWith(']')) return null
  const values = []
  let index = 1
  while (index < text.length) {
    index = skipTomlArrayWhitespace(text, index)
    if (text[index] === ']') return values
    const parsed = parseTomlString(text, index)
    if (parsed === null) return null
    values.push(parsed.value)
    index = skipTomlArrayWhitespace(text, parsed.nextIndex)
    if (text[index] === ',') {
      index += 1
      continue
    }
    if (text[index] === ']') return values
    return null
  }
  return null
}

function findTomlArrayLiteralEnd(text) {
  let quote = ''
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') quote = ''
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ']') return index
  }
  return -1
}

function formatTomlStringArray(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`
}

function skipTomlArrayWhitespace(text, startIndex) {
  let index = startIndex
  while (index < text.length && /[\s]/.test(text[index])) index += 1
  return index
}

function parseTomlString(text, startIndex) {
  const quote = text[startIndex]
  if (quote === "'") return parseTomlLiteralString(text, startIndex)
  if (quote === '"') return parseTomlBasicString(text, startIndex)
  return null
}

function parseTomlLiteralString(text, startIndex) {
  const endIndex = text.indexOf("'", startIndex + 1)
  if (endIndex === -1) return null
  return {
    value: text.slice(startIndex + 1, endIndex),
    nextIndex: endIndex + 1
  }
}

function parseTomlBasicString(text, startIndex) {
  let escaped = false
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      try {
        return {
          value: JSON.parse(text.slice(startIndex, index + 1)),
          nextIndex: index + 1
        }
      } catch {
        return null
      }
    }
  }
  return null
}

// The same file reaches the hook checks spelled two ways: `path.join` produces backslashes on
// Windows, while a config written on macOS (a shared settings file), by hand, or by an older
// install spells it with forward slashes. Comparing those as plain strings reports "not
// installed", so install appends a duplicate hook — the sync then runs twice per session — and
// uninstall cannot find the stale copy at all. Windows paths are also case-insensitive, so the
// filename case must not decide identity either. Both the Claude and the Codex hook checks go
// through this one function; fixing only one of them is the bug that left the Codex half broken.
export function normalizePathForComparison(value) {
  return String(value).replace(/\\/g, '/').toLowerCase()
}
