#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { isMainModule } from './is-main.mjs'
import { readConfig, parseArgs, collectorDir, readPackageManager, resolveClientForSource } from './config.mjs'
import { clientBinaryPath } from './client-binary.mjs'
import { printHelpIfRequested, hasHelpFlag } from './cli-help.mjs'
import { normalizePathEnv } from './schedule.mjs'
import { readSince } from './sync-options.mjs'
import { closeScheduledLogRuntime, createScheduledLogRuntime } from './logs.mjs'
import { runUpgrade } from './upgrade.mjs'
import { runSelfUpdate } from './client-binary.mjs'
import { errorMessage } from './error-message.mjs'
import { assertSupportedNodeVersion } from './node-version.mjs'
import { acquireLock, lockHasToken, releaseLock, waitForLock } from './coordinator-lock.mjs'
import { runScheduledRetry, transientSyncExitCode } from './scheduled-retry.mjs'
import { currentProcessStartIdentity } from './process-liveness.mjs'
import { writeScheduledSyncState } from './scheduled-sync-state.mjs'
import { redactUrlCredentials } from './redact-credentials.mjs'

const defaultSyncLockTimeoutMs = 60_000

// Hook-mode runs get a wall-clock bound so a wedged scan cannot hold the sync lock or the
// notify caller indefinitely. The default leaves generous room above the observed long tail
// (a full Codex history scan measured at ~25 minutes on a 38 GB session tree); a shorter
// value trades a lost hook cycle for faster failure visibility. Manual and scheduled runs
// are never bounded.
const defaultHookSyncTimeoutMs = 30 * 60 * 1000
// setTimeout stores its delay in a signed 32-bit integer and silently clamps anything
// larger to 1ms (with a TimeoutOverflowWarning). A configured bound past this ceiling would
// therefore kill every hook run immediately instead of never — the opposite of what the
// operator asked for. `coordinator.mjs` documents the same clamp for its continuation delay.
const maxHookSyncTimeoutMs = 2_147_483_647

export function readHookSyncTimeoutMs(env = process.env) {
  const configured = env.TOKENBOARD_HOOK_SYNC_TIMEOUT_MS
  if (configured === undefined || configured === '') return defaultHookSyncTimeoutMs
  if (!/^[1-9][0-9]*$/.test(configured)) {
    throw new Error('TOKENBOARD_HOOK_SYNC_TIMEOUT_MS must be a positive integer number of milliseconds')
  }
  const timeoutMs = Number(configured)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > maxHookSyncTimeoutMs) {
    throw new Error(
      `TOKENBOARD_HOOK_SYNC_TIMEOUT_MS must be at most ${maxHookSyncTimeoutMs}; larger values are clamped by setTimeout to 1ms and would kill every hook run`
    )
  }
  return timeoutMs
}

if (isMain()) {
  // Checked before `runCli` reads the config: a scheduled or hook run on an
  // unsupported Node must fail loudly instead of half-executing a sync. `--help`
  // stays a pure read on any runtime, which is what the CLI contract tests assert.
  if (!hasHelpFlag(process.argv.slice(2))) {
    try {
      assertSupportedNodeVersion(process.versions.node)
    } catch (error) {
      console.error(redactUrlCredentials(errorMessage(error)))
      process.exit(1)
    }
  }
  runCli()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`TokenBoard sync failed: ${redactUrlCredentials(errorMessage(error))}`)
      process.exit(1)
    })
}

async function runCli() {
  if (
    printHelpIfRequested(
      process.argv.slice(2),
      'Usage: sync.mjs [--mode preview|sync] [--source SOURCE] [--until YYYY-MM-DD] [--scheduled] [--hook] [--skip-upgrade]'
    )
  ) {
    return 0
  }
  let logs
  try {
    const flags = parseArgs(process.argv.slice(2))
    const config = readConfig()
    const homeDir = homedir()
    const invocation = buildSyncInvocation({
      flags,
      config,
      pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      homeDir,
      nodePath: process.execPath,
      platform: process.platform
    })
    try {
      logs = createScheduledLogRuntime({
        env: process.env,
        homeDir,
        scheduled: flags.scheduled === true
      })
    } catch (logError) {
      // A broken log directory (permissions, disk full) must not cancel the sync itself:
      // the collected usage matters more than the log file. Fall back to the terminal
      // mode and keep going; the failure is still visible on stderr.
      logs = null
      console.error(
        `TokenBoard could not open its scheduled logs, continuing without them: ${redactUrlCredentials(errorMessage(logError))}`
      )
    }

    return await runSyncInvocation({
      flags,
      invocation,
      logs,
      stateDir: configDirFromInvocation(invocation, homeDir)
    })
  } catch (error) {
    console.error(`TokenBoard sync failed: ${redactUrlCredentials(errorMessage(error))}`)
    return 1
  } finally {
    closeScheduledLogRuntime(logs)
  }
}

export async function runSyncInvocation({
  flags = {},
  invocation,
  logs,
  stateDir,
  runWithLock = runWithSyncLock,
  runRetry = runScheduledRetry,
  writeState = writeScheduledSyncState,
  onStateError = (message) => console.error(message),
  now = Date.now
}) {
  const scheduled = flags.scheduled === true
  const source = invocation?.source || flags.source || 'all'
  const startedAt = new Date(now()).toISOString()
  const recordState = (status, details = {}) => {
    if (!scheduled) return
    try {
      writeState({
        stateDir,
        source,
        status,
        startedAt,
        updatedAt: now(),
        ...(status === 'running' ? {} : { completedAt: now() }),
        ...(Number.isSafeInteger(details.exitCode) ? { exitCode: recordableExitCode(details.exitCode) } : {}),
        ...(details.error ? { error: errorMessage(details.error) } : {})
      })
    } catch (error) {
      try {
        onStateError(`TokenBoard scheduled sync state update failed: ${errorMessage(error)}`)
      } catch {
        // State reporting must never alter the sync result or mask its primary error.
      }
    }
  }
  const run = async (runFlags = flags) =>
    runWithLock({
      flags: runFlags,
      stateDir,
      run: () => runSync({ flags: runFlags, invocation, logs })
    })

  let deferredBy
  try {
    recordState('running')
    const result = await run()
    const exitCode = typeof result === 'number' ? result : 0
    if (exitCode === transientSyncExitCode) {
      if (!canDeferScheduledRun(flags)) {
        // Nothing retries an unscheduled run, so report a plain failure instead
        // of surfacing an internal deferral code the caller cannot act on.
        recordState('failed', { exitCode: 1 })
        return 1
      }
      deferredBy = new Error(`collector exited with transient code ${exitCode}`)
    } else {
      recordState(exitCode === 0 ? 'success' : 'failed', { exitCode })
      return result
    }
  } catch (error) {
    if (!shouldDeferScheduledSync(flags, error)) {
      recordState('failed', { exitCode: 1, error })
      throw error
    }
    deferredBy = error
  }

  // No exitCode here. `transientSyncExitCode` is an internal contract between the
  // collector and the retry loop; the state file is user-visible through
  // `status.mjs`, and the non-scheduled branch above already normalizes the same code
  // to 1 precisely so it is not surfaced. A `deferred` row means "retrying", which the
  // status field already says, so recording the number would only leak an internal
  // code the reader cannot act on.
  recordState('deferred', { error: deferredBy })
  const retryFlags = { ...flags, 'skip-upgrade': true }
  let result
  try {
    result = await runRetry({
      stateDir,
      source,
      runAttempt: () => run(retryFlags)
    })
  } catch (retryError) {
    recordState('failed', { exitCode: 1, error: retryError })
    throw retryError
  }
  if (result.skipped) {
    console.error('TokenBoard scheduled sync deferred because another scheduled retry is active.')
  } else if (result.exhausted) {
    console.error(`TokenBoard scheduled sync retry exhausted after ${result.attempts} attempts.`)
  }
  const exitCode = Number.isSafeInteger(result.exitCode) ? result.exitCode : 1
  // `skipped` means another scheduled retry already holds the lock: this run handed the
  // work off, which is the `deferred` state, not a failure. The old order tested
  // `exitCode !== 0` first, and a skip reports no exit code at all, so the fallback 1
  // made every handoff look like a failure — contradicting both the message printed just
  // above and the `deferred` row the retry loop itself had written. A skip has no exit
  // code to report, so none is recorded.
  const skipped = result.skipped === true
  const status = skipped ? 'deferred' : result.exhausted || exitCode !== 0 ? 'failed' : 'success'
  recordState(status, {
    ...(skipped ? {} : { exitCode }),
    ...(result.error ? { error: result.error } : {})
  })
  return exitCode
}

// runPreCollectUpgrade is the upgrade step that runs before collection.
//
// A binary client owns its own upgrade: it calls its `self-update`, which
// verifies the download against the release's checksums and swaps the binary
// only after the new one has answered `version`. That is what decouples the
// upgrade from the git worktree — the checkout no longer has to be clean, or
// even present, for the client to move forward.
//
// A git client keeps the checkout upgrade, unchanged. Hook syncs never
// upgrade at all: they only enqueue and reconcile usage, and a hook must not
// make a network request it cannot afford.
//
// A failure on either path is a warning, never a sync failure: an offline
// machine is a normal state, and the collector keeps working on the version it
// has.
export function runPreCollectUpgrade({
  flags = {},
  invocation,
  logs,
  env = process.env,
  upgrade = runUpgrade,
  selfUpdate = runSelfUpdate,
  log = createUpgradeLogger(logs),
  warn = (message) => console.error(message)
} = {}) {
  if (invocation?.clientType === 'binary') {
    // The switches that hold the git client on its current version must hold
    // the binary too: an automatic self-update rewrites the executable itself,
    // which is harder to undo than a checkout `git checkout` can revert.
    // `shouldRunUpgrade` also covers `--hook`, so a hook still never upgrades.
    //
    // A missing binary must still reach `selfUpdate`: that is where
    // `recoverOrphanedBinary` restores a swap interrupted between its two
    // renames. Skipping the call because the target is missing is exactly the
    // case the recovery exists for — without it the machine reports "client is
    // not installed" on every run with no automatic way back. When there is
    // nothing to recover, `runSelfUpdate` throws and the failure stays a
    // warning, as with any other failed update.
    if (!shouldRunUpgrade({ flags, env })) {
      return
    }
    try {
      // The invocation's env carries the release feed this client was
      // installed from; spawning with the ambient process env instead would
      // let a scheduled update reach a different feed than the install used.
      selfUpdate({
        binaryPath: invocation.command,
        scheduled: flags.scheduled === true,
        env: invocation.env || env,
        log
      })
    } catch (error) {
      warn(`TokenBoard self-update skipped: ${redactUrlCredentials(errorMessage(error))}`)
    }
    return
  }

  if (!shouldRunUpgrade({ flags, env })) {
    return
  }
  try {
    upgrade({ flags, automatic: true, log })
  } catch (error) {
    warn(`TokenBoard upgrade skipped: ${redactUrlCredentials(errorMessage(error))}`)
  }
}

async function runSync({ flags, invocation, logs }) {
  runPreCollectUpgrade({ flags, invocation, logs })

  const effectiveInvocation = refreshBundledCcusageConfig(invocation)

  // A binary install has no checkout to read: it materializes the bundled
  // pricing baseline itself, so the collector directory is not required.
  if (!existsSync(effectiveInvocation.repoDir) && effectiveInvocation.clientType !== 'binary') {
    console.error(`TokenBoard collector is not installed: ${effectiveInvocation.repoDir}`)
    console.error('Run setup.mjs again or run install-collector.mjs.')
    return 1
  }
  if (effectiveInvocation.clientType === 'binary' && !existsSync(effectiveInvocation.command)) {
    console.error(`TokenBoard client is not installed: ${effectiveInvocation.command}`)
    console.error('Run setup.mjs again or run upgrade.mjs --to-binary.')
    return 1
  }

  const hookTimeoutMs = flags.hook === true ? readHookSyncTimeoutMs() : undefined
  const result = await runCollectorProcess(effectiveInvocation, logs, { hookTimeoutMs })

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      console.error(`TokenBoard hook sync timed out after ${hookTimeoutMs} ms; the collector process was killed`)
    } else {
      console.error(`Failed to run ${effectiveInvocation.command}: ${errorMessage(result.error)}`)
    }
    return 1
  }

  return result.status ?? 1
}

// The collector's own stdout/stderr must reach the scheduled log through the same credential
// redaction the parent's log lines go through. Inheriting the log fds (`stdio: [...fd]`) writes
// the child's output straight into a file that outlives the terminal — a provider or `ccusage`
// error echoing `tb_upload_…` or `https://user:token@host/…` would land there intact. Capture
// instead and forward each line through `redactUrlCredentials`, the way `upgrade-utils` already
// does for the git steps. The child still inherits the real terminal when there is no log file,
// so interactive runs keep their live output.
//
// Output streams line by line instead of accumulating in a 64 MiB buffer: a run killed
// mid-flight keeps everything it already printed, memory stays flat regardless of run length,
// and per-line redaction is equivalent because every redact rule is single-line anchored.
// A hook run's child is the collector, which spawns ccusage (or a language server) of its
// own. Killing only the direct child leaves those grandchildren running: the collector is
// gone, but the scan that blew the budget keeps burning CPU and memory with nothing left to
// stop it. Spawning detached makes the child a process-group leader on POSIX, so the kill
// can take the whole tree.
//
// `detached` is only set when a bound will actually be enforced. A manual run has no bound,
// and detaching it would take the child out of the terminal's foreground process group —
// Ctrl-C would then stop sync.mjs but leave the collector running.
//
// Windows has no process groups in that sense, and `detached` there means a new console
// rather than a new group, so the direct-child kill stays the best available answer.
function spawnOptionsFor(invocation, stdio, bounded) {
  return {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio,
    shell: invocation.shell,
    detached: Boolean(bounded) && process.platform !== 'win32'
  }
}

function killProcessTree(child, signal = 'SIGKILL') {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The group is already gone (ESRCH) or the child never became a leader; fall through
      // to the direct kill rather than reporting a timeout we did not actually enforce.
    }
  }
  try {
    child.kill(signal)
  } catch {}
}

export async function runCollectorProcess(invocation, logs, options = {}) {
  const spawnChild = options.spawn || spawn
  const write = options.write || writeSync
  if (!logs) {
    // Interactive mode keeps the child on the real terminal, but the process must still be
    // awaited: spawn returns a ChildProcess, not a result, and the caller reads `status`.
    //
    // The hook timeout applies here too. A hook run is exactly this branch — notify spawns
    // sync.mjs with `--hook` and no scheduled-log environment — so bounding only the logged
    // branch left the production hook path unbounded, and a wedged scan there holds the
    // coordinator's sync lock with nothing to kill it.
    const child = spawnChild(
      invocation.command,
      invocation.args,
      spawnOptionsFor(invocation, 'inherit', Boolean(options.hookTimeoutMs))
    )
    let timedOut = false
    let timer
    if (options.hookTimeoutMs) {
      timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
      }, options.hookTimeoutMs)
    }
    const outcome = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    clearTimeout(timer)
    if (outcome.error) return { status: 1, error: outcome.error }
    if (timedOut) {
      return {
        status: 1,
        error: Object.assign(new Error(`collector run exceeded the ${options.hookTimeoutMs} ms hook timeout`), {
          code: 'ETIMEDOUT'
        })
      }
    }
    return { status: outcome.code ?? (outcome.signal ? 1 : 0), error: null }
  }

  const child = spawnChild(
    invocation.command,
    invocation.args,
    spawnOptionsFor(invocation, ['ignore', 'pipe', 'pipe'], Boolean(options.hookTimeoutMs))
  )
  const stdoutPipe = pipeRedacted(child.stdout, logs.stdoutFd, write)
  const stderrPipe = pipeRedacted(child.stderr, logs.stderrFd, write)
  let timedOut = false
  let timer
  if (options.hookTimeoutMs) {
    // Only hook-mode callers pass a bound; manual and scheduled runs are never killed.
    timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, options.hookTimeoutMs)
  }

  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)
  await drainPipes([stdoutPipe, stderrPipe], options.streamDrainTimeoutMs)

  if (outcome.error) return { status: 1, error: outcome.error, stdout: '', stderr: '' }
  if (timedOut) {
    return {
      status: 1,
      error: Object.assign(new Error(`collector run exceeded the ${options.hookTimeoutMs} ms hook timeout`), {
        code: 'ETIMEDOUT'
      }),
      stdout: '',
      stderr: ''
    }
  }
  return { status: outcome.code ?? (outcome.signal ? 1 : 0), stdout: '', stderr: '' }
}

function pipeRedacted(stream, fd, write) {
  const pipe = new Promise((resolve) => {
    if (!stream) {
      resolve()
      return
    }
    stream.setEncoding('utf8')
    createInterface({ input: stream }).on('line', (line) => writeRedactedOutput(fd, line, write))
    stream.once('end', resolve)
    stream.once('error', resolve)
  })
  pipe.stream = stream
  return pipe
}

// After the child exits, the stdio pipes stay open as long as any orphaned grandchild
// (ccusage, tsx) that inherited them is still running: the 'end' events never fire and the
// run would hang forever on a process that is already gone. The logs already hold everything
// the child printed, so once the drain grace elapses the parent destroys whichever pipes have
// not settled; their 'error'/'end' handlers in pipeRedacted then resolve the promises. A
// destroy call on its own proves nothing (readline also destroys the stream on natural
// 'end'), which is why the guard watches the pipe promises, not the stream events.
function drainPipes(pipes, streamDrainTimeoutMs) {
  const graceMs = streamDrainTimeoutMs ?? 5_000
  return new Promise((resolve) => {
    let done = false
    const settle = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      for (const pipe of pipes) pipe.stream?.destroy?.()
      settle()
    }, graceMs)
    Promise.all(pipes).then(settle, settle)
  })
}

export function writeRedactedOutput(fd, text, write = writeSync) {
  const output = String(text ?? '')
  if (!output) return
  // A diagnostic sink must never change the sync result, so a failed write is swallowed.
  try {
    write(fd, redactUrlCredentials(output.endsWith('\n') ? output.slice(0, -1) : output) + '\n')
  } catch {
    // ignore
  }
}

export function createUpgradeLogger(logs, { write = writeSync, log = console.log } = {}) {
  return (line) => {
    const message = redactUrlCredentials(String(line))
    if (!logs) {
      log(message)
      return
    }
    try {
      write(logs.stdoutFd, `${message}\n`)
    } catch {
      // A diagnostic sink must never change the upgrade or sync result.
    }
  }
}

// The scheduled log is private (0700 directory, 0600 files), but an upgrade line can embed the
// configured repository URL — `https://user:token@host/…` — and the log outlives the terminal
// it used to print to. Redaction lives in its own module (`redact-credentials.mjs`) so this log
// path and the upgrade helpers that spawn the git steps scrub the same credentials the same way.

export function refreshBundledCcusageConfig(invocation, fileExists = existsSync) {
  if (invocation.env?.TOKENBOARD_CCUSAGE_CONFIG?.trim()) return invocation
  // A binary install materializes its own pricing baseline from the copy
  // compiled into it. A checkout may still be on disk — `upgrade.mjs
  // --to-binary` deliberately keeps it as the rollback — and its
  // `ccusage.json` is frozen at whatever revision it was last pulled to. The
  // Go side ranks an explicit config above its bundled one, so pointing it at
  // that stale file would price new usage with the old table and never say so.
  if (invocation.clientType === 'binary') return invocation

  const bundledCcusageConfig = join(invocation.repoDir, 'packages', 'collector', 'ccusage.json')
  if (!fileExists(bundledCcusageConfig)) return invocation

  return {
    ...invocation,
    env: {
      ...invocation.env,
      TOKENBOARD_CCUSAGE_CONFIG: bundledCcusageConfig
    }
  }
}

export function shouldRunUpgrade({ flags = {}, env = process.env } = {}) {
  if (flags.hook === true) {
    return false
  }
  if (flags['skip-upgrade'] === true) {
    return false
  }
  if (env.TOKENBOARD_SKIP_UPGRADE === '1') {
    return false
  }
  if (env.TOKENBOARD_AUTO_UPGRADE === '0') {
    return false
  }
  return true
}

export function buildSyncInvocation({
  flags = {},
  config,
  env = process.env,
  pathEnv = env.PATH || '/usr/local/bin:/usr/bin:/bin',
  homeDir = homedir(),
  nodePath = process.execPath,
  platform = process.platform,
  fileExists = existsSync
}) {
  const mode = flags.mode || 'sync'
  const source = flags.source || config.source || 'all'
  const repoDir = config.collectorDir || collectorDir()
  const clientType = resolveClientForSource({ flags, env, config, source })
  const packageManager = readPackageManager(flags, config)
  const since = readSince({ flags, config, env })
  const delimiter = platform === 'win32' ? ';' : ':'
  const {
    TOKENBOARD_COORDINATOR_LOCK_HELD: _coordinatorLockHeld,
    TOKENBOARD_COORDINATOR_LOCK_TOKEN: _coordinatorLockToken,
    ...collectorEnv
  } = env
  const onlyWhenUnset = (key, value) => {
    if (value === undefined) return {}
    if (Object.prototype.hasOwnProperty.call(collectorEnv, key)) return {}
    return { [key]: value }
  }
  const until = normalizeUntilFlag(flags.until)
  const codexSymlinkRoots =
    Array.isArray(config.codexSymlinkRoots) && config.codexSymlinkRoots.length > 0
      ? onlyWhenUnset('TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON', JSON.stringify(config.codexSymlinkRoots))
      : {}
  const untilArgs = until === undefined ? [] : ['--until', until]
  // Shared by both clients: the endpoint contract is identical, so a switch
  // between them cannot change what gets collected or where it is uploaded.
  const sharedEnv = {
    ...collectorEnv,
    PATH: normalizePathEnv({
      pathEnv,
      homeDir,
      nodePath,
      delimiter
    }),
    TOKENBOARD_ENDPOINT: config.endpoint,
    TOKENBOARD_UPLOAD_TOKEN: config.uploadToken,
    TOKENBOARD_TIMEZONE: config.timezone,
    TOKENBOARD_SOURCE: source,
    TOKENBOARD_PACKAGE_MANAGER: packageManager,
    ...codexSymlinkRoots,
    ...(until !== undefined ? { TOKENBOARD_UNTIL: until } : {}),
    TOKENBOARD_SINCE: since,
    TOKENBOARD_DEFAULT_SINCE: since,
    // The feed this client was installed from, recorded at install time. The
    // Go client's `self-update` reads both variables, so carrying them through
    // the shared env keeps an automatic update pointed at that feed instead of
    // the compiled-in default repository.
    ...(config.releaseRepo ? onlyWhenUnset('TOKENBOARD_RELEASE_REPO', config.releaseRepo) : {}),
    ...(config.releaseBaseUrl ? onlyWhenUnset('TOKENBOARD_RELEASE_BASE_URL', config.releaseBaseUrl) : {}),
    ...(flags.scheduled === true ? onlyWhenUnset('TOKENBOARD_FAIL_ON_SOURCE_ERROR', '1') : {}),
    ...(flags.hook === true
      ? {
          TOKENBOARD_HOOK_MODE: '1',
          TOKENBOARD_STATE_DIR: env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR || join(homeDir, '.tokenboard')
        }
      : {})
  }

  // A binary install runs the Go client directly: the same subcommand
  // (`preview`/`sync`/`warm-hooks`), the same TOKENBOARD_* contract and the
  // same state directory, but no node, no tsx and no git checkout. The
  // ccusage config is the one thing it does not need: the Go client
  // materializes the bundled baseline itself.
  if (clientType === 'binary') {
    const binary = clientBinaryPath({
      configDir: env.TOKENBOARD_CONFIG_DIR || join(homeDir, '.tokenboard'),
      platform
    })
    return {
      command: binary,
      args: [mode, '--source', source, ...untilArgs],
      source,
      // A binary install has no checkout: the working directory is the
      // binary's own directory, which exists as soon as it is installed.
      // Pointing it at the (absent) collector directory makes spawn fail with
      // ENOENT on the command itself, which reads as "client not installed".
      cwd: dirname(binary),
      repoDir,
      clientType,
      shell: false,
      env: sharedEnv
    }
  }

  const bundledCcusageConfig = join(repoDir, 'packages', 'collector', 'ccusage.json')
  const ccusageConfig = collectorEnv.TOKENBOARD_CCUSAGE_CONFIG?.trim()
    ? undefined
    : fileExists(bundledCcusageConfig)
      ? bundledCcusageConfig
      : undefined
  return {
    command: nodePath,
    args: ['--import', 'tsx', 'src/cli.ts', mode, '--source', source, ...untilArgs],
    source,
    cwd: join(repoDir, 'packages', 'collector'),
    repoDir,
    clientType,
    shell: false,
    env: {
      ...sharedEnv,
      ...(ccusageConfig ? { TOKENBOARD_CCUSAGE_CONFIG: ccusageConfig } : {})
    }
  }
}

function normalizeUntilFlag(value) {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') throw new Error('--until requires a date value')
  const normalized = String(value).trim()
  if (!normalized) throw new Error('--until requires a date value')
  return normalized
}

export async function runWithSyncLock({ flags = {}, env = process.env, stateDir, runtime = syncLockRuntime(), run }) {
  if (typeof run !== 'function') {
    throw new Error('runWithSyncLock requires run')
  }
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    throw new Error('runWithSyncLock requires stateDir')
  }
  ensurePrivateStateDir(runtime, stateDir)
  const lockPath = join(stateDir, 'sync.lock')
  if (isCoordinatorLockHeld({ flags, env, lockPath, runtime })) {
    return run()
  }

  let owner = acquireLock(lockPath, runtime)
  if (!owner) {
    const wait = waitForLock(lockPath, runtime)
    if (!wait.acquired) {
      throw syncLockTimeoutError(lockPath)
    }
    owner = wait.owner
  }
  let result
  let primaryError
  let primaryFailed = false
  try {
    result = await run()
  } catch (error) {
    primaryFailed = true
    primaryError = error
  }

  let releaseError
  try {
    const released = releaseLock(lockPath, runtime, owner)
    if (!released && lockHasToken(lockPath, owner.token, runtime)) {
      releaseError = new Error(`TokenBoard sync lock release was not confirmed: ${lockPath}`)
    }
  } catch (error) {
    releaseError = new Error(`TokenBoard sync lock release failed: ${errorMessage(error)}`, { cause: error })
  }

  if (primaryFailed && releaseError) {
    const combined = new AggregateError(
      [primaryError, releaseError],
      `${errorMessage(primaryError)}; ${errorMessage(releaseError)}`
    )
    if (primaryError && typeof primaryError === 'object' && 'code' in primaryError) {
      combined.code = primaryError.code
    }
    throw combined
  }
  if (primaryFailed) throw primaryError
  if (releaseError) throw releaseError
  return result
}

export { transientSyncExitCode }

function canDeferScheduledRun(flags) {
  return flags.scheduled === true && flags.hook !== true && (flags.mode || 'sync') === 'sync'
}

function shouldDeferScheduledSync(flags, error) {
  return canDeferScheduledRun(flags) && error?.code === 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
}

function syncLockTimeoutError(lockPath) {
  const error = new Error(`Timed out waiting for TokenBoard sync lock: ${lockPath}`)
  error.code = 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
  return error
}

function ensurePrivateStateDir(runtime, stateDir) {
  if (typeof runtime.mkdir !== 'function' || typeof runtime.chmod !== 'function') {
    throw new Error('TokenBoard sync state directory setup requires mkdir and chmod operations')
  }
  const inspect = typeof runtime.lstat === 'function' ? () => runtime.lstat(stateDir) : null
  const before = inspectDirectory(inspect)
  if (before?.isSymbolicLink?.()) {
    throw new Error(`TokenBoard sync state directory must not be a symbolic link: ${stateDir}`)
  }

  runtime.mkdir(stateDir, { recursive: true, mode: 0o700 })

  const after = inspectDirectory(inspect)
  if (after?.isSymbolicLink?.()) {
    throw new Error(`TokenBoard sync state directory must not be a symbolic link: ${stateDir}`)
  }
  if (after && typeof after.isDirectory === 'function' && !after.isDirectory()) {
    throw new Error(`TokenBoard sync state path is not a directory: ${stateDir}`)
  }
  runtime.chmod(stateDir, 0o700)
}

function inspectDirectory(inspect) {
  if (!inspect) return null
  try {
    return inspect()
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function isCoordinatorLockHeld({ flags, env, lockPath, runtime }) {
  return (
    flags.hook === true &&
    env.TOKENBOARD_COORDINATOR_LOCK_HELD === '1' &&
    lockHasToken(lockPath, env.TOKENBOARD_COORDINATOR_LOCK_TOKEN, runtime)
  )
}

function configDirFromInvocation(invocation, homeDir) {
  return invocation.env.TOKENBOARD_STATE_DIR || invocation.env.TOKENBOARD_CONFIG_DIR || join(homeDir, '.tokenboard')
}

function syncLockRuntime() {
  let processStartIdentity
  return {
    lockTimeoutMs: defaultSyncLockTimeoutMs,
    chmod: (path, mode) => chmodSync(path, mode),
    lstat: (path) => lstatSync(path),
    mkdir: (path, options) => mkdirSync(path, options),
    now: Date.now,
    process,
    getProcessStartIdentity: () => {
      if (processStartIdentity) return processStartIdentity
      processStartIdentity = currentProcessStartIdentity()
      return processStartIdentity
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    rename: renameSync,
    link: linkSync,
    sleep: sleepSync,
    unlink: unlinkSync,
    writeFile: writeFileSync
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}

function isMain() {
  return isMainModule(import.meta.url)
}

// A process exit code is 0-255, but the value reaching `recordState` is not always one:
// Windows reports the untruncated 32-bit status (`GetExitCodeProcess`), so an access
// violation arrives as 3221225477 rather than a byte. `scheduled-sync-state.mjs` rejects
// anything outside 0-255 by design, and that throw is swallowed by `recordState`'s catch —
// which left the file on disk still reading `running`, making the failure indistinguishable
// from a sync that never finished. Out-of-range codes are recorded as 1 (a generic failure)
// rather than dropped, since a dropped code reads as "no exit code recorded".
function recordableExitCode(exitCode) {
  return exitCode >= 0 && exitCode <= 255 ? exitCode : 1
}
