import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const notifyHandlerMarker = 'TOKENBOARD_NOTIFY_HANDLER'
export const codexSource = 'codex'
export const claudeSource = 'claude-code'

export function readSources(value) {
  const sources = String(value || 'all')
    .split(',')
    .map((source) => source.trim())
    .filter(Boolean)
  for (const source of sources) {
    if (source === 'all') continue
    if (source !== codexSource && source !== claudeSource) {
      throw new Error(`Unsupported hook source: ${source}`)
    }
  }
  if (sources.includes('all')) return [codexSource, claudeSource]
  return [...new Set(sources)]
}

export function removeNotifyHandler({ paths, fs }) {
  const text = readOptional(paths.notifyPath, fs)
  if (text === null || !isTokenBoardNotifyHandler(text)) return false
  fs.unlink(paths.notifyPath)
  return true
}

export function isTokenBoardNotifyHandler(text) {
  return typeof text === 'string' && text.includes(notifyHandlerMarker)
}

export function extractTomlStringArray(text, key) {
  const result = inspectTomlStringArray(text, key)
  return result.status === 'ok' ? result.value : null
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
    return value === null
      ? { status: 'invalid', value: null }
      : { status: 'ok', value }
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
    fs.writeFile(backupPath, previousRaw)
  }
  fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
  return backupPath
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
    mkdir: (path, options) => mkdirSync(path, options),
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, value, options) => writeFileSync(path, value, options),
    unlink: (path) => unlinkSync(path)
  }
}

export function quoteShellArg(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
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
