import { spawn as spawnProcess } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { win32 as windowsPath } from 'node:path'

const commandTimeoutMs = 3_000
const forceKillGraceMs = 250
const commandMaxBuffer = 8192
const maxCommandLength = 8192

export function startOriginalStatuslineCommand({ originalCommandFile, selfPath }) {
  const command = readOriginalCommand(originalCommandFile, selfPath)
  if (!command) return null
  const child = spawnProcess(command, {
    shell: true,
    detached: process.platform !== 'win32',
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const state = createCommandState()
  monitorCommandStreams(child, state)
  return {
    completion: waitForCommand(child, state),
    writeInput: (chunk) => writeCommandInput(child, state, chunk),
    finishInput: () => finishCommandInput(child, state)
  }
}

function createCommandState() {
  return {
    stdout: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    processError: undefined,
    inputError: undefined,
    timedOut: false,
    terminating: false,
    settled: false,
    timeout: undefined,
    forceKillTimeout: undefined,
    settle: undefined
  }
}

function monitorCommandStreams(child, state) {
  child.stdin.on('error', (error) => {
    state.inputError ??= error
  })
  child.stdout.on('data', (chunk) => {
    state.stdoutBytes += chunk.length
    if (state.stdoutBytes > commandMaxBuffer) {
      abortCommand(child, state, new Error('Antigravity original statusline command output exceeded the limit'))
      return
    }
    state.stdout.push(Buffer.from(chunk))
  })
  child.stderr.on('data', (chunk) => {
    state.stderrBytes += chunk.length
    if (state.stderrBytes > commandMaxBuffer) {
      abortCommand(child, state, new Error('Antigravity original statusline command error output exceeded the limit'))
    }
  })
}

function waitForCommand(child, state) {
  return new Promise((resolveCompletion) => {
    const settle = (result) => {
      if (state.settled) return
      state.settled = true
      if (state.timeout) clearTimeout(state.timeout)
      if (state.forceKillTimeout && !state.terminating) clearTimeout(state.forceKillTimeout)
      resolveCompletion(result)
    }
    state.settle = settle
    child.once('error', (error) => settle({ output: '', error }))
    child.once('close', (status) => {
      const error = commandCompletionError(status, state)
      settle({
        output: canForwardCommandOutput(status, state) ? Buffer.concat(state.stdout).toString('utf8') : '',
        error
      })
    })
  })
}

function canForwardCommandOutput(status, state) {
  return status === 0 && !state.processError && !state.timedOut
}

function commandCompletionError(status, state) {
  if (state.processError) return state.processError
  if (state.inputError) return state.inputError
  if (state.timedOut) return new Error('Antigravity original statusline command timed out')
  return status === 0 ? undefined : new Error(`Antigravity original statusline command exited with ${status}`)
}

function writeCommandInput(child, state, chunk) {
  if (state.settled || child.stdin.destroyed || !child.stdin.writable) {
    return Promise.reject(state.inputError ?? new Error('Antigravity original statusline command closed stdin'))
  }
  return new Promise((resolveWrite, rejectWrite) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      const error = new Error('Antigravity original statusline command input timed out')
      abortCommand(child, state, error)
      rejectWrite(error)
    }, commandTimeoutMs)
    child.stdin.write(chunk, (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) rejectWrite(error)
      else resolveWrite()
    })
  })
}

function finishCommandInput(child, state) {
  if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end()
  if (state.settled) return
  state.timeout = setTimeout(() => {
    state.timedOut = true
    abortCommand(child, state, new Error('Antigravity original statusline command timed out'))
  }, commandTimeoutMs)
}

function abortCommand(child, state, error) {
  state.processError ??= error
  if (state.settled || state.terminating) return
  state.terminating = true
  terminateOriginalCommandTree(child, 'SIGTERM')
  state.forceKillTimeout = setTimeout(() => {
    terminateOriginalCommandTree(child, 'SIGKILL')
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    state.settle?.({ output: '', error: state.processError })
  }, forceKillGraceMs)
}

export function terminateOriginalCommandTree(child, signal, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    terminateWindowsCommandTree(
      child,
      signal,
      options.spawnTreeKiller ?? spawnProcess,
      options.taskkillCommand ?? windowsTaskkillCommand(options.env)
    )
    return
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  try {
    child.kill(signal)
  } catch {}
}

function terminateWindowsCommandTree(child, signal, spawnTreeKiller, taskkillCommand) {
  if (!child.pid) {
    try {
      child.kill(signal)
    } catch {}
    return
  }
  try {
    const args = ['/PID', String(child.pid), '/T']
    if (signal === 'SIGKILL') args.push('/F')
    const treeKiller = spawnTreeKiller(taskkillCommand, args, {
      stdio: 'ignore',
      windowsHide: true
    })
    let fellBack = false
    const fallback = () => {
      if (fellBack) return
      fellBack = true
      try {
        child.kill(signal)
      } catch {}
    }
    treeKiller.once('error', fallback)
    treeKiller.once('close', (status) => {
      if (status !== 0) fallback()
    })
    treeKiller.unref()
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

export function windowsTaskkillCommand(env = process.env) {
  const systemRoot = typeof env?.SystemRoot === 'string' ? env.SystemRoot.trim() : ''
  const root = isDriveRootedWindowsPath(systemRoot) ? systemRoot : 'C:\\Windows'
  return windowsPath.join(root, 'System32', 'taskkill.exe')
}

function isDriveRootedWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value)
}

function readOriginalCommand(filePath, selfPath) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw new Error('Invalid Antigravity original statusline command backup', { cause: error })
  }
  if (parsed?.statusLine && typeof parsed.statusLine === 'object' && parsed.statusLine.enabled === false) {
    return ''
  }
  const command = readCommandString(parsed?.statusLine?.command ?? parsed?.command)
  if (!command) return ''
  return isSelfCommand(command, selfPath) ? '' : command
}

function readCommandString(value) {
  if (typeof value !== 'string') return ''
  const command = value.trim()
  if (command.length > maxCommandLength) {
    throw new Error('Invalid Antigravity original statusline command backup: command is too long')
  }
  return command
}

function isSelfCommand(command, selfPath) {
  if (command.includes(selfPath)) return true
  const resolvedSelf = safeRealpath(selfPath)
  if (resolvedSelf && command.includes(resolvedSelf)) return true
  return command.includes('antigravity-statusline.mjs')
}

function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return ''
  }
}
