#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDir, readConfig } from './config.mjs'
import { dailyScheduleTimes, launchAgentLabel, serviceName, timerName } from './schedule.mjs'

export function uninstallSchedule(options = {}) {
  const env = options.env || process.env
  const config = options.config || readOptionalConfig(options.readConfig || readConfig)
  const scheduleTimes = readScheduleTimes(config)
  const runtime = {
    platform: options.platform || env.TOKENBOARD_INSTALL_SCHEDULE_TEST_PLATFORM || platform(),
    homeDir: options.homeDir || homedir(),
    configDir: options.configDir || configDir(),
    env,
    spawn: options.spawn || spawnSync,
    getUid: options.getUid || (() => Number.parseInt(env.TOKENBOARD_INSTALL_SCHEDULE_TEST_UID || process.getuid?.() || 0, 10)),
    exists: options.exists || existsSync,
    rm: options.rm || rmSync,
    log: options.log || console.log
  }

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
  run(runtime, 'powershell.exe', buildWindowsScheduleCleanupArgs(), { allowFailure: true })
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
  run(runtime, 'launchctl', ['bootout', userDomain, plistPath], { allowFailure: true })
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
  run(runtime, 'systemctl', ['--user', 'disable', '--now', timerName], { allowFailure: true })
  for (const file of [timerPath, servicePath]) {
    if (runtime.exists(file)) {
      runtime.rm(file, { force: true })
    }
  }
  run(runtime, 'systemctl', ['--user', 'daemon-reload'], { allowFailure: true })
  runtime.log('TokenBoard timer removed.')
  return { platform: 'linux', unitDir }
}

function readOptionalConfig(readConfig) {
  try {
    return readConfig()
  } catch {
    return {}
  }
}

function readScheduleTimes(config) {
  if (!Array.isArray(config.scheduleTimes)) {
    return dailyScheduleTimes
  }

  const scheduleTimes = config.scheduleTimes.filter((time) => typeof time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(time))
  return scheduleTimes.length > 0 ? scheduleTimes : dailyScheduleTimes
}

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
}

function runCli() {
  try {
    uninstallSchedule()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
