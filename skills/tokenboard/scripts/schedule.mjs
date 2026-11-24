import { dirname } from 'node:path'

export const serviceName = 'tokenboard-daily-sync.service'
export const timerName = 'tokenboard-daily-sync.timer'
export const launchAgentLabel = 'com.tokenboard.daily-sync'
export const windowsWrapperName = 'tokenboard-daily-sync.cmd'
export const dailyScheduleTimes = ['09:00', '12:00', '18:00', '23:00']

export function buildWindowsTaskArgs({
  nodePath,
  scriptPath,
  packageManager = 'pnpm',
  pathEnv = 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
  homeDir = '',
  configDir,
  taskCommand,
  taskName = windowsTaskName(dailyScheduleTimes[0]),
  startTime = dailyScheduleTimes[0]
}) {
  if (!taskCommand) {
    throw new Error('A Windows task requires the wrapper .cmd path as taskCommand')
  }
  return ['/Create', '/F', '/SC', 'DAILY', '/TN', taskName, '/TR', taskCommand, '/ST', startTime]
}

export function buildWindowsTaskDefinitions({
  nodePath,
  scriptPath,
  packageManager = 'pnpm',
  pathEnv = 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
  homeDir = '',
  configDir,
  taskCommand,
  scheduleTimes = dailyScheduleTimes
}) {
  return scheduleTimes.map((startTime) => {
    const taskName = windowsTaskName(startTime)
    return {
      name: taskName,
      args: buildWindowsTaskArgs({
        nodePath,
        scriptPath,
        packageManager,
        pathEnv,
        homeDir,
        configDir,
        taskCommand,
        taskName,
        startTime
      }),
      startWhenAvailableArgs: buildWindowsStartWhenAvailableArgs(taskName)
    }
  })
}

export function buildWindowsStartWhenAvailableArgs(taskName) {
  // schtasks /Create cannot express StartWhenAvailable, so a run missed while asleep or
  // powered off is silently skipped: the only one of the three schedulers without catch-up.
  // The patch mutates the existing settings object in place instead of building a fresh one:
  // New-ScheduledTaskSettingsSet alone would reset every other setting (battery policy,
  // execution limits) schtasks just wrote.
  const script = [
    `$task = Get-ScheduledTask -TaskName '${taskName}'`,
    '$task.Settings.StartWhenAvailable = $true',
    `Set-ScheduledTask -TaskName '${taskName}' -Settings $task.Settings`
  ].join('; ')
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

export function buildWindowsTaskScript({ nodePath, scriptPath, packageManager, pathEnv, homeDir, configDir }) {
  const normalizedPath = normalizePathEnv({ pathEnv, homeDir, nodePath, delimiter: ';' })
  const stateDir = configDir || tokenboardDirForDelimiter(homeDir, ';')
  const logDir = joinForDelimiter(stateDir, 'logs', '', ';').replace(/[\\/]$/, '')
  // No --source here: sync.mjs resolves it at run time from config.source (default
  // 'all'), the same value status.mjs reads, so editing the config retargets the
  // scheduled sync without regenerating the task.
  //
  // `%` is expanded by cmd.exe on every line of a batch file, not only inside `set`, so the
  // command line needs the same doubling the variable assignments get. Measured: a line
  // `echo [C:\Tools\100%node\node.exe]` prints `[C:\Tools\100node\node.exe]` — the unmatched
  // `%` is swallowed — while `100%%node` prints `100%node`. A checkout under a `%` path would
  // otherwise point the task at a file that does not exist.
  const syncCommand = `${quoteWindowsArg(escapeWindowsCmdValue(nodePath))} ${quoteWindowsArg(escapeWindowsCmdValue(scriptPath))} --mode sync --scheduled`
  return [
    '@echo off',
    `set "TOKENBOARD_CONFIG_DIR=${escapeWindowsCmdValue(stateDir)}"`,
    `set "TOKENBOARD_PACKAGE_MANAGER=${escapeWindowsCmdValue(packageManager)}"`,
    'set "TOKENBOARD_SCHEDULED_SYNC=1"',
    `set "TOKENBOARD_LOG_DIR=${escapeWindowsCmdValue(logDir)}"`,
    `set "PATH=${escapeWindowsCmdValue(normalizedPath)}"`,
    syncCommand,
    ''
  ].join('\r\n')
}

export function buildMacLaunchAgentPlist({
  nodePath,
  scriptPath,
  packageManager,
  pathEnv,
  homeDir,
  configDir,
  logDir,
  scheduleTimes = dailyScheduleTimes
}) {
  const normalizedPath = normalizePathEnv({ pathEnv, homeDir, nodePath })
  const stateDir = configDir || `${homeDir.replace(/\/$/, '')}/.tokenboard`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${buildMacEnvironment({ normalizedPath, stateDir, packageManager, logDir })}
\t<key>Label</key>
\t<string>${launchAgentLabel}</string>
${buildMacProgramArguments({ nodePath, scriptPath })}
\t<key>RunAtLoad</key>
\t<false/>
\t<key>Umask</key>
\t<integer>63</integer>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(`${logDir}/daily-sync.err.log`)}</string>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(`${logDir}/daily-sync.out.log`)}</string>
\t<key>StartCalendarInterval</key>
\t<array>
${buildMacCalendarIntervals(scheduleTimes)}
\t</array>
</dict>
</plist>
`
}

function buildMacEnvironment({ normalizedPath, stateDir, packageManager, logDir }) {
  return `\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${escapeXml(normalizedPath)}</string>
\t\t<key>TOKENBOARD_CONFIG_DIR</key>
\t\t<string>${escapeXml(stateDir)}</string>
\t\t<key>TOKENBOARD_PACKAGE_MANAGER</key>
\t\t<string>${escapeXml(packageManager)}</string>
\t\t<key>TOKENBOARD_SCHEDULED_SYNC</key>
\t\t<string>1</string>
\t\t<key>TOKENBOARD_LOG_DIR</key>
\t\t<string>${escapeXml(logDir)}</string>
\t</dict>`
}

function buildMacProgramArguments({ nodePath, scriptPath }) {
  return `\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${escapeXml(nodePath)}</string>
\t\t<string>${escapeXml(scriptPath)}</string>
\t\t<string>--mode</string>
\t\t<string>sync</string>
\t\t<string>--scheduled</string>
\t</array>`
}

function buildMacCalendarIntervals(scheduleTimes) {
  return scheduleTimes
    .map((time) => {
      const [hour, minute] = parseScheduleTime(time)
      return `\t\t<dict>
\t\t\t<key>Hour</key>
\t\t\t<integer>${hour}</integer>
\t\t\t<key>Minute</key>
\t\t\t<integer>${minute}</integer>
\t\t</dict>`
    })
    .join('\n')
}

export function buildLinuxSystemdUnits({
  nodePath,
  scriptPath,
  packageManager,
  pathEnv,
  homeDir,
  configDir,
  timezone,
  scheduleTimes = dailyScheduleTimes
}) {
  const normalizedPath = normalizePathEnv({ pathEnv, homeDir, nodePath })
  const stateDir = configDir || `${homeDir.replace(/\/$/, '')}/.tokenboard`
  const timezoneSuffix = systemdTimezoneSuffix(timezone)
  return {
    service: `[Unit]
Description=TokenBoard daily sync

[Service]
Type=oneshot
UMask=0077
Environment=${quoteSystemdValue(`TOKENBOARD_CONFIG_DIR=${stateDir}`)}
Environment=${quoteSystemdValue(`TOKENBOARD_PACKAGE_MANAGER=${packageManager}`)}
Environment=${quoteSystemdValue('TOKENBOARD_SCHEDULED_SYNC=1')}
Environment=${quoteSystemdValue(`TOKENBOARD_LOG_DIR=${stateDir}/logs`)}
Environment=${quoteSystemdValue(`PATH=${normalizedPath}`)}
ExecStart=${quoteSystemdArg(nodePath)} ${quoteSystemdArg(scriptPath)} --mode sync --scheduled
`,
    timer: `[Unit]
Description=Run TokenBoard daily sync

[Timer]
${scheduleTimes.map((time) => `OnCalendar=${time}${timezoneSuffix}`).join('\n')}
Persistent=true

[Install]
WantedBy=timers.target
`
  }
}

export function parseScheduleTimes(value = dailyScheduleTimes.join(',')) {
  const scheduleTimes = String(value)
    .split(',')
    .map((time) => time.trim())
    .filter(Boolean)

  if (scheduleTimes.length === 0) {
    throw new Error('Schedule times cannot be empty.')
  }

  for (const time of scheduleTimes) {
    parseScheduleTime(time)
  }

  return [...new Set(scheduleTimes)].sort()
}

export function windowsTaskName(startTime) {
  return `TokenBoardDailySync${startTime.replace(':', '')}`
}

// The schedule is expressed in the machine's local time — launchd, systemd and
// the Windows task scheduler all fire on local wall-clock time — so the window
// has to be evaluated the same way. A UTC comparison would put the window on
// the wrong hours entirely for anyone east or west of Greenwich.
export function isWithinScheduleWindow({ times, windowMs, now = Date.now() } = {}) {
  if (!Array.isArray(times) || times.length === 0) return false
  if (!Number.isFinite(windowMs) || windowMs <= 0) return false

  const windowMinutes = windowMs / 60_000
  const local = new Date(now)
  const currentMinutes = local.getHours() * 60 + local.getMinutes()

  for (const time of times) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time).trim())
    if (!match) continue
    const scheduledMinutes = Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10)
    // The distance wraps around midnight: a 23:50 trigger is ten minutes
    // before a 00:00 schedule, not twenty-three hours and ten minutes after it.
    const direct = Math.abs(currentMinutes - scheduledMinutes)
    const distance = Math.min(direct, 24 * 60 - direct)
    if (distance <= windowMinutes) return true
  }
  return false
}

function parseScheduleTime(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!match) {
    throw new Error(`Invalid schedule time: ${time}. Expected HH:MM in 24-hour format.`)
  }
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)]
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

// The timezone reaches this function from the pairing response (or --timezone) and is
// interpolated into the timer's OnCalendar lines, which systemd parses as unit syntax. An
// IANA name only ever contains letters, digits, `_`, `+`, `-` and `/`; anything else stops
// the install instead of being dropped, because dropping the suffix would quietly move the
// schedule to the system-local zone.
function systemdTimezoneSuffix(timezone) {
  if (timezone === undefined || timezone === null || timezone === '') return ''
  if (typeof timezone !== 'string' || !/^[A-Za-z0-9_+/-]+$/.test(timezone)) {
    throw new Error(`Invalid timezone: ${JSON.stringify(timezone)}. Expected an IANA timezone name like Asia/Shanghai.`)
  }
  return ` ${timezone}`
}

// Exported for the escaping tests: the values interpolated here include a user-supplied
// timezone in `Environment=…=TOKENBOARD_…`, and a newline inside one would split the unit.
export function quoteSystemdValue(value) {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')}"`
}

function quoteSystemdArg(value) {
  return quoteSystemdValue(value)
}

export function normalizePathEnv({ pathEnv, homeDir, nodePath, delimiter = ':' }) {
  const paths = pathEnv.split(delimiter).filter(Boolean)
  prependOnce(paths, dirnameForDelimiter(nodePath, delimiter))
  prependOnce(paths, joinForDelimiter(homeDir, '.local', 'bin', delimiter))
  prependOnce(paths, joinForDelimiter(homeDir, '.bun', 'bin', delimiter))
  return paths.join(delimiter)
}

function prependOnce(paths, value) {
  const index = paths.indexOf(value)
  if (index >= 0) {
    paths.splice(index, 1)
  }
  paths.unshift(value)
}

function dirnameForDelimiter(value, delimiter) {
  if (delimiter !== ';') {
    return dirname(value)
  }

  const index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'))
  return index >= 0 ? value.slice(0, index) : '.'
}

function joinForDelimiter(base, first, second, delimiter) {
  const separator = delimiter === ';' ? '\\' : '/'
  return [base.replace(/[\\/]$/, ''), first, second].join(separator)
}

function tokenboardDirForDelimiter(homeDir, delimiter) {
  const separator = delimiter === ';' ? '\\' : '/'
  return [homeDir.replace(/[\\/]$/, ''), '.tokenboard'].join(separator)
}

function quoteWindowsArg(value) {
  return `"${String(value)}"`
}

// Only `%` needs escaping inside `set "NAME=value"`. Every other cmd
// metacharacter is literal there — measured on Windows: `set "V=Tom & Jerry"`
// keeps the `&`, and `set "V=Tom ^& Jerry"` stores a literal caret — so
// escaping them would write a caret the value never had and point the variable
// at a path that does not exist.
function escapeWindowsCmdValue(value) {
  return String(value).replaceAll('%', '%%')
}
