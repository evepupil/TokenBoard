#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'
import { configDir, mergeConfig, parseArgs, readConfig } from './config.mjs'
import { printHelpIfRequested } from './cli-help.mjs'
import { errorMessage } from './error-message.mjs'
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
const usage = 'Usage: install-schedule.mjs [--schedule-times 09:00,12:00,18:00,23:00]'

export function installSchedule(options = {}) {
  const env = options.env || process.env
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const scheduleTimes = parseScheduleTimes(
    flags['schedule-times'] || env.TOKENBOARD_SCHEDULE_TIMES || dailyScheduleTimes.join(',')
  )
  const runtime = {
    platform: options.platform || env.TOKENBOARD_INSTALL_SCHEDULE_TEST_PLATFORM || platform(),
    nodePath: options.nodePath || process.execPath,
    scriptPath: options.scriptPath || scriptPath,
    homeDir: options.homeDir || homedir(),
    configDir: options.configDir || configDir(),
    env,
    spawn: options.spawn || spawnSync,
    getUid:
      options.getUid ||
      (() => Number.parseInt(env.TOKENBOARD_INSTALL_SCHEDULE_TEST_UID || process.getuid?.() || 0, 10)),
    readConfig: options.readConfig || readConfig,
    // The installed schedule is what status.mjs compares against
    // config.scheduleTimes, so a manual re-install with different times must
    // record them; otherwise status reports a schedule the machine does not run.
    mergeConfig: options.mergeConfig || mergeConfig,
    mkdir: options.mkdir || mkdirSync,
    writeFile: options.writeFile || writeFileSync,
    exists: options.exists || existsSync,
    log: options.log || console.log,
    error: options.error || console.error
  }

  let result
  if (runtime.platform === 'win32') {
    result = installWindows(runtime, scheduleTimes)
  } else if (runtime.platform === 'darwin') {
    result = installMac(runtime, scheduleTimes)
  } else if (runtime.platform === 'linux') {
    result = installLinux(runtime, scheduleTimes)
  } else {
    throw new Error(`Automatic schedule install is not supported on ${runtime.platform}.`)
  }
  runtime.mergeConfig({ scheduleTimes, updatedAt: new Date().toISOString() })
  return result
}

function installWindows(runtime, scheduleTimes) {
  requireCommand(runtime, 'schtasks.exe')
  const config = runtime.readConfig()
  const wrapperPath = join(runtime.configDir, windowsWrapperName)
  runtime.mkdir(runtime.configDir, { recursive: true })
  runtime.writeFile(
    wrapperPath,
    buildWindowsTaskScript({
      nodePath: runtime.nodePath,
      scriptPath: runtime.scriptPath,
      packageManager: config.packageManager || runtime.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm',
      pathEnv: runtime.env.PATH || 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      homeDir: runtime.homeDir,
      configDir: runtime.configDir
    })
  )
  for (const task of buildWindowsTaskDefinitions({
    nodePath: runtime.nodePath,
    scriptPath: runtime.scriptPath,
    packageManager: config.packageManager || runtime.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm',
    pathEnv: runtime.env.PATH || 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    homeDir: runtime.homeDir,
    configDir: runtime.configDir,
    taskCommand: `"${wrapperPath}"`,
    scheduleTimes
  })) {
    runOrThrow(runtime, 'schtasks.exe', task.args)
    // schtasks /Create registers tasks that are skipped silently when the machine is
    // asleep or off at the scheduled time; the settings patch restores catch-up parity
    // with launchd and systemd's Persistent=true.
    runOrThrow(runtime, 'powershell.exe', task.startWhenAvailableArgs)
  }
  runOrThrow(runtime, 'powershell.exe', buildWindowsStaleTaskCleanupArgs(scheduleTimes))
  return { platform: 'win32', scheduleTimes }
}

export function buildWindowsStaleTaskCleanupArgs(scheduleTimes) {
  const currentTaskNames = new Set(scheduleTimes.map(windowsTaskName))
  const currentList = [...currentTaskNames].map((taskName) => `'${taskName}'`).join(',')
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
  runtime.writeFile(
    plistPath,
    buildMacLaunchAgentPlist({
      nodePath: runtime.nodePath,
      scriptPath: runtime.scriptPath,
      packageManager: config.packageManager || runtime.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm',
      pathEnv: runtime.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      homeDir: runtime.homeDir,
      configDir: runtime.configDir,
      logDir,
      scheduleTimes
    })
  )

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
    configDir: runtime.configDir,
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
  // `systemctl --version` only prints the client version and succeeds even where the user
  // systemd bus is not running (WSL without systemd, containers), deferring the failure to
  // an opaque daemon-reload error. `is-system-running` actually probes the bus; a zero exit
  // means degraded or running, both of which schedule user timers.
  const result = spawnCommand(runtime, 'systemctl', ['--user', 'is-system-running'], { stdio: 'ignore' })
  if (result.status !== 0) {
    throw new Error(
      'The user systemd bus is not running (for example WSL without systemd or a container); ' +
        'automatic TokenBoard scheduling needs a systemd user session.'
    )
  }
}

function enableLinger(runtime) {
  requireCommand(runtime, 'loginctl')
  const user = resolveLingerUser(runtime)
  const result = spawnCommand(runtime, 'loginctl', user ? ['enable-linger', user] : ['enable-linger'])
  if (result.status !== 0) {
    // Without linger the timer only fires while a session is active. That is still a
    // working install for an interactive machine, so warn instead of failing the install.
    runtime.log('TokenBoard could not enable linger for this user; the sync timer only runs while you are logged in.')
  }
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
  if (printHelpIfRequested(process.argv.slice(2), usage)) return
  try {
    installSchedule()
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}

if (isMainModule(import.meta.url)) {
  runCli()
}
