import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  currentProcessStartIdentity,
  powershellCommand,
  probeProcessStartIdentity,
  tasklistCommand
} from './process-liveness.mjs'

function linuxStat(startTicks) {
  const fields = Array.from({ length: 19 }, (_, index) => (index === 18 ? String(startTicks) : String(index + 1)))
  return `123 (node) S ${fields.join(' ')}\n`
}

function darwinProcessInfo({ seconds, microseconds }) {
  const bytes = Buffer.alloc(136)
  bytes.writeBigUInt64LE(BigInt(seconds), 120)
  bytes.writeBigUInt64LE(BigInt(microseconds), 128)
  return bytes.toString('base64')
}

test('Linux process identity includes the system boot ID', () => {
  const files = new Map([
    ['/proc/123/stat', linuxStat(456789)],
    ['/proc/sys/kernel/random/boot_id', '01234567-89ab-cdef-0123-456789abcdef\n']
  ])

  assert.deepEqual(
    probeProcessStartIdentity(123, {
      platform: 'linux',
      readFile: (path) => files.get(path)
    }),
    { status: 'known', value: 'linux:01234567-89ab-cdef-0123-456789abcdef:456789' }
  )
})

test('Linux process identity is unknown when the boot ID cannot be read', () => {
  assert.deepEqual(
    probeProcessStartIdentity(123, {
      platform: 'linux',
      readFile: (path) =>
        path === '/proc/123/stat'
          ? linuxStat(456789)
          : (() => {
              const error = new Error('boot id unavailable')
              error.code = 'EACCES'
              throw error
            })()
    }),
    { status: 'unknown' }
  )
})

test('unknown process identity is not converted into a comparable fallback marker', () => {
  assert.equal(
    currentProcessStartIdentity({
      pid: 123,
      readProcessStartIdentity: () => ({ status: 'unknown' })
    }),
    undefined
  )
})

test('external process identity probes use a non-catchable timeout signal', () => {
  const calls = []
  const deadKill = () => {
    const error = new Error('process is not running')
    error.code = 'ESRCH'
    throw error
  }
  const runProcessIdentity = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 1, stdout: '', stderr: '' }
  }

  assert.deepEqual(probeProcessStartIdentity(123, { platform: 'darwin', runProcessIdentity, kill: deadKill }), {
    status: 'dead'
  })
  assert.deepEqual(probeProcessStartIdentity(456, { platform: 'win32', runProcessIdentity }), { status: 'unknown' })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.options.timeout, 2_000)
    assert.equal(call.options.killSignal, 'SIGKILL')
  }
})

test('Darwin process identity uses libproc microsecond start time', () => {
  const calls = []
  const result = probeProcessStartIdentity(123, {
    platform: 'darwin',
    runProcessIdentity: (command, args, options) => {
      calls.push({ command, args, options })
      return {
        status: 0,
        stdout: `${darwinProcessInfo({ seconds: 1_785_900_000, microseconds: 123456 })}\n`
      }
    }
  })

  assert.deepEqual(result, {
    status: 'known',
    value: 'darwin:1785900000:123456'
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/usr/bin/osascript')
  assert.equal(calls[0].args[0], '-l')
  assert.equal(calls[0].args[1], 'JavaScript')
  assert.match(calls[0].args[3], /proc_pidinfo/)
  assert.match(calls[0].args[3], /try \{ ObjC\.bindFunction\("proc_pidinfo", procPidInfoTypes\); \}/)
  assert.match(calls[0].args[3], /libproc\.dylib/)
  assert.equal(calls[0].options.timeout, 2_000)
  assert.equal(calls[0].options.killSignal, 'SIGKILL')
})

test('Darwin process identity rejects malformed native process data', () => {
  assert.deepEqual(
    probeProcessStartIdentity(123, {
      platform: 'darwin',
      runProcessIdentity: () => ({ status: 0, stdout: Buffer.alloc(136).toString('base64') })
    }),
    { status: 'unknown' }
  )
})

test('second-precision ps output is not treated as a unique process identity', () => {
  assert.deepEqual(
    probeProcessStartIdentity(123, {
      platform: 'freebsd',
      runProcessIdentity: () => ({
        status: 0,
        stdout: 'Wed Aug  5 18:00:00 2026\n'
      })
    }),
    { status: 'unknown' }
  )
})

test('Windows process identity distinguishes a missing pid from lookup failure', () => {
  const calls = []
  const runProcessIdentity = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: calls.length === 1 ? 3 : 4, stdout: '', stderr: '' }
  }

  assert.deepEqual(
    probeProcessStartIdentity(123, {
      platform: 'win32',
      runProcessIdentity,
      env: { SystemRoot: 'C:\\Windows' }
    }),
    { status: 'dead' }
  )
  assert.deepEqual(
    probeProcessStartIdentity(456, {
      platform: 'win32',
      runProcessIdentity,
      env: { SystemRoot: 'C:\\Windows' }
    }),
    { status: 'unknown' }
  )
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.match(call.args[3], /Get-Process -Id \d+ -ErrorAction Stop/)
    assert.match(call.args[3], /try \{/)
    assert.match(call.args[3], /catch \{/)
    assert.equal(call.options.killSignal, 'SIGKILL')
  }
})

test('Windows process identity resolves PowerShell from SystemRoot', () => {
  assert.equal(
    powershellCommand({ SystemRoot: 'D:\\Windows' }),
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  )
  assert.equal(
    powershellCommand({ SystemRoot: 'Windows' }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  )
  assert.equal(
    powershellCommand({ SystemRoot: '\\\\server\\share\\Windows' }),
    '\\\\server\\share\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  )
  assert.equal(
    tasklistCommand({ SystemRoot: '\\\\server\\share\\Windows' }),
    '\\\\server\\share\\Windows\\System32\\tasklist.exe'
  )
})

test(
  'process identity probe returns when the helper ignores termination',
  { skip: process.platform === 'win32' },
  () => {
    const startedAt = Date.now()
    const result = probeProcessStartIdentity(123, {
      platform: 'darwin',
      runProcessIdentity: (_command, _args, options) =>
        spawnSync(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], options)
    })

    assert.deepEqual(result, { status: 'unknown' })
    assert.ok(Date.now() - startedAt < 3_500)
  }
)
