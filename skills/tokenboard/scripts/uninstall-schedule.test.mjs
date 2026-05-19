import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildWindowsScheduleCleanupArgs, uninstallSchedule } from './uninstall-schedule.mjs'

test('removes macOS LaunchAgent without deleting config', () => {
  const harness = createHarness('darwin', { scheduleTimes: ['08:15', '21:45'] })
  try {
    const plistPath = join(harness.homeDir, 'Library', 'LaunchAgents', 'com.tokenboard.daily-sync.plist')
    mkdirSync(join(harness.homeDir, 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(plistPath, 'plist')

    const result = uninstallSchedule(harness.options)

    assert.equal(result.plistPath, plistPath)
    assert.equal(existsSync(plistPath), false)
    assert.equal(readFileSync(harness.configPath, 'utf8'), '{}')
    assert.deepEqual(harness.calls.map(commandLine), [
      `launchctl bootout gui/501 ${plistPath}`
    ])
  } finally {
    harness.cleanup()
  }
})

test('removes Linux user systemd units without deleting config', () => {
  const harness = createHarness('linux', { scheduleTimes: ['08:15', '21:45'] })
  try {
    const unitDir = join(harness.homeDir, '.config', 'systemd', 'user')
    mkdirSync(unitDir, { recursive: true })
    writeFileSync(join(unitDir, 'tokenboard-daily-sync.service'), 'service')
    writeFileSync(join(unitDir, 'tokenboard-daily-sync.timer'), 'timer')

    uninstallSchedule(harness.options)

    assert.equal(existsSync(join(unitDir, 'tokenboard-daily-sync.service')), false)
    assert.equal(existsSync(join(unitDir, 'tokenboard-daily-sync.timer')), false)
    assert.equal(readFileSync(harness.configPath, 'utf8'), '{}')
    assert.deepEqual(harness.calls.map(commandLine), [
      'systemctl --user disable --now tokenboard-daily-sync.timer',
      'systemctl --user daemon-reload'
    ])
  } finally {
    harness.cleanup()
  }
})

test('removes Windows scheduled tasks for configured times and legacy name', () => {
  const harness = createHarness('win32', { scheduleTimes: ['08:15', '21:45'] })
  try {
    const result = uninstallSchedule(harness.options)

    assert.deepEqual(result.scheduleTimes, ['08:15', '21:45'])
    assert.deepEqual(harness.calls.map(commandLine), [
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command Get-ScheduledTask -TaskPath '\\' | Where-Object { ($_.TaskName -like 'TokenBoardDailySync*') -or ($_.Actions | Where-Object { $_.Execute -like '*node*' -and $_.Arguments -like '*TokenBoard*skills*tokenboard*scripts*sync.mjs*' }) } | Unregister-ScheduledTask -Confirm:$false"
    ])
  } finally {
    harness.cleanup()
  }
})

test('removes default Windows scheduled tasks when config is missing', () => {
  const harness = createHarness('win32')
  try {
    harness.options.readConfig = () => {
      throw new Error('missing config')
    }

    uninstallSchedule(harness.options)

    assert.deepEqual(harness.calls.map(commandLine), [
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command Get-ScheduledTask -TaskPath '\\' | Where-Object { ($_.TaskName -like 'TokenBoardDailySync*') -or ($_.Actions | Where-Object { $_.Execute -like '*node*' -and $_.Arguments -like '*TokenBoard*skills*tokenboard*scripts*sync.mjs*' }) } | Unregister-ScheduledTask -Confirm:$false"
    ])
  } finally {
    harness.cleanup()
  }
})

test('ignores invalid configured Windows schedule times during uninstall', () => {
  const harness = createHarness('win32', { scheduleTimes: ['08:15', '9:00', 1200, '24:00', '21:45'] })
  try {
    const result = uninstallSchedule(harness.options)

    assert.deepEqual(result.scheduleTimes, ['08:15', '21:45'])
  } finally {
    harness.cleanup()
  }
})

test('builds Windows schedule cleanup for every TokenBoard scheduled task name', () => {
  const args = buildWindowsScheduleCleanupArgs()
  const command = args.at(-1)

  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-ExecutionPolicy', 'Bypass'])
  assert.match(command, /Get-ScheduledTask -TaskPath '\\'/)
  assert.match(command, /\$_.TaskName -like 'TokenBoardDailySync\*'/)
  assert.match(command, /\$_.Actions \| Where-Object/)
  assert.match(command, /\$_.Execute -like '\*node\*'/)
  assert.match(command, /\$_.Arguments -like '\*TokenBoard\*skills\*tokenboard\*scripts\*sync\.mjs\*'/)
  assert.match(command, /Unregister-ScheduledTask -Confirm:\$false/)
  assert.doesNotMatch(command, /TokenBoardDailySync0900/)
})

function createHarness(platform, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-uninstall-schedule-test-'))
  const homeDir = join(root, 'home')
  const configDir = join(root, 'config')
  const configPath = join(configDir, 'config.json')
  const calls = []
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, '{}')
  return {
    homeDir,
    configPath,
    calls,
    options: {
      platform,
      homeDir,
      configDir,
      getUid: () => 501,
      env: {
        PATH: '/usr/bin:/bin'
      },
      readConfig: () => config,
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
