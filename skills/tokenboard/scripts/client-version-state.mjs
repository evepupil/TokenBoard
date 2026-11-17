import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Records which client version is installed and when it last changed.
//
// `self-update` verifies only that the new binary answers `version`; it cannot
// tell whether that binary collects correctly. Keeping the version and the time
// it appeared lets an operator read `status.mjs` and ask the one question the
// client cannot answer itself: "did the thing break when the version changed?"
// It is a diagnostic, not a rollback trigger — a failed sync has many causes
// (server, network, config), and reverting on that signal would swap a known
// version back in for an unknown reason.

export const clientVersionStateFileName = 'client-version-state.json'
export const clientVersionStateSchemaVersion = 'tokenboard-client-version/v1'

export function clientVersionStatePath(stateDir) {
  return join(stateDir, clientVersionStateFileName)
}

// readClientVersionState returns the recorded state, or null when it is absent
// or unreadable. A half-written or corrupt file must not fail status.
export function readClientVersionState(stateDir) {
  let raw
  try {
    raw = readFileSync(clientVersionStatePath(stateDir), 'utf8')
  } catch {
    return null
  }
  try {
    const value = JSON.parse(raw)
    if (value?.schemaVersion !== clientVersionStateSchemaVersion) return null
    if (typeof value.version !== 'string' || !value.version) return null
    if (typeof value.since !== 'string') return null
    return {
      version: value.version,
      since: value.since,
      ...(typeof value.previous === 'string' && value.previous ? { previous: value.previous } : {})
    }
  } catch {
    return null
  }
}

// recordClientVersion stores the version now installed and reports whether it
// differs from the last one. `since` tracks when the current version first
// appeared, so the timestamp answers "how long has this version been running"
// rather than "when did we last look".
export function recordClientVersion({ stateDir, version, now = Date.now, fs = defaultFs }) {
  const previous = readClientVersionState(stateDir)
  const stamp = new Date(now()).toISOString()
  if (previous && previous.version === version) {
    return { changed: false, version, previous: previous.previous, since: previous.since }
  }
  const next = {
    schemaVersion: clientVersionStateSchemaVersion,
    version,
    since: stamp,
    ...(previous ? { previous: previous.version } : {})
  }
  writeState(stateDir, next, fs)
  return { changed: true, version, previous: previous?.version, since: stamp }
}

function writeState(stateDir, state, fs) {
  fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = clientVersionStatePath(stateDir)
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 })
    fs.rename(temporaryPath, path)
    fs.chmod(path, 0o600)
  } catch (error) {
    try {
      fs.unlink(temporaryPath)
    } catch {}
    throw error
  }
}

const defaultFs = {
  mkdir: mkdirSync,
  writeFile: writeFileSync,
  rename: renameSync,
  chmod: chmodSync,
  unlink: unlinkSync
}
