import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildWindowsStaleTaskCleanupArgs, installSchedule } from './install-schedule.mjs'

test('installs macOS LaunchAgent through an isolated launchctl harness', () => {
  const harness = createHarness('darwin')
  try {
    const result = installSchedule({
      ...harness.options,
      argv: ['--schedule-times', '08:15,21:45']
    })

    const plistPath = join(harness.homeDir, 'Library', 'LaunchAgents', 'com.tokenboard.daily-sync.plist')
    assert.equal(result.plistPath, plistPath)
    assert.equal(existsSync(plistPath), true)
    const plist = readFileSync(plistPath, 'utf8')
    assert.match(plist, /<integer>8<\/integer>/)
    assert.match(plist, /<integer>15<\/integer>/)
    assert.match(plist, /<integer>21<\/integer>/)
    assert.match(plist, /<integer>45<\/integer>/)
    assert.deepEqual(harness.calls.map(commandLine), [
      'launchctl --version',
      `launchctl bootout gui/501 ${plistPath}`,
      `launchctl bootstrap gui/501 ${plistPath}`,
      'launchctl enable gui/501/com.tokenboard.daily-sync'
    ])
  } finally {
    harness.cleanup()
  }
})

test('installs Linux user systemd timer through an isolated systemd harness', () => {
  const harness = createHarness('linux')
  try {
    installSchedule({
      ...harness.options,
      argv: ['--schedule-times', '08:15,21:45']
    })

    const unitDir = join(harness.homeDir, '.config', 'systemd', 'user')
    const service = readFileSync(join(unitDir, 'tokenboard-daily-sync.service'), 'utf8')
    const timer = readFileSync(join(unitDir, 'tokenboard-daily-sync.timer'), 'utf8')
    assert.match(service, /Environment=TOKENBOARD_PACKAGE_MANAGER=pnpm/)
    assert.match(timer, /OnCalendar=08:15/)
    assert.match(timer, /OnCalendar=21:45/)
    assert.doesNotMatch(timer, /OnCalendar=09:00/)
    assert.deepEqual(harness.calls.map(commandLine), [
      'systemctl --user --version',
      'systemctl --user daemon-reload',
      'systemctl --user enable --now tokenboard-daily-sync.timer',
      'loginctl --version',
      'loginctl enable-linger tokenboard-test'
    ])
  } finally {
    harness.cleanup()
  }
})

test('installs Linux timer when USER is not exported', () => {
  const harness = createHarness('linux')
  try {
    delete harness.options.env.USER
    harness.options.env.LOGNAME = 'tokenboard-logname'

    installSchedule({
      ...harness.options,
      argv: ['--schedule-times', '08:15']
    })

    assert.deepEqual(harness.calls.map(commandLine), [
      'systemctl --user --version',
      'systemctl --user daemon-reload',
      'systemctl --user enable --now tokenboard-daily-sync.timer',
      'loginctl --version',
      'loginctl enable-linger tokenboard-logname'
    ])
  } finally {
    harness.cleanup()
  }
})

test('creates Windows scheduled tasks through an isolated schtasks harness', () => {
  const harness = createHarness('win32')
  try {
    installSchedule({
      ...harness.options,
      argv: ['--schedule-times', '08:15,21:45']
    })

    const calls = harness.calls.map(commandLine)
    assert.equal(calls[0], 'schtasks.exe --version')
    assert.match(calls[1], /schtasks\.exe \/Create \/F \/SC DAILY \/TN TokenBoardDailySync0815 \/TR cmd\.exe \/d \/s \/c/)
    assert.match(calls[1], /TOKENBOARD_PACKAGE_MANAGER=pnpm/)
    assert.match(calls[1], /TOKENBOARD_SCHEDULED_SYNC=1/)
    assert.doesNotMatch(calls[1], /""TOKENBOARD_/)
    assert.match(calls[1], /TOKENBOARD_LOG_DIR=/)
    assert.match(calls[1], /PATH=/)
    assert.match(calls[1], /node-test/)
    assert.match(calls[1], /sync-test\.mjs/)
    assert.match(calls[1], /--mode sync --source all --scheduled" \/ST 08:15/)
    assert.match(calls[2], /TokenBoardDailySync2145/)
    assert.match(calls[2], /--scheduled" \/ST 21:45/)
    assert.equal(calls[3], "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $current = @('TokenBoardDailySync0815','TokenBoardDailySync2145'); Get-ScheduledTask -TaskPath '\\' | Where-Object { (($_.TaskName -like 'TokenBoardDailySync*') -or ($_.Actions | Where-Object { $_.Execute -like '*node*' -and $_.Arguments -like '*TokenBoard*skills*tokenboard*scripts*sync.mjs*' })) -and $current -notcontains $_.TaskName } | Unregister-ScheduledTask -Confirm:$false")
  } finally {
    harness.cleanup()
  }
})

test('builds Windows stale task cleanup for all TokenBoard task names outside the current schedule', () => {
  const args = buildWindowsStaleTaskCleanupArgs(['09:00', '12:00'])
  const command = args.at(-1)

  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-ExecutionPolicy', 'Bypass'])
  assert.match(command, /\$current = @\('TokenBoardDailySync0900','TokenBoardDailySync1200'\)/)
  assert.match(command, /Get-ScheduledTask -TaskPath '\\'/)
  assert.match(command, /\$_.TaskName -like 'TokenBoardDailySync\*'/)
  assert.match(command, /\$_.Actions \| Where-Object/)
  assert.match(command, /\$_.Execute -like '\*node\*'/)
  assert.match(command, /\$_.Arguments -like '\*TokenBoard\*skills\*tokenboard\*scripts\*sync\.mjs\*'/)
  assert.match(command, /\$current -notcontains \$_.TaskName/)
  assert.match(command, /Unregister-ScheduledTask -Confirm:\$false/)
})

function createHarness(platform) {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-schedule-test-'))
  const homeDir = join(root, 'home')
  const configDir = join(root, 'config')
  const calls = []
  return {
    homeDir,
    calls,
    options: {
      platform,
      homeDir,
      configDir,
      nodePath: 'node-test',
      scriptPath: 'sync-test.mjs',
      getUid: () => 501,
      env: {
        PATH: '/usr/bin:/bin',
        USER: 'tokenboard-test'
      },
      readConfig: () => ({ packageManager: 'pnpm' }),
      log: () => {},
      spawn: (command, args) => {
        calls.push({ command, args })
        return { status: 0 }
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function commandLine(call) {
  return [call.command, ...call.args].join(' ')
}
