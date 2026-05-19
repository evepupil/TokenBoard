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
  taskCommand,
  taskName = windowsTaskName(dailyScheduleTimes[0]),
  startTime = dailyScheduleTimes[0]
}) {
  const command = taskCommand || buildWindowsTaskCommand({
    nodePath,
    scriptPath,
    packageManager,
    pathEnv,
    homeDir
  })
  return [
    '/Create',
    '/F',
    '/SC',
    'DAILY',
    '/TN',
    taskName,
    '/TR',
    command,
    '/ST',
    startTime
  ]
}

export function buildWindowsTaskDefinitions({
  nodePath,
  scriptPath,
  packageManager = 'pnpm',
  pathEnv = 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
  homeDir = '',
  taskCommand,
  scheduleTimes = dailyScheduleTimes
}) {
  return scheduleTimes.map((startTime) => ({
    name: windowsTaskName(startTime),
    args: buildWindowsTaskArgs({
      nodePath,
      scriptPath,
      packageManager,
      pathEnv,
      homeDir,
      taskCommand,
      taskName: windowsTaskName(startTime),
      startTime
    })
  }))
}

export function buildWindowsTaskScript({ nodePath, scriptPath, packageManager, pathEnv, homeDir }) {
  const normalizedPath = normalizePathEnv({ pathEnv, homeDir, nodePath, delimiter: ';' })
  const logDir = joinForDelimiter(homeDir, '.tokenboard', 'logs', ';')
  const syncCommand = `${quoteWindowsArg(nodePath)} ${quoteWindowsArg(scriptPath)} --mode sync --source all --scheduled`
  return [
    '@echo off',
    `set "TOKENBOARD_PACKAGE_MANAGER=${escapeWindowsCmdValue(packageManager)}"`,
    'set "TOKENBOARD_SCHEDULED_SYNC=1"',
    `set "TOKENBOARD_LOG_DIR=${escapeWindowsCmdValue(logDir)}"`,
    `set "PATH=${escapeWindowsCmdValue(normalizedPath)}"`,
    syncCommand,
    ''
  ].join('\r\n')
}

export function buildWindowsTaskCommand({ nodePath, scriptPath, packageManager, pathEnv, homeDir }) {
  const normalizedPath = normalizePathEnv({ pathEnv, homeDir, nodePath, delimiter: ';' })
  const logDir = joinForDelimiter(homeDir, '.tokenboard', 'logs', ';')
  const syncCommand = `${quoteWindowsArg(nodePath)} ${quoteWindowsArg(scriptPath)} --mode sync --source all --scheduled`
  const command = [
    `set "TOKENBOARD_PACKAGE_MANAGER=${escapeWindowsCmdValue(packageManager)}"`,
    'set "TOKENBOARD_SCHEDULED_SYNC=1"',
    `set "TOKENBOARD_LOG_DIR=${escapeWindowsCmdValue(logDir)}"`,
    `set "PATH=${escapeWindowsCmdValue(normalizedPath)}"`,
    syncCommand
  ].join(' && ')

  return `cmd.exe /d /s /c ${quoteWindowsArg(command)}`
}

export function buildMacLaunchAgentPlist({ nodePath, scriptPath, packageManager, pathEnv, homeDir, logDir, scheduleTimes = dailyScheduleTimes }) {
  const normalizedPath = normalizePathEnv({ pathEnv, homeDir, nodePath })
  const intervals = scheduleTimes.map((time) => {
    const [hour, minute] = parseScheduleTime(time)
    return `\t\t<dict>
\t\t\t<key>Hour</key>
\t\t\t<integer>${hour}</integer>
\t\t\t<key>Minute</key>
\t\t\t<integer>${minute}</integer>
\t\t</dict>`
  }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${escapeXml(normalizedPath)}</string>
\t\t<key>TOKENBOARD_PACKAGE_MANAGER</key>
\t\t<string>${escapeXml(packageManager)}</string>
\t\t<key>TOKENBOARD_SCHEDULED_SYNC</key>
\t\t<string>1</string>
\t\t<key>TOKENBOARD_LOG_DIR</key>
\t\t<string>${escapeXml(logDir)}</string>
\t</dict>
\t<key>Label</key>
\t<string>${launchAgentLabel}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${escapeXml(nodePath)}</string>
\t\t<string>${escapeXml(scriptPath)}</string>
\t\t<string>--mode</string>
\t\t<string>sync</string>
\t\t<string>--source</string>
\t\t<string>all</string>
\t\t<string>--scheduled</string>
\t</array>
\t<key>RunAtLoad</key>
\t<false/>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(`${logDir}/daily-sync.err.log`)}</string>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(`${logDir}/daily-sync.out.log`)}</string>
\t<key>StartCalendarInterval</key>
\t<array>
${intervals}
\t</array>
</dict>
</plist>
`
}

export function buildLinuxSystemdUnits({ nodePath, scriptPath, packageManager, pathEnv, homeDir, timezone, scheduleTimes = dailyScheduleTimes }) {
  const normalizedPath = normalizePathEnv({ pathEnv, homeDir, nodePath })
  const timezoneSuffix = typeof timezone === 'string' && timezone.length > 0 ? ` ${timezone}` : ''
  return {
    service: `[Unit]
Description=TokenBoard daily sync

[Service]
Type=oneshot
Environment=TOKENBOARD_PACKAGE_MANAGER=${packageManager}
Environment=TOKENBOARD_SCHEDULED_SYNC=1
Environment=TOKENBOARD_LOG_DIR=${joinForDelimiter(homeDir, '.tokenboard', 'logs', ':')}
Environment=PATH=${normalizedPath}
ExecStart=${nodePath} ${scriptPath} --mode sync --source all --scheduled
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

function quoteWindowsArg(value) {
  return `"${String(value)}"`
}

function escapeWindowsCmdValue(value) {
  return String(value)
    .replaceAll('^', '^^')
    .replaceAll('&', '^&')
    .replaceAll('|', '^|')
    .replaceAll('<', '^<')
    .replaceAll('>', '^>')
}
