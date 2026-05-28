#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDir, parseArgs, readConfig } from './config.mjs'
import { coordinatedSync } from './coordinator.mjs'

const cooldownMs = 300_000
const maxTrailingLockAcquireAttempts = 3

export function runNotify(options = {}) {
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const source = readSource(flags.source)
  const stateDir = options.stateDir
  const configDirectory = options.configDir || stateDir
  const trigger = { kind: 'notify', source }
  return coordinatedSync(trigger, {
    stateDir,
    cooldownMs: options.cooldownMs ?? cooldownMs,
    version: options.version || 'unknown',
    now: options.now,
    mkdir: options.mkdir,
    exists: options.exists,
    readFile: options.readFile,
    writeFile: options.writeFile,
    readdir: options.readdir,
    unlink: options.unlink,
    sleep: options.sleep,
    process: options.process,
    trailingProcess: options.trailingProcess ?? hasTrailingDelay(),
    scheduleTrailing: options.scheduleTrailing || ((trigger, delayMs) =>
      scheduleTrailingNotify(trigger, delayMs, { ...options, configDir: configDirectory })
    ),
    executeSync: options.executeSync || ((trigger) => executeTokenBoardSync(trigger.source, options))
  })
}

function executeTokenBoardSync(source, options = {}) {
  const scriptPath = options.syncScriptPath || fileURLToPath(new URL('./sync.mjs', import.meta.url))
  const spawn = options.spawn || spawnSync
  const result = spawn(
    options.nodePath || process.execPath,
    [scriptPath, '--mode', 'sync', '--source', source, '--hook'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  )
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(formatSyncFailure(result))
  }
  return { source, exitCode: 0 }
}

function scheduleTrailingNotify(trigger, delayMs, options = {}) {
  const runtime = trailingRuntime(options)
  const lockPath = join(runtime.stateDir, 'trailing.lock')
  const lock = acquireTrailingLock(lockPath, runtime)
  if (!lock.acquired) return true

  const spawnProcess = options.spawnDetached || spawn
  const nodePath = options.nodePath || process.execPath
  const scriptPath = options.notifyScriptPath || fileURLToPath(import.meta.url)
  try {
    const child = spawnProcess(
      nodePath,
      [scriptPath, '--source', trigger.source],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          TOKENBOARD_CONFIG_DIR: runtime.configDir,
          TOKENBOARD_STATE_DIR: runtime.stateDir,
          TOKENBOARD_NOTIFY_TRAILING_DELAY_MS: String(delayMs),
          TOKENBOARD_NOTIFY_TRAILING_LOCK_PATH: lockPath
        }
      }
    )
    if (typeof child.pid === 'number') {
      runtime.writeFile(lockPath, JSON.stringify({ pid: child.pid, startedAt: new Date(runtime.now()).toISOString() }))
    }
    child.unref?.()
    return true
  } catch (error) {
    try {
      releaseTrailingLock(lockPath, runtime)
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; trailing lock cleanup failed: ${errorMessage(cleanupError)}`)
    }
    throw error
  }
}

function readSource(value) {
  if (value === 'codex' || value === 'claude-code') {
    return value
  }
  throw new Error('Usage: notify.mjs --source codex|claude-code')
}

async function runCli() {
  const trailingLockPath = process.env.TOKENBOARD_NOTIFY_TRAILING_LOCK_PATH || ''
  try {
    const config = readConfig()
    const configuredDir = configDir()
    await waitTrailingDelay()
    runNotify({
      configDir: configuredDir,
      stateDir: process.env.TOKENBOARD_STATE_DIR || configuredDir,
      version: config.updatedAt || config.createdAt || 'unknown'
    })
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  } finally {
    releaseTrailingLock(trailingLockPath, trailingRuntime({}))
  }
}

async function waitTrailingDelay() {
  const delayMs = Number.parseInt(process.env.TOKENBOARD_NOTIFY_TRAILING_DELAY_MS || '', 10)
  if (!Number.isFinite(delayMs) || delayMs <= 0) return
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

function hasTrailingDelay() {
  const delayMs = Number.parseInt(process.env.TOKENBOARD_NOTIFY_TRAILING_DELAY_MS || '', 10)
  return Number.isFinite(delayMs) && delayMs > 0
}

function formatSyncFailure(result) {
  const exitCode = result.status ?? 1
  const stderr = normalizeChildOutput(result.stderr)
  if (!stderr) {
    return `TokenBoard hook sync failed with exit code ${exitCode}`
  }
  return `TokenBoard hook sync failed with exit code ${exitCode}: ${stderr}`
}

function normalizeChildOutput(value) {
  const text = Array.isArray(value) ? value.join('') : String(value || '')
  return text.trim().replace(/\s+/g, ' ')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function trailingRuntime(options = {}) {
  const stateDir = options.stateDir || process.env.TOKENBOARD_STATE_DIR || configDir()
  return {
    configDir: options.configDir || process.env.TOKENBOARD_CONFIG_DIR || stateDir,
    stateDir,
    now: options.now || Date.now,
    process: options.process || process,
    mkdir: options.mkdir || mkdirSync,
    readFile: options.readFile || ((path) => readFileSync(path, 'utf8')),
    writeFile: options.writeFile || writeFileSync,
    readdir: options.readdir || readdirSync,
    unlink: options.unlink || unlinkSync
  }
}

function acquireTrailingLock(lockPath, runtime) {
  for (let attempt = 0; attempt < maxTrailingLockAcquireAttempts; attempt += 1) {
    try {
      runtime.writeFile(lockPath, JSON.stringify({ pid: runtime.process.pid, startedAt: new Date(runtime.now()).toISOString() }), { flag: 'wx' })
      return { acquired: true }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (readTrailingLockPid(lockPath, runtime) === runtime.process.pid) {
        if (!releaseTrailingLock(lockPath, runtime, { force: true })) {
          throw new Error('TokenBoard trailing lock could not be released')
        }
        continue
      }
      if (!isTrailingLockStale(lockPath, runtime)) return { acquired: false }
      if (!releaseTrailingLock(lockPath, runtime, { force: true })) {
        throw new Error('TokenBoard stale trailing lock could not be released')
      }
    }
  }

  throw new Error('TokenBoard trailing lock could not be acquired after replacing stale lock')
}

function releaseTrailingLock(lockPath, runtime, options = {}) {
  if (!lockPath) return false
  try {
    if (options.force || readTrailingLockPid(lockPath, runtime) === runtime.process.pid) {
      runtime.unlink(lockPath)
      return true
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return false
}

function isTrailingLockStale(lockPath, runtime) {
  const pid = readTrailingLockPid(lockPath, runtime)
  if (pid === null) return true
  if (pid === runtime.process.pid) return false
  try {
    runtime.process.kill(pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function readTrailingLockPid(lockPath, runtime) {
  try {
    const parsed = JSON.parse(runtime.readFile(lockPath))
    return typeof parsed.pid === 'number' ? parsed.pid : null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli()
}
