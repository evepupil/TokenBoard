import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { win32 as windowsPath } from 'node:path'

const tasklistTimeoutMs = 2_000
const processIdentityTimeoutMs = 2_000
const darwinProcessInfoSize = 136
const darwinStartSecondsOffset = 120
const darwinStartMicrosecondsOffset = 128
const currentProcessIdentityCache = new Map()

export function isProcessAlive(pid, options = {}) {
  return probeProcessLiveness(pid, options) !== 'dead'
}

export function probeProcessLiveness(pid, options = {}) {
  const platform = options.platform || process.platform
  const nodeVersion = options.nodeVersion || process.versions.node
  if (platform === 'win32' && !supportsReliableSignalZero(platform, nodeVersion)) {
    const runTasklist = options.runTasklist || spawnSync
    return isWindowsProcessAlive(pid, runTasklist, options.env)
  }
  const kill = options.kill || process.kill.bind(process)
  try {
    kill(pid, 0)
    return 'alive'
  } catch (error) {
    if (error?.code === 'EPERM') return 'alive'
    return 'dead'
  }
}

export function supportsReliableSignalZero(platform, nodeVersion) {
  if (platform !== 'win32') return true
  const [major, minor] = nodeVersion.split('.').map(Number)
  return major > 23 || (major === 22 && minor >= 16)
}

export function currentProcessStartIdentity(options = {}) {
  const pid = options.pid ?? process.pid
  const cacheKey = cacheKeyForCurrentProcess(pid, options)
  if (cacheKey) {
    const cached = currentProcessIdentityCache.get(cacheKey)
    if (cached) return cached
  }
  const identity = probeProcessStartIdentity(pid, options)
  if (identity.status !== 'known') return undefined
  if (cacheKey) currentProcessIdentityCache.set(cacheKey, identity.value)
  return identity.value
}

function cacheKeyForCurrentProcess(pid, options) {
  if (
    pid !== process.pid ||
    options.readProcessStartIdentity ||
    options.runProcessIdentity ||
    options.readFile ||
    options.kill ||
    options.runTasklist
  ) {
    return null
  }
  const platform = options.platform || process.platform
  const nodeVersion = options.nodeVersion || process.versions.node
  return `${pid}:${platform}:${nodeVersion}`
}

export function probeProcessStartIdentity(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'dead' }
  if (typeof options.readProcessStartIdentity === 'function') {
    try {
      return normalizeProcessStartIdentity(options.readProcessStartIdentity(pid))
    } catch (error) {
      return error?.code === 'ENOENT' ? { status: 'dead' } : { status: 'unknown' }
    }
  }

  const platform = options.platform || process.platform
  if (platform === 'linux') return readLinuxProcessStartIdentity(pid, options)
  if (platform === 'win32') return readWindowsProcessStartIdentity(pid, options)
  if (platform === 'darwin') return readDarwinProcessStartIdentity(pid, options)
  return readPsProcessStartIdentity(pid, options)
}

export function tasklistContainsPid(output, pid) {
  return output.split(/\r?\n/).some((line) => {
    const match = line.match(/^"[^"]+","(\d+)"(?:,|$)/)
    return match?.[1] === String(pid)
  })
}

export function tasklistCommand(env = process.env) {
  const systemRoot = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : ''
  const root = isDriveRootedWindowsPath(systemRoot) ? systemRoot : 'C:\\Windows'
  return windowsPath.join(root, 'System32', 'tasklist.exe')
}

export function powershellCommand(env = process.env) {
  const systemRoot = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : ''
  const root = isDriveRootedWindowsPath(systemRoot) ? systemRoot : 'C:\\Windows'
  return windowsPath.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function isDriveRootedWindowsPath(value) {
  return windowsPath.isAbsolute(value)
}

function isWindowsProcessAlive(pid, runTasklist, env) {
  const result = runTasklist(tasklistCommand(env), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: tasklistTimeoutMs
  })
  if (result.error || result.status !== 0) return 'unknown'
  return tasklistContainsPid(result.stdout, pid) ? 'alive' : 'dead'
}

function normalizeProcessStartIdentity(value) {
  if (
    value &&
    typeof value === 'object' &&
    (value.status === 'known' || value.status === 'dead' || value.status === 'unknown')
  ) {
    if (value.status !== 'known') return { status: value.status }
    return typeof value.value === 'string' && value.value
      ? { status: 'known', value: value.value }
      : { status: 'unknown' }
  }
  if (typeof value === 'string' && value) return { status: 'known', value }
  return { status: 'unknown' }
}

function readLinuxProcessStartIdentity(pid, options = {}) {
  const readFile = options.readFile || readFileSync
  let raw
  try {
    raw = readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'dead' } : { status: 'unknown' }
  }
  const commandEnd = raw.lastIndexOf(')')
  if (commandEnd < 0) return { status: 'unknown' }
  const fields = raw
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)
  const startTicks = fields[19]
  if (!/^\d+$/.test(startTicks || '')) return { status: 'unknown' }

  let bootId
  try {
    const value = readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    if (typeof value !== 'string') return { status: 'unknown' }
    bootId = value.trim()
  } catch {
    return { status: 'unknown' }
  }
  if (!bootId || bootId.length > 256 || /\s/.test(bootId)) return { status: 'unknown' }
  return { status: 'known', value: `linux:${bootId}:${startTicks}` }
}

function readDarwinProcessStartIdentity(pid, options = {}) {
  const runProcessIdentity = options.runProcessIdentity || spawnSync
  const result = runProcessIdentity(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', darwinProcessIdentityScript(pid)],
    {
      encoding: 'utf8',
      timeout: processIdentityTimeoutMs,
      // osascript can outlive a terminated Node caller; force a bounded probe.
      killSignal: 'SIGKILL'
    }
  )
  if (result.error || result.status == null) return { status: 'unknown' }
  if (result.status !== 0) return processIdentityFailureStatus(pid, options)

  const encoded = String(result.stdout || '').trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return { status: 'unknown' }
  }
  try {
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length !== darwinProcessInfoSize) return { status: 'unknown' }
    const seconds = bytes.readBigUInt64LE(darwinStartSecondsOffset)
    const microseconds = bytes.readBigUInt64LE(darwinStartMicrosecondsOffset)
    if (seconds <= 0n || microseconds >= 1_000_000n) return { status: 'unknown' }
    return { status: 'known', value: `darwin:${seconds}:${microseconds}` }
  } catch {
    return { status: 'unknown' }
  }
}

function darwinProcessIdentityScript(pid) {
  return `ObjC.import("Foundation"); const procPidInfoTypes = ["int", ["int", "int", "unsigned long", "pointer", "int"]]; try { ObjC.bindFunction("proc_pidinfo", procPidInfoTypes); } catch (_) { ObjC.bindFunction("proc_pidinfo", procPidInfoTypes, "/usr/lib/libproc.dylib"); } const data = $.NSMutableData.dataWithLength(${darwinProcessInfoSize}); const size = $.proc_pidinfo(${pid}, 3, 0, data.mutableBytes, ${darwinProcessInfoSize}); if (size !== ${darwinProcessInfoSize}) { throw new Error("proc_pidinfo unavailable") }; ObjC.unwrap(data.base64EncodedStringWithOptions(0));`
}

function processIdentityFailureStatus(pid, options) {
  const kill = options.kill || process.kill.bind(process)
  try {
    kill(pid, 0)
    return { status: 'unknown' }
  } catch (error) {
    return error?.code === 'ESRCH' ? { status: 'dead' } : { status: 'unknown' }
  }
}

function readPsProcessStartIdentity(pid, options) {
  const result = (options.runProcessIdentity || spawnSync)('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: processIdentityTimeoutMs,
    // SIGKILL cannot be ignored, so spawnSync returns at the timeout boundary.
    killSignal: 'SIGKILL',
    env: { ...process.env, LC_ALL: 'C' }
  })
  if (result.error) return { status: 'unknown' }
  const output = String(result.stdout || '').trim()
  if (!output) return result.status === 1 ? { status: 'dead' } : { status: 'unknown' }
  // POSIX ps lstart is only second-precision. It is useful for diagnostics,
  // but not strong enough to distinguish same-second PID reuse.
  return { status: 'unknown' }
}

function readWindowsProcessStartIdentity(pid, options) {
  const command = `try { $process = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks) } catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -or $_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { exit 3 }; exit 4 }`
  const result = (options.runProcessIdentity || spawnSync)(
    powershellCommand(options.env),
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf8',
      timeout: processIdentityTimeoutMs,
      // PowerShell can ignore the default SIGTERM; force a bounded probe.
      killSignal: 'SIGKILL',
      windowsHide: true
    }
  )
  if (result.error) return { status: 'unknown' }
  if (result.status === 3) return { status: 'dead' }
  if (result.status !== 0) return { status: 'unknown' }
  const ticks = String(result.stdout || '').trim()
  return /^\d+$/.test(ticks) ? { status: 'known', value: `windows:${ticks}` } : { status: 'unknown' }
}
