import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLinuxSystemdUnits,
  buildMacLaunchAgentPlist,
  buildWindowsTaskArgs,
  buildWindowsTaskScript,
  buildWindowsTaskDefinitions,
  normalizePathEnv,
  parseScheduleTimes
} from './schedule.mjs'

test('builds the Windows scheduled task shape with time-suffixed names', () => {
  const args = buildWindowsTaskArgs({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Users\\mison\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\sync.mjs'
  })

  assert.deepEqual(args.slice(0, 7), [
    '/Create',
    '/F',
    '/SC',
    'DAILY',
    '/TN',
    'TokenBoardDailySync0900',
    '/TR'
  ])
  assert.match(args[7], /cmd\.exe \/d \/s \/c/)
  assert.match(args[7], /TOKENBOARD_PACKAGE_MANAGER=pnpm/)
  assert.match(args[7], /TOKENBOARD_SCHEDULED_SYNC=1/)
  assert.doesNotMatch(args[7], /""TOKENBOARD_/)
  assert.match(args[7], /--mode sync --source all --scheduled/)
  assert.deepEqual(args.slice(8), ['/ST', '09:00'])
})

test('builds Windows scheduled task definitions for every daily sync time', () => {
  const tasks = buildWindowsTaskDefinitions({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Users\\mison\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\sync.mjs'
  })

  assert.deepEqual(
    tasks.map((task) => task.name),
    ['TokenBoardDailySync0900', 'TokenBoardDailySync1200', 'TokenBoardDailySync1800', 'TokenBoardDailySync2300']
  )
  assert.deepEqual(
    tasks.map((task) => task.args.at(-1)),
    ['09:00', '12:00', '18:00', '23:00']
  )
})

test('builds macOS LaunchAgent plist for every daily sync time', () => {
  const plist = buildMacLaunchAgentPlist({
    nodePath: '/opt/homebrew/bin/node',
    scriptPath: '/Users/mison/.tokenboard/TokenBoard/skills/tokenboard/scripts/sync.mjs',
    packageManager: 'pnpm',
    pathEnv: '/usr/bin:/bin',
    homeDir: '/Users/mison',
    logDir: '/Users/mison/.tokenboard/logs'
  })

  assert.match(plist, /<string>com\.tokenboard\.daily-sync<\/string>/)
  assert.match(plist, /<string>pnpm<\/string>/)
  assert.match(plist, /<key>TOKENBOARD_SCHEDULED_SYNC<\/key>\s+<string>1<\/string>/)
  assert.match(plist, /<key>TOKENBOARD_LOG_DIR<\/key>\s+<string>\/Users\/mison\/.tokenboard\/logs<\/string>/)
  assert.match(plist, /<string>\/Users\/mison\/.tokenboard\/logs\/daily-sync\.out\.log<\/string>/)
  assert.match(plist, /<string>\/Users\/mison\/.tokenboard\/logs\/daily-sync\.err\.log<\/string>/)
  assert.match(plist, /<string>--scheduled<\/string>/)
  assert.equal([...plist.matchAll(/<key>Hour<\/key>\s+<integer>(\d+)<\/integer>/g)].map((match) => match[1]).join(','), '9,12,18,23')
  assert.equal([...plist.matchAll(/<key>Minute<\/key>\s+<integer>(\d+)<\/integer>/g)].map((match) => match[1]).join(','), '0,0,0,0')
})

test('parses validated schedule times and removes duplicates', () => {
  assert.deepEqual(parseScheduleTimes('18:30,09:00,09:00'), ['09:00', '18:30'])
  assert.throws(() => parseScheduleTimes('9:00'), /Invalid schedule time/)
  assert.throws(() => parseScheduleTimes('24:00'), /Invalid schedule time/)
  assert.throws(() => parseScheduleTimes(''), /cannot be empty/)
})

test('builds Linux user systemd units with pnpm available in PATH', () => {
  const units = buildLinuxSystemdUnits({
    nodePath: '/usr/bin/node',
    scriptPath: '/home/tokenboard/.tokenboard/TokenBoard/skills/tokenboard/scripts/sync.mjs',
    packageManager: 'pnpm',
    pathEnv: '/usr/bin:/bin',
    homeDir: '/home/tokenboard'
  })

  assert.match(units.service, /Environment=TOKENBOARD_PACKAGE_MANAGER=pnpm/)
  assert.match(units.service, /Environment=TOKENBOARD_SCHEDULED_SYNC=1/)
  assert.match(units.service, /Environment=TOKENBOARD_LOG_DIR=\/home\/tokenboard\/.tokenboard\/logs/)
  assert.match(units.service, /Environment=PATH=\/home\/tokenboard\/.bun\/bin:\/home\/tokenboard\/.local\/bin:\/usr\/bin:\/bin/)
  assert.match(units.service, /ExecStart=\/usr\/bin\/node \/home\/tokenboard\/.tokenboard\/TokenBoard\/skills\/tokenboard\/scripts\/sync.mjs --mode sync --source all --scheduled/)
  assert.match(units.timer, /OnCalendar=09:00/)
  assert.match(units.timer, /OnCalendar=12:00/)
  assert.match(units.timer, /OnCalendar=18:00/)
  assert.match(units.timer, /OnCalendar=23:00/)
  assert.match(units.timer, /Persistent=true/)
})

test('builds Linux user systemd calendar times with configured timezone', () => {
  const units = buildLinuxSystemdUnits({
    nodePath: '/usr/bin/node',
    scriptPath: '/home/tokenboard/.tokenboard/TokenBoard/skills/tokenboard/scripts/sync.mjs',
    packageManager: 'pnpm',
    pathEnv: '/usr/bin:/bin',
    homeDir: '/home/tokenboard',
    timezone: 'Asia/Shanghai',
    scheduleTimes: ['06:00', '09:00']
  })

  assert.match(units.timer, /OnCalendar=06:00 Asia\/Shanghai/)
  assert.match(units.timer, /OnCalendar=09:00 Asia\/Shanghai/)
})

test('builds schedules with custom daily sync times', () => {
  const scheduleTimes = parseScheduleTimes('08:15,21:45')
  const windowsTasks = buildWindowsTaskDefinitions({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Users\\mison\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\sync.mjs',
    scheduleTimes
  })
  const macPlist = buildMacLaunchAgentPlist({
    nodePath: '/opt/homebrew/bin/node',
    scriptPath: '/Users/mison/.tokenboard/TokenBoard/skills/tokenboard/scripts/sync.mjs',
    packageManager: 'pnpm',
    pathEnv: '/usr/bin:/bin',
    homeDir: '/Users/mison',
    logDir: '/Users/mison/.tokenboard/logs',
    scheduleTimes
  })
  const linuxUnits = buildLinuxSystemdUnits({
    nodePath: '/usr/bin/node',
    scriptPath: '/home/tokenboard/.tokenboard/TokenBoard/skills/tokenboard/scripts/sync.mjs',
    packageManager: 'pnpm',
    pathEnv: '/usr/bin:/bin',
    homeDir: '/home/tokenboard',
    scheduleTimes
  })

  assert.deepEqual(windowsTasks.map((task) => task.args.at(-1)), ['08:15', '21:45'])
  assert.match(macPlist, /<integer>8<\/integer>/)
  assert.match(macPlist, /<integer>15<\/integer>/)
  assert.match(macPlist, /<integer>21<\/integer>/)
  assert.match(macPlist, /<integer>45<\/integer>/)
  assert.match(linuxUnits.timer, /OnCalendar=08:15/)
  assert.match(linuxUnits.timer, /OnCalendar=21:45/)
  assert.doesNotMatch(linuxUnits.timer, /OnCalendar=09:00/)
})

test('normalizePathEnv prepends missing local and node bin directories once', () => {
  assert.equal(
    normalizePathEnv({
      pathEnv: '/usr/bin:/bin',
      homeDir: '/home/tokenboard',
      nodePath: '/opt/node/bin/node'
    }),
    '/home/tokenboard/.bun/bin:/home/tokenboard/.local/bin:/opt/node/bin:/usr/bin:/bin'
  )

  assert.equal(
    normalizePathEnv({
      pathEnv: '/home/tokenboard/.bun/bin:/home/tokenboard/.local/bin:/opt/node/bin:/usr/bin:/bin',
      homeDir: '/home/tokenboard',
      nodePath: '/opt/node/bin/node'
    }),
    '/home/tokenboard/.bun/bin:/home/tokenboard/.local/bin:/opt/node/bin:/usr/bin:/bin'
  )
})

test('normalizePathEnv preserves Windows PATH separators and drive letters', () => {
  assert.equal(
    normalizePathEnv({
      pathEnv: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      homeDir: 'C:\\Users\\tokenboard',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      delimiter: ';'
    }),
    'C:\\Users\\tokenboard\\.bun\\bin;C:\\Users\\tokenboard\\.local\\bin;C:\\Program Files\\nodejs;C:\\Windows\\System32'
  )
})

test('builds Windows scheduled task command with explicit runtime environment', () => {
  const args = buildWindowsTaskArgs({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Users\\mison\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\sync.mjs',
    packageManager: 'bun',
    pathEnv: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    homeDir: 'C:\\Users\\mison'
  })
  const taskCommand = args[args.indexOf('/TR') + 1]

  assert.match(taskCommand, /^cmd\.exe \/d \/s \/c /)
  assert.doesNotMatch(taskCommand, /""TOKENBOARD_/)
  assert.match(taskCommand, /TOKENBOARD_PACKAGE_MANAGER=bun/)
  assert.match(taskCommand, /TOKENBOARD_SCHEDULED_SYNC=1/)
  assert.match(taskCommand, /TOKENBOARD_LOG_DIR=C:\\Users\\mison\\.tokenboard\\logs/)
  assert.match(taskCommand, /PATH=C:\\Users\\mison\\.bun\\bin;C:\\Users\\mison\\.local\\bin;C:\\Program Files\\nodejs;C:\\Windows\\System32/)
  assert.match(taskCommand, /C:\\Program Files\\nodejs\\node\.exe/)
  assert.match(taskCommand, /C:\\Users\\mison\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\sync\.mjs/)
  assert.match(taskCommand, /--mode sync --source all --scheduled/)
})

test('builds Windows scheduled task args with a short wrapper command', () => {
  const args = buildWindowsTaskArgs({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Users\\mison\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\sync.mjs',
    taskCommand: '"C:\\Users\\mison\\.tokenboard\\tokenboard-daily-sync.cmd"'
  })
  const taskCommand = args[args.indexOf('/TR') + 1]

  assert.equal(taskCommand, '"C:\\Users\\mison\\.tokenboard\\tokenboard-daily-sync.cmd"')
  assert.ok(taskCommand.length < 261)
})

test('builds Windows scheduled sync wrapper script with explicit runtime environment', () => {
  const script = buildWindowsTaskScript({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Users\\mison\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\sync.mjs',
    packageManager: 'bun',
    pathEnv: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    homeDir: 'C:\\Users\\mison'
  })

  assert.match(script, /@echo off/)
  assert.match(script, /set "TOKENBOARD_PACKAGE_MANAGER=bun"/)
  assert.match(script, /set "TOKENBOARD_SCHEDULED_SYNC=1"/)
  assert.match(script, /set "TOKENBOARD_LOG_DIR=C:\\Users\\mison\\.tokenboard\\logs"/)
  assert.match(script, /set "PATH=C:\\Users\\mison\\.bun\\bin;C:\\Users\\mison\\.local\\bin;C:\\Program Files\\nodejs;C:\\Windows\\System32"/)
  assert.match(script, /"C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\mison\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\sync\.mjs" --mode sync --source all --scheduled/)
})
