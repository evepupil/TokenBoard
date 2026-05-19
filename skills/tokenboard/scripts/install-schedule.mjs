#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDir, parseArgs, readConfig } from './config.mjs'
import {
  buildLinuxSystemdUnits,
  buildMacLaunchAgentPlist,
  buildWindowsTaskScript,
  buildWindowsTaskDefinitions,
  dailyScheduleTimes,
  launchAgentLabel,
  parseScheduleTimes,
  serviceName,
  timerName,
  windowsWrapperName,
  windowsTaskName
} from './schedule.mjs'

const scriptPath = fileURLToPath(new URL('./sync.mjs', import.meta.url))

export function installSchedule(options = {}) {
  const env = options.env || process.env
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const scheduleTimes = parseScheduleTimes(flags['schedule-times'] || env.TOKENBOARD_SCHEDULE_TIMES || dailyScheduleTimes.join(','))
  const runtime = {
    platform: options.platform || env.TOKENBOARD_INSTALL_SCHEDULE_TEST_PLATFORM || platform(),
    nodePath: options.nodePath || process.execPath,
    scriptPath: options.scriptPath || scriptPath,
    homeDir: options.homeDir || homedir(),
    configDir: options.configDir || configDir(),
    env,
    spawn: options.spawn || spawnSync,
    getUid: options.getUid || (() => Number.parseInt(env.TOKENBOARD_INSTALL_SCHEDULE_TEST_UID || process.getuid?.() || 0, 10)),
    readConfig: options.readConfig || readConfig,
    mkdir: options.mkdir || mkdirSync,
    writeFile: options.writeFile || writeFileSync,
    exists: options.exists || existsSync,
    log: options.log || console.log,
    error: options.error || console.error
  }

  if (runtime.platform === 'win32') {
    return installWindows(runtime, scheduleTimes)
  }
  if (runtime.platform === 'darwin') {
    return installMac(runtime, scheduleTimes)
  }
  if (runtime.platform === 'linux') {
    return installLinux(runtime, scheduleTimes)
  }

  throw new Error(`Automatic schedule install is not supported on ${runtime.platform}.`)
}

function installWindows(runtime, scheduleTimes) {
  requireCommand(runtime, 'schtasks.exe')
  const config = runtime.readConfig()
  const wrapperPath = join(runtime.configDir, windowsWrapperName)
  runtime.mkdir(runtime.configDir, { recursive: true })
  runtime.writeFile(wrapperPath, buildWindowsTaskScript({
    nodePath: runtime.nodePath,
    scriptPath: runtime.scriptPath,
    packageManager: config.packageManager || runtime.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm',
    pathEnv: runtime.env.PATH || 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    homeDir: runtime.homeDir
  }))
  for (const task of buildWindowsTaskDefinitions({
    nodePath: runtime.nodePath,
    scriptPath: runtime.scriptPath,
    packageManager: config.packageManager || runtime.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm',
    pathEnv: runtime.env.PATH || 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    homeDir: runtime.homeDir,
    taskCommand: `"${wrapperPath}"`,
    scheduleTimes
  })) {
    runOrThrow(runtime, 'schtasks.exe', task.args)
  }
  runOrThrow(runtime, 'powershell.exe', buildWindowsStaleTaskCleanupArgs(scheduleTimes))
  return { platform: 'win32', scheduleTimes }
}

export function buildWindowsStaleTaskCleanupArgs(scheduleTimes) {
  const currentTaskNames = new Set(scheduleTimes.map(windowsTaskName))
  const currentList = [...currentTaskNames]
    .map((taskName) => `'${taskName}'`)
    .join(',')
  const command = [
    `$current = @(${currentList})`,
    `Get-ScheduledTask -TaskPath '\\' | Where-Object { (($_.TaskName -like 'TokenBoardDailySync*') -or ($_.Actions | Where-Object { $_.Execute -like '*node*' -and $_.Arguments -like '*TokenBoard*skills*tokenboard*scripts*sync.mjs*' })) -and $current -notcontains $_.TaskName } | Unregister-ScheduledTask -Confirm:$false`
  ].join('; ')
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]
}

function installMac(runtime, scheduleTimes) {
  requireCommand(runtime, 'launchctl')

  const config = runtime.readConfig()
  const agentDir = join(runtime.homeDir, 'Library', 'LaunchAgents')
  const logDir = join(runtime.configDir, 'logs')
  runtime.mkdir(agentDir, { recursive: true })
  runtime.mkdir(logDir, { recursive: true })
  const plistPath = join(agentDir, `${launchAgentLabel}.plist`)
  runtime.writeFile(plistPath, buildMacLaunchAgentPlist({
    nodePath: runtime.nodePath,
    scriptPath: runtime.scriptPath,
    packageManager: config.packageManager || runtime.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm',
    pathEnv: runtime.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    homeDir: runtime.homeDir,
    logDir,
    scheduleTimes
  }))

  const userDomain = `gui/${runtime.getUid()}`
  runOrThrow(runtime, 'launchctl', ['bootout', userDomain, plistPath], { allowFailure: true })
  runOrThrow(runtime, 'launchctl', ['bootstrap', userDomain, plistPath])
  runOrThrow(runtime, 'launchctl', ['enable', `${userDomain}/${launchAgentLabel}`])
  runtime.log('TokenBoard LaunchAgent installed.')
  return { platform: 'darwin', scheduleTimes, plistPath }
}

function installLinux(runtime, scheduleTimes) {
  requireUserSystemd(runtime)

  const config = runtime.readConfig()
  const unitDir = join(runtime.homeDir, '.config', 'systemd', 'user')
  runtime.mkdir(unitDir, { recursive: true })
  const units = buildLinuxSystemdUnits({
    nodePath: runtime.nodePath,
    scriptPath: runtime.scriptPath,
    packageManager: config.packageManager || runtime.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm',
    pathEnv: runtime.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    homeDir: runtime.homeDir,
    timezone: config.timezone,
    scheduleTimes
  })
  runtime.writeFile(join(unitDir, serviceName), units.service)
  runtime.writeFile(join(unitDir, timerName), units.timer)

  runOrThrow(runtime, 'systemctl', ['--user', 'daemon-reload'])
  runOrThrow(runtime, 'systemctl', ['--user', 'enable', '--now', timerName])
  enableLinger(runtime)
  runtime.log('TokenBoard timer installed.')
  return { platform: 'linux', scheduleTimes, unitDir }
}

function requireCommand(runtime, command) {
  const result = spawnCommand(runtime, command, ['--version'], { stdio: 'ignore' })
  if (result.error?.code === 'ENOENT') {
    throw new Error(`Required scheduler command not found: ${command}`)
  }
}

function requireUserSystemd(runtime) {
  const result = spawnCommand(runtime, 'systemctl', ['--user', '--version'], { stdio: 'ignore' })
  if (result.status !== 0) {
    throw new Error('User systemd is not available for automatic TokenBoard scheduling.')
  }
}

function enableLinger(runtime) {
  requireCommand(runtime, 'loginctl')
  const user = resolveLingerUser(runtime)
  runOrThrow(runtime, 'loginctl', user ? ['enable-linger', user] : ['enable-linger'])
}

function resolveLingerUser(runtime) {
  const user = runtime.env.USER || runtime.env.LOGNAME || runtime.env.USERNAME
  if (user) {
    return user
  }
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

function runOrThrow(runtime, command, args, options = {}) {
  const result = spawnCommand(runtime, command, args, { stdio: options.allowFailure ? 'ignore' : 'inherit' })
  if (result.error?.code === 'ENOENT') {
    throw new Error(`Required scheduler command not found: ${command}`)
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} failed with exit code ${result.status ?? 1}`)
  }
}

function spawnCommand(runtime, command, args, options) {
  return runtime.spawn(command, args, {
    ...options,
    env: runtime.env
  })
}

function runCli() {
  try {
    installSchedule()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
