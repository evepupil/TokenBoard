import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
    assert.deepEqual(harness.calls.map(commandLine), [`launchctl bootout gui/501 ${plistPath}`])
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
    assert.deepEqual(harness.errors, [])
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

    assert.equal(harness.errors.length, 1)
    assert.match(harness.errors[0], /TokenBoard config could not be read \(missing config\)/)
    assert.deepEqual(harness.calls.map(commandLine), [
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command Get-ScheduledTask -TaskPath '\\' | Where-Object { ($_.TaskName -like 'TokenBoardDailySync*') -or ($_.Actions | Where-Object { $_.Execute -like '*node*' -and $_.Arguments -like '*TokenBoard*skills*tokenboard*scripts*sync.mjs*' }) } | Unregister-ScheduledTask -Confirm:$false"
    ])
  } finally {
    harness.cleanup()
  }
})

// `allowFailure` keeps a non-zero exit from aborting the uninstall, but it must not be
// silent: `uninstall` reports the schedule as removed either way, and a swallowed failure
// would leave the task registered with no trace.
test('reports a failed Windows scheduled-task cleanup instead of swallowing it', () => {
  const harness = createHarness('win32')
  try {
    const spawned = []
    harness.options.spawn = (command, args) => {
      spawned.push([command, ...args].join(' '))
      return { status: 1, error: undefined }
    }

    uninstallSchedule(harness.options)

    assert.match(harness.errors[0], /TokenBoard scheduled-task cleanup failed/)
    assert.match(harness.errors[0], /exit code 1/)
    assert.deepEqual(spawned, [
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command Get-ScheduledTask -TaskPath '\\' | Where-Object { ($_.TaskName -like 'TokenBoardDailySync*') -or ($_.Actions | Where-Object { $_.Execute -like '*node*' -and $_.Arguments -like '*TokenBoard*skills*tokenboard*scripts*sync.mjs*' }) } | Unregister-ScheduledTask -Confirm:$false"
    ])
  } finally {
    harness.cleanup()
  }
})

// A host whose `launchctl` is missing still has a plist to delete, and aborting before the
// `rm` would leave the schedule registered while the uninstall reported failure. The ENOENT
// guard must therefore stay scoped to commands that were not allowed to fail.
test('removes the macOS LaunchAgent even when launchctl is missing', () => {
  const harness = createHarness('darwin')
  try {
    const plistPath = join(harness.homeDir, 'Library', 'LaunchAgents', 'com.tokenboard.daily-sync.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, '<plist/>')
    harness.options.spawn = () => ({ status: null, error: { code: 'ENOENT' } })

    uninstallSchedule(harness.options)

    assert.equal(existsSync(plistPath), false)
    assert.deepEqual(harness.errors, [])
  } finally {
    harness.cleanup()
  }
})

// Same rule as Windows: the macOS path unlinks the plist regardless, so a
// failed `launchctl bootout` (a permission problem, a corrupted job) would
// otherwise be reported as a clean removal while the job kept running. Exit 3
// is the exception: it means the job was not loaded (nothing to remove), which
// its own test covers.
test('reports a failed launchctl bootout instead of swallowing it', () => {
  const harness = createHarness('darwin')
  try {
    const plistPath = join(harness.homeDir, 'Library', 'LaunchAgents', 'com.tokenboard.daily-sync.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, '<plist/>')
    harness.options.spawn = () => ({ status: 1, error: undefined })

    uninstallSchedule(harness.options)

    assert.equal(existsSync(plistPath), false)
    assert.equal(harness.errors.length, 1)
    assert.match(harness.errors[0], /launchctl bootout/)
    assert.match(harness.errors[0], /exit code 1/)
  } finally {
    harness.cleanup()
  }
})

test('treats a not-loaded launchctl bootout (exit 3) as a clean removal', () => {
  // `launchctl bootout` exits 3 ("No such process") when the job is not loaded.
  // An uninstall with nothing to remove must not print "the LaunchAgent may
  // still be running" — that contradicts the "removed" line it prints next.
  const harness = createHarness('darwin')
  try {
    const plistPath = join(harness.homeDir, 'Library', 'LaunchAgents', 'com.tokenboard.daily-sync.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, '<plist/>')
    harness.options.spawn = () => ({ status: 3, error: undefined })

    uninstallSchedule(harness.options)

    assert.equal(existsSync(plistPath), false)
    assert.deepEqual(harness.errors, [])
  } finally {
    harness.cleanup()
  }
})

// The two systemctl calls are independent: `disable --now` failing must not
// stop the unit files from being removed or the reload from being attempted,
// and the reload failure is reported on its own.
test('reports failed systemctl disable and daemon-reload instead of swallowing them', () => {
  const harness = createHarness('linux')
  try {
    const unitDir = join(harness.homeDir, '.config', 'systemd', 'user')
    mkdirSync(unitDir, { recursive: true })
    writeFileSync(join(unitDir, 'tokenboard-daily-sync.service'), 'service')
    writeFileSync(join(unitDir, 'tokenboard-daily-sync.timer'), 'timer')
    harness.options.spawn = (command, args) => {
      harness.calls.push({ command, args })
      return { status: 1, error: undefined }
    }

    uninstallSchedule(harness.options)

    // Files are still removed and every call still ran, including the is-active
    // probe that decides whether the failed disable removed anything.
    assert.equal(existsSync(join(unitDir, 'tokenboard-daily-sync.service')), false)
    assert.equal(existsSync(join(unitDir, 'tokenboard-daily-sync.timer')), false)
    assert.equal(harness.calls.length, 3)
    assert.equal(harness.errors.length, 2)
    assert.match(harness.errors[0], /systemctl --user disable --now tokenboard-daily-sync\.timer/)
    assert.match(harness.errors[1], /systemctl --user daemon-reload/)
  } finally {
    harness.cleanup()
  }
})

test('does not report a disable failure when the timer is not loaded', () => {
  // No unit files exist and the timer is not loaded, so `systemctl disable
  // --now` reports "Unit ... not loaded" (non-zero) and `is-active` answers 3
  // (inactive) — the timer was never installed. Only the daemon-reload failure,
  // which is independent of presence, is worth reporting.
  const harness = createHarness('linux')
  try {
    harness.options.spawn = (command, args) => {
      harness.calls.push({ command, args })
      return { status: args.includes('is-active') ? 3 : 1, error: undefined }
    }

    uninstallSchedule(harness.options)

    assert.equal(harness.errors.length, 1)
    assert.match(harness.errors[0], /systemctl --user daemon-reload/)
  } finally {
    harness.cleanup()
  }
})

// A missing unit file does not mean the timer is gone: the files can be deleted
// while systemd still holds and runs the loaded unit, and `disable` then fails
// on the missing file. Reporting "removed" from file absence alone would leave
// the timer firing with no trace; the is-active probe tells the two apart.
test('reports a disable failure when the unit files are gone but the timer is still active', () => {
  const harness = createHarness('linux')
  try {
    harness.options.spawn = (command, args) => {
      harness.calls.push({ command, args })
      // disable fails on the missing file, the probe finds the timer active,
      // and the reload succeeds so only the disable failure is reported.
      if (args.includes('is-active')) return { status: 0, error: undefined }
      return { status: args.includes('disable') ? 1 : 0, error: undefined }
    }

    uninstallSchedule(harness.options)

    assert.equal(harness.errors.length, 1)
    assert.match(harness.errors[0], /systemctl --user disable --now tokenboard-daily-sync\.timer/)
    assert.match(harness.errors[0], /the timer may still be enabled/)
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
  const errors = []
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, '{}')
  return {
    homeDir,
    configPath,
    calls,
    errors,
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
      error: (line) => {
        errors.push(line)
      },
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
