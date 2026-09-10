import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { errorMessage } from './error-message.mjs'

export function appendSignal(runtime, trigger) {
  const payload = `${JSON.stringify({ source: trigger.source, requestedAt: new Date(runtime.now()).toISOString() })}\n`
  let queued = false
  let queueError
  try {
    queued = writeQueuedSignal(runtime, payload, trigger.source)
  } catch (error) {
    queueError = error
  }
  if (!queued || queueError) {
    runtime.writeFile(signalPath(runtime), payload, { flag: 'a' })
    if (queueError) throw queueError
  }
}

export function truncateSignal(runtime) {
  runtime.writeFile(signalPath(runtime), '')
}

export function acknowledgeSignalSource(runtime, source) {
  const sourceName = signalSourceName(source)
  const recovered = normalizeSignalRecoveryEntries(readSignalRecoveryEntries(runtime), runtime)
  const unexpected = recovered.find(({ sources }) => sources.includes(sourceName) && sources.length !== 1)
  if (unexpected) {
    throw new Error('TokenBoard signal recovery journal must be normalized before acknowledgement')
  }
  for (const { path, sources } of recovered) {
    if (sources.length !== 1 || sources[0] !== sourceName) continue
    try {
      removeDrainedSignal(path, runtime)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

export function drainSignalSources(runtime) {
  // Validate retained recovery state before rotating new signals into uniquely
  // named drain files. A malformed journal must fail closed without creating
  // an unbounded set of files on every retry.
  const recovered = normalizeSignalRecoveryEntries(readSignalRecoveryEntries(runtime), runtime)
  const queuedDrainPaths = drainQueuedSignalPaths(runtime)
  const legacyDrainPaths = drainLegacySignalPaths(runtime)
  return consumeDrainedSignalSources([...queuedDrainPaths, ...legacyDrainPaths], recovered, runtime)
}

function drainLegacySignalPaths(runtime) {
  if (typeof runtime.rename !== 'function') {
    return [...retainedLegacyDrainPaths(runtime), ...drainLegacySignalWithoutRename(runtime)]
  }

  const drainPaths = retainedLegacyDrainPaths(runtime)
  const path = signalPath(runtime)
  const drainPath = signalDrainPath(path, runtime)
  try {
    runtime.rename(path, drainPath)
    drainPaths.push(drainPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  return drainPaths
}

export function readSignalSources(runtime) {
  return mergeSources(
    readSignalRecoveryEntries(runtime).flatMap(({ sources }) => sources),
    mergeSources(readQueuedSignalSources(runtime), readLegacySignalSources(runtime))
  )
}

function readLegacySignalSources(runtime) {
  const sources = readRetainedLegacySignalSources(runtime)
  try {
    return mergeSources(sources, readSourcesFromText(runtime.readFile(signalPath(runtime))))
  } catch (error) {
    if (error.code === 'ENOENT') return sources
    throw error
  }
}

function removeTempSignal(runtime, tempPath) {
  try {
    runtime.unlink?.(tempPath)
  } catch {}
}

function writeQueuedSignal(runtime, payload, source) {
  if (typeof runtime.rename !== 'function') return false
  const dir = signalQueueDir(runtime)
  if (typeof runtime.mkdir !== 'function') {
    throw new Error('coordinator signal queue requires mkdir when rename is available')
  }
  runtime.mkdir(dir, { recursive: true })
  const name = `${runtime.now()}-${runtime.process.pid}-${Math.random().toString(36).slice(2)}`
  const tempPath = join(dir, `${name}.tmp`)
  const finalPath = join(dir, `${signalSourceName(source)}.json`)
  runtime.writeFile(tempPath, payload, { flag: 'wx' })
  try {
    runtime.rename(tempPath, finalPath)
    return true
  } catch (error) {
    removeTempSignal(runtime, tempPath)
    throw error
  }
}

function signalSourceName(source) {
  if (source === 'codex' || source === 'claude-code') return source
  throw new Error('Unsupported TokenBoard signal source')
}

function drainQueuedSignalPaths(runtime) {
  if (typeof runtime.readdir !== 'function' || typeof runtime.rename !== 'function') return []
  const drainPaths = []
  for (const name of readQueueEntries(runtime)) {
    const path = join(signalQueueDir(runtime), name)
    if (isDrainedSignalEntry(name)) {
      drainPaths.push(path)
      continue
    }
    const drainPath = signalDrainPath(path, runtime)
    try {
      runtime.rename(path, drainPath)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    drainPaths.push(drainPath)
  }
  return drainPaths
}

function readQueuedSignalSources(runtime) {
  if (typeof runtime.readdir !== 'function') return []
  const sources = []
  for (const name of readQueueEntries(runtime)) {
    try {
      sources.push(...readSourcesFromText(runtime.readFile(join(signalQueueDir(runtime), name))))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return mergeSources(sources, [])
}

function readQueueEntries(runtime) {
  try {
    return runtime.readdir(signalQueueDir(runtime)).filter(isQueuedSignalEntry).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function isQueuedSignalEntry(name) {
  return isActiveQueuedSignalEntry(name) || isDrainedSignalEntry(name)
}

function isActiveQueuedSignalEntry(name) {
  return name === 'codex.json' || name === 'claude-code.json' || isLegacyQueuedSignalEntry(name)
}

function isLegacyQueuedSignalEntry(name) {
  return /^\d+-\d+-[a-z0-9]+\.json$/.test(name)
}

function isDrainedSignalEntry(name) {
  return /^(?:codex|claude-code|\d+-\d+-[a-z0-9]+)\.json\.[^.]+\.[^.]+(?:\.[^.]+)?\.drain$/.test(name)
}

function retainedLegacyDrainPaths(runtime) {
  if (typeof runtime.readdir !== 'function') return []
  try {
    return runtime
      .readdir(runtime.stateDir)
      .filter(isLegacyDrainedSignalEntry)
      .sort()
      .map((name) => join(runtime.stateDir, name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function retainedSignalRecoveryPaths(runtime) {
  if (typeof runtime.readdir !== 'function') return []
  try {
    return runtime
      .readdir(runtime.stateDir)
      .filter(isSignalRecoveryEntry)
      .sort()
      .map((name) => join(runtime.stateDir, name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function readSignalRecoveryEntries(runtime) {
  const entries = []
  for (const path of retainedSignalRecoveryPaths(runtime)) {
    try {
      entries.push({
        path,
        sources: readSignalRecoverySourcesFromText(runtime.readFile(path))
      })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return entries
}

function readRetainedLegacySignalSources(runtime) {
  return retainedLegacyDrainPaths(runtime).flatMap((path) => readSourcesFromText(runtime.readFile(path)))
}

function isLegacyDrainedSignalEntry(name) {
  return /^notify\.signal\.[^.]+\.[^.]+(?:\.[^.]+)?\.drain$/.test(name)
}

function isSignalRecoveryEntry(name) {
  return (
    name === 'notify.signal.recovery.codex.json' ||
    name === 'notify.signal.recovery.claude-code.json' ||
    /^notify\.signal\.recovery\.[^.]+\.[^.]+\.[a-f0-9]+\.json$/.test(name)
  )
}

function signalDrainPath(path, runtime) {
  return `${path}.${runtime.process.pid}.${runtime.now()}.${randomBytes(8).toString('hex')}.drain`
}

function drainLegacySignalWithoutRename(runtime) {
  const path = signalPath(runtime)
  try {
    const sources = readSourcesFromText(runtime.readFile(path))
    return [{ path, sources, remove: () => truncateSignal(runtime) }]
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function consumeDrainedSignalSources(entries, recovered, runtime) {
  const drained = entries.flatMap((entry) => {
    if (typeof entry !== 'string') return [entry]
    try {
      return [
        {
          path: entry,
          sources: readSourcesFromText(runtime.readFile(entry)),
          remove: () => removeDrainedSignal(entry, runtime)
        }
      ]
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  })
  if (drained.length === 0 && recovered.length === 0) return []
  const sources = mergeSources(
    recovered.flatMap(({ sources }) => sources),
    drained.flatMap(({ sources }) => sources)
  )
  try {
    ensureSignalRecoveryJournals(recovered, sources, runtime)
    for (const { remove } of drained) remove()
  } catch (error) {
    throw new Error(`TokenBoard signal cleanup failed; recovery journal retained: ${errorMessage(error)}`, {
      cause: error
    })
  }
  return sources
}

function normalizeSignalRecoveryEntries(entries, runtime) {
  const multiSourceEntries = entries.filter(({ sources }) => sources.length > 1)
  if (multiSourceEntries.length === 0) return entries
  const individualEntries = entries.filter(({ sources }) => sources.length === 1)
  const sources = mergeSources(
    multiSourceEntries.flatMap(({ sources }) => sources),
    []
  )
  try {
    ensureSignalRecoveryJournals(individualEntries, sources, runtime)
    for (const { path } of multiSourceEntries) removeDrainedSignal(path, runtime)
  } catch (error) {
    throw new Error(`TokenBoard signal recovery journal migration failed: ${errorMessage(error)}`, { cause: error })
  }
  return [
    ...individualEntries,
    ...sources
      .filter((source) => !individualEntries.some(({ sources }) => sources[0] === source))
      .map((source) => ({ path: signalRecoveryPath(source, runtime), sources: [source] }))
  ]
}

function ensureSignalRecoveryJournals(recovered, sources, runtime) {
  for (const source of sources) {
    if (
      recovered.some(({ sources: recoveredSources }) => {
        return recoveredSources.length === 1 && recoveredSources[0] === source
      })
    )
      continue
    writeSignalRecoveryJournal(source, runtime)
  }
}

function removeDrainedSignal(path, runtime) {
  runtime.unlink(path)
}

function writeSignalRecoveryJournal(source, runtime) {
  const path = signalRecoveryPath(source, runtime)
  try {
    runtime.writeFile(path, `${JSON.stringify({ version: 2, source })}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const sources = readSignalRecoverySourcesFromText(runtime.readFile(path))
    if (sources.length === 1 && sources[0] === source) return
    throw new Error('Unexpected TokenBoard signal recovery journal already exists', { cause: error })
  }
}

function signalRecoveryPath(source, runtime) {
  return join(runtime.stateDir, `notify.signal.recovery.${signalSourceName(source)}.json`)
}

function readSignalRecoverySourcesFromText(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid TokenBoard signal recovery journal: ${errorMessage(error)}`, { cause: error })
  }
  if (parsed?.version === 2 && (parsed.source === 'codex' || parsed.source === 'claude-code')) {
    return [parsed.source]
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.sources)) {
    throw new Error('Invalid TokenBoard signal recovery journal')
  }
  const sources = parsed.sources.filter((source) => source === 'codex' || source === 'claude-code')
  if (sources.length !== parsed.sources.length || sources.length === 0) {
    throw new Error('Invalid TokenBoard signal recovery journal')
  }
  return mergeSources(sources, [])
}

function readSourcesFromText(text) {
  const sources = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const source = parseSignalSource(line)
    if (!source || seen.has(source)) continue
    sources.push(source)
    seen.add(source)
  }
  return sources
}

function parseSignalSource(line) {
  const value = line.trim()
  if (!value) return null
  if (value === 'codex' || value === 'claude-code') return value
  try {
    const parsed = JSON.parse(value)
    return parsed?.source === 'codex' || parsed?.source === 'claude-code' ? parsed.source : null
  } catch {
    return null
  }
}

function mergeSources(left, right) {
  const merged = []
  const seen = new Set()
  for (const source of [...left, ...right]) {
    if (!source || seen.has(source)) continue
    merged.push(source)
    seen.add(source)
  }
  return merged
}

function signalPath(runtime) {
  return join(runtime.stateDir, 'notify.signal')
}

function signalQueueDir(runtime) {
  return join(runtime.stateDir, 'notify.signal.d')
}
