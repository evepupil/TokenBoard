#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { isMainModule } from './is-main.mjs'
import { configDir, readConfig } from './config.mjs'
import { printHelpIfRequested } from './cli-help.mjs'
import { errorMessage } from './error-message.mjs'
import { dailyScheduleTimes, launchAgentLabel, serviceName, timerName } from './schedule.mjs'

const usage = 'Usage: uninstall-schedule.mjs'

export function uninstallSchedule(options = {}) {
  const env = options.env || process.env
  const runtime = {
    platform: options.platform || env.TOKENBOARD_INSTALL_SCHEDULE_TEST_PLATFORM || platform(),
    homeDir: options.homeDir || homedir(),
    configDir: options.configDir || configDir(),
    env,
    spawn: options.spawn || spawnSync,
    getUid:
      options.getUid ||
      (() => Number.parseInt(env.TOKENBOARD_INSTALL_SCHEDULE_TEST_UID || process.getuid?.() || 0, 10)),
    exists: options.exists || existsSync,
    rm: options.rm || rmSync,
    log: options.log || console.log,
    error: options.error || console.error
  }
  const config = options.config || readOptionalConfig(options.readConfig || readConfig, runtime)
  const scheduleTimes = readScheduleTimes(config)

  if (runtime.platform === 'win32') {
    return uninstallWindows(runtime, scheduleTimes)
  }
  if (runtime.platform === 'darwin') {
    return uninstallMac(runtime)
  }
  if (runtime.platform === 'linux') {
    return uninstallLinux(runtime)
  }

  throw new Error(`Automatic schedule uninstall is not supported on ${runtime.platform}.`)
}

function uninstallWindows(runtime, scheduleTimes) {
  // `allowFailure` keeps a non-zero exit from aborting the uninstall, but it must not be
  // silent: `uninstall` reports the schedule as removed either way, so a swallowed failure
  // would leave the task registered with no trace. Report it explicitly instead.
  const result = run(runtime, 'powershell.exe', buildWindowsScheduleCleanupArgs(), { allowFailure: true })
  if (result.status !== 0) {
    runtime.error(
      `TokenBoard scheduled-task cleanup failed with exit code ${result.status ?? 1}; the task may still be registered.`
    )
  }
  runtime.log('TokenBoard scheduled tasks removed.')
  return { platform: 'win32', scheduleTimes }
}

export function buildWindowsScheduleCleanupArgs() {
  const command = `Get-ScheduledTask -TaskPath '\\' | Where-Object { ($_.TaskName -like 'TokenBoardDailySync*') -or ($_.Actions | Where-Object { $_.Execute -like '*node*' -and $_.Arguments -like '*TokenBoard*skills*tokenboard*scripts*sync.mjs*' }) } | Unregister-ScheduledTask -Confirm:$false`
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]
}

function uninstallMac(runtime) {
  const plistPath = join(runtime.homeDir, 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`)
  const userDomain = `gui/${runtime.getUid()}`
  const result = run(runtime, 'launchctl', ['bootout', userDomain, plistPath], { allowFailure: true })
  // `launchctl bootout` exits 3 ("No such process") when the job is not loaded — there is
  // nothing left to remove, so for an uninstall that is success, not a failure. A real
  // permission or corruption error exits with another code and is still reported.
  reportAllowedFailure(
    runtime,
    result,
    `launchctl bootout ${userDomain}`,
    'the LaunchAgent may still be running',
    (status) => status === 3
  )
  if (runtime.exists(plistPath)) {
    runtime.rm(plistPath, { force: true })
  }
  runtime.log('TokenBoard LaunchAgent removed.')
  return { platform: 'darwin', plistPath }
}

function uninstallLinux(runtime) {
  const unitDir = join(runtime.homeDir, '.config', 'systemd', 'user')
  const timerPath = join(unitDir, timerName)
  const servicePath = join(unitDir, serviceName)
  const disabled = run(runtime, 'systemctl', ['--user', 'disable', '--now', timerName], { allowFailure: true })
  // "There was nothing loaded to remove" is the only tolerated failure, and a
  // missing unit *file* does not prove it: the files can be deleted while
  // systemd still holds — and runs — the loaded unit, and a bus or permission
  // failure says nothing about the timer's state either. Probe the timer
  // itself; inactive (3) or unknown (4) means nothing is left running.
  reportAllowedFailure(
    runtime,
    disabled,
    `systemctl --user disable --now ${timerName}`,
    'the timer may still be enabled',
    (status) => {
      if (status === 0) return true
      const probe = run(runtime, 'systemctl', ['--user', 'is-active', timerName], { allowFailure: true })
      return probe.status === 3 || probe.status === 4
    }
  )
  for (const file of [timerPath, servicePath]) {
    if (runtime.exists(file)) {
      runtime.rm(file, { force: true })
    }
  }
  const reloaded = run(runtime, 'systemctl', ['--user', 'daemon-reload'], { allowFailure: true })
  reportAllowedFailure(runtime, reloaded, 'systemctl --user daemon-reload', 'systemd may keep the stale unit loaded')
  runtime.log('TokenBoard timer removed.')
  return { platform: 'linux', unitDir }
}

// `allowFailure` keeps a non-zero exit from aborting the uninstall, but it must not be
// silent on any platform: uninstall reports the schedule as removed either way, so a
// swallowed failure would leave the timer registered (or systemd holding a stale unit)
// with no trace. A missing command (ENOENT) stays quiet: a host without the platform's
// scheduler has no schedule to remove. `tolerated(status)` lets a platform name the exit
// codes that mean "there was nothing loaded to remove" (launchctl's 3, or an is-active
// answer of 3/4), which an uninstall must treat as success rather than as a failure that
// contradicts the "removed" line.
function reportAllowedFailure(runtime, result, commandLine, consequence, tolerated = () => false) {
  if (result.error?.code === 'ENOENT') return
  if (result.status === 0) return
  if (tolerated(result.status)) return
  runtime.error(
    `TokenBoard schedule cleanup (${commandLine}) failed with exit code ${result.status ?? 1}; ${consequence}.`
  )
}

function readOptionalConfig(readConfig, runtime) {
  try {
    return readConfig()
  } catch (error) {
    // Uninstall must still remove the schedule when the config is unreadable, but the
    // failure must not be silent: the reported schedule times fall back to defaults.
    runtime.error(`TokenBoard config could not be read (${errorMessage(error)}); using default schedule times.`)
    return {}
  }
}

function readScheduleTimes(config) {
  if (!Array.isArray(config.scheduleTimes)) {
    return dailyScheduleTimes
  }

  const scheduleTimes = config.scheduleTimes.filter(
    (time) => typeof time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(time)
  )
  return scheduleTimes.length > 0 ? scheduleTimes : dailyScheduleTimes
}

// A missing scheduler command is not a failure to uninstall: the macOS and Linux paths already
// tolerate it, and a host without the platform's scheduler has no schedule to remove. Only a
// command that ran and returned non-zero is worth reporting.
function run(runtime, command, args, options = {}) {
  const result = runtime.spawn(command, args, {
    stdio: options.allowFailure ? 'ignore' : 'inherit',
    env: runtime.env
  })
  if (result.error?.code === 'ENOENT' && !options.allowFailure) {
    throw new Error(`Required scheduler command not found: ${command}`)
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} failed with exit code ${result.status ?? 1}`)
  }
  return result
}

function runCli() {
  if (printHelpIfRequested(process.argv.slice(2), usage)) return
  try {
    uninstallSchedule()
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}

if (isMainModule(import.meta.url)) {
  runCli()
}
