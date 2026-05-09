import { dirname } from 'node:path'

export const serviceName = 'tokenboard-daily-sync.service'
export const timerName = 'tokenboard-daily-sync.timer'

export function buildWindowsTaskArgs({ nodePath, scriptPath }) {
  const taskCommand = `"${nodePath}" "${scriptPath}" --mode sync --source all`
  return [
    '/Create',
    '/F',
    '/SC',
    'DAILY',
    '/TN',
    'TokenBoardDailySync',
    '/TR',
    taskCommand,
    '/ST',
    '09:00'
  ]
}

export function buildLinuxSystemdUnits({ nodePath, scriptPath, packageManager, pathEnv, homeDir }) {
  const normalizedPath = normalizePathEnv({ pathEnv, homeDir, nodePath })
  return {
    service: `[Unit]
Description=TokenBoard daily sync

[Service]
Type=oneshot
Environment=TOKENBOARD_PACKAGE_MANAGER=${packageManager}
Environment=PATH=${normalizedPath}
ExecStart=${nodePath} ${scriptPath} --mode sync --source all
`,
    timer: `[Unit]
Description=Run TokenBoard daily sync

[Timer]
OnCalendar=09:00
OnCalendar=12:00
OnCalendar=18:00
OnCalendar=23:00
Persistent=true

[Install]
WantedBy=timers.target
`
  }
}

export function normalizePathEnv({ pathEnv, homeDir, nodePath }) {
  const paths = pathEnv.split(':').filter(Boolean)
  prependOnce(paths, dirname(nodePath))
  prependOnce(paths, `${homeDir}/.local/bin`)
  prependOnce(paths, `${homeDir}/.bun/bin`)
  return paths.join(':')
}

function prependOnce(paths, value) {
  const index = paths.indexOf(value)
  if (index >= 0) {
    paths.splice(index, 1)
  }
  paths.unshift(value)
}
