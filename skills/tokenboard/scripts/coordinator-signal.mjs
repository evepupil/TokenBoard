import { join } from 'node:path'

export function appendSignal(runtime, trigger) {
  const payload = `${JSON.stringify({ source: trigger.source, requestedAt: new Date(runtime.now()).toISOString() })}\n`
  let queueError
  try {
    writeQueuedSignal(runtime, payload)
  } catch (error) {
    queueError = error
  }
  runtime.writeFile(
    signalPath(runtime),
    payload,
    { flag: 'a' }
  )
  if (queueError) throw queueError
}

export function truncateSignal(runtime) {
  runtime.writeFile(signalPath(runtime), '')
}

export function drainSignalSources(runtime) {
  const queuedSources = drainQueuedSignalSources(runtime)
  const legacySources = drainLegacySignalSources(runtime)
  return mergeSources(queuedSources, legacySources)
}

function drainLegacySignalSources(runtime) {
  if (typeof runtime.rename !== 'function') {
    const sources = readLegacySignalSources(runtime)
    truncateSignal(runtime)
    return sources
  }

  const path = signalPath(runtime)
  const drainPath = `${path}.${runtime.process.pid}.${runtime.now()}.drain`
  try {
    runtime.rename(path, drainPath)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  try {
    return readSourcesFromText(runtime.readFile(drainPath))
  } finally {
    try {
      runtime.unlink(drainPath)
    } catch {}
  }
}

export function readSignalSources(runtime) {
  return mergeSources(readQueuedSignalSources(runtime), readLegacySignalSources(runtime))
}

function readLegacySignalSources(runtime) {
  try {
    return readSourcesFromText(runtime.readFile(signalPath(runtime)))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function removeTempSignal(runtime, tempPath) {
  try {
    runtime.unlink?.(tempPath)
  } catch {}
}

function writeQueuedSignal(runtime, payload) {
  if (typeof runtime.rename !== 'function') return
  const dir = signalQueueDir(runtime)
  if (typeof runtime.mkdir !== 'function') {
    throw new Error('coordinator signal queue requires mkdir when rename is available')
  }
  runtime.mkdir(dir, { recursive: true })
  const name = `${runtime.now()}-${runtime.process.pid}-${Math.random().toString(36).slice(2)}`
  const tempPath = join(dir, `${name}.tmp`)
  const finalPath = join(dir, `${name}.json`)
  runtime.writeFile(tempPath, payload, { flag: 'wx' })
  try {
    runtime.rename(tempPath, finalPath)
  } catch (error) {
    removeTempSignal(runtime, tempPath)
    throw error
  }
}

function drainQueuedSignalSources(runtime) {
  if (typeof runtime.readdir !== 'function' || typeof runtime.rename !== 'function') return []
  const sources = []
  for (const name of readQueueEntries(runtime)) {
    const path = join(signalQueueDir(runtime), name)
    const drainPath = `${path}.${runtime.process.pid}.${runtime.now()}.drain`
    try {
      runtime.rename(path, drainPath)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }

    try {
      sources.push(...readSourcesFromText(runtime.readFile(drainPath)))
    } finally {
      try {
        runtime.unlink(drainPath)
      } catch {}
    }
  }
  return mergeSources(sources, [])
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
    return runtime.readdir(signalQueueDir(runtime))
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
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
