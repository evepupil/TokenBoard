import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLinuxSystemdUnits,
  buildWindowsTaskArgs,
  normalizePathEnv
} from './schedule.mjs'

test('builds the existing Windows scheduled task shape', () => {
  const args = buildWindowsTaskArgs({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Users\\mison\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\sync.mjs'
  })

  assert.deepEqual(args, [
    '/Create',
    '/F',
    '/SC',
    'DAILY',
    '/TN',
    'TokenBoardDailySync',
    '/TR',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\mison\\.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\sync.mjs" --mode sync --source all',
    '/ST',
    '09:00'
  ])
})

test('builds Linux user systemd units with pnpm available in PATH', () => {
  const units = buildLinuxSystemdUnits({
    nodePath: '/usr/bin/node',
    scriptPath: '/home/mison/.tokenboard/TokenBoard/skills/tokenboard/scripts/sync.mjs',
    packageManager: 'pnpm',
    pathEnv: '/usr/bin:/bin',
    homeDir: '/home/mison'
  })

  assert.match(units.service, /Environment=TOKENBOARD_PACKAGE_MANAGER=pnpm/)
  assert.match(units.service, /Environment=PATH=\/home\/mison\/.bun\/bin:\/home\/mison\/.local\/bin:\/usr\/bin:\/bin/)
  assert.match(units.service, /ExecStart=\/usr\/bin\/node \/home\/mison\/.tokenboard\/TokenBoard\/skills\/tokenboard\/scripts\/sync.mjs --mode sync --source all/)
  assert.match(units.timer, /OnCalendar=09:00/)
  assert.match(units.timer, /OnCalendar=12:00/)
  assert.match(units.timer, /OnCalendar=18:00/)
  assert.match(units.timer, /OnCalendar=23:00/)
  assert.match(units.timer, /Persistent=true/)
})

test('normalizePathEnv prepends missing local and node bin directories once', () => {
  assert.equal(
    normalizePathEnv({
      pathEnv: '/usr/bin:/bin',
      homeDir: '/home/mison',
      nodePath: '/opt/node/bin/node'
    }),
    '/home/mison/.bun/bin:/home/mison/.local/bin:/opt/node/bin:/usr/bin:/bin'
  )

  assert.equal(
    normalizePathEnv({
      pathEnv: '/home/mison/.bun/bin:/home/mison/.local/bin:/opt/node/bin:/usr/bin:/bin',
      homeDir: '/home/mison',
      nodePath: '/opt/node/bin/node'
    }),
    '/home/mison/.bun/bin:/home/mison/.local/bin:/opt/node/bin:/usr/bin:/bin'
  )
})
