import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readResourcePressure,
  parseMemoryPressureOutput,
  parseMeminfo,
  parsePsiIo,
  parseSwapUsage
} from './resource-pressure.mjs'

function darwin(overrides = {}) {
  return {
    platform: 'darwin',
    env: {},
    runCommand: (command, args) => {
      if (command === '/usr/bin/memory_pressure') return { stdout: 'System-wide memory free percentage: 62%\n' }
      if (command === '/usr/bin/sysctl')
        return { stdout: 'total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)\n' }
      return { stdout: '' }
    },
    loadAverage: () => [1, 1, 1],
    cpuCount: 8,
    ...overrides
  }
}

test('a healthy machine reports no pressure', () => {
  const result = readResourcePressure(darwin())
  assert.equal(result.enabled, true)
  assert.equal(result.pressured, false)
  assert.equal(result.metrics.memoryFreePercent, 62)
  assert.equal(result.metrics.swapUsedPercent, 25)
})

test('low free memory trips the guard', () => {
  const result = readResourcePressure(
    darwin({
      runCommand: () => ({ stdout: 'System-wide memory free percentage: 4%\n' })
    })
  )
  assert.equal(result.pressured, true)
  assert.equal(result.reason, 'memory')
  assert.match(result.detail, /memory free 4% < 10%/)
})

test('a nearly full swap trips the guard', () => {
  const result = readResourcePressure(
    darwin({
      runCommand: (command) =>
        command === '/usr/bin/memory_pressure'
          ? { stdout: 'System-wide memory free percentage: 40%\n' }
          : { stdout: 'total = 1000.00M  used = 950.00M  free = 50.00M  (encrypted)\n' }
    })
  )
  assert.equal(result.pressured, true)
  assert.equal(result.reason, 'swap')
})

test('a saturated machine trips the guard on load alone', () => {
  const result = readResourcePressure(darwin({ loadAverage: () => [80, 70, 60], cpuCount: 16 }))
  assert.equal(result.pressured, true)
  assert.equal(result.reason, 'load')
  assert.match(result.detail, /load 80 \(5\/cpu, 1m\) > 2\/cpu/)
})

test('Linux reads MemAvailable, swap and I/O PSI', () => {
  const files = {
    '/proc/meminfo': [
      'MemTotal:       16000000 kB',
      'MemFree:         1000000 kB',
      'MemAvailable:    8000000 kB',
      'SwapTotal:       8000000 kB',
      'SwapFree:        4000000 kB'
    ].join('\n'),
    '/proc/pressure/io': 'some avg10=75.12 avg60=40.00 avg300=10.00 total=1234\nfull avg10=10.00\n'
  }
  const result = readResourcePressure({
    platform: 'linux',
    env: {},
    readFile: (path) => files[path],
    loadAverage: () => [2, 2, 2],
    cpuCount: 8
  })
  assert.equal(result.pressured, true)
  assert.equal(result.reason, 'io')
  assert.equal(result.metrics.memoryFreePercent, 50)
  assert.equal(result.metrics.swapUsedPercent, 50)
  assert.equal(result.metrics.ioAvg10, 75.12)
})

test('Linux without PSI falls back to the other signals instead of failing', () => {
  const result = readResourcePressure({
    platform: 'linux',
    env: {},
    readFile: (path) => {
      if (path !== '/proc/meminfo') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return 'MemTotal:       1000000 kB\nMemAvailable:    900000 kB\n'
    },
    loadAverage: () => [0, 0, 0],
    cpuCount: 4
  })
  assert.equal(result.pressured, false)
  assert.equal(result.metrics.ioAvg10, undefined)
})

test('Windows reads available physical memory from the OS', () => {
  const result = readResourcePressure({
    platform: 'win32',
    env: {},
    freemem: () => 1 * 1024 ** 3,
    totalmem: () => 16 * 1024 ** 3,
    loadAverage: () => [0, 0, 0],
    cpuCount: 8
  })
  assert.equal(result.pressured, true)
  assert.equal(result.reason, 'memory')
  assert.equal(result.metrics.load1m, undefined)
})

test('an unreadable machine fails open', () => {
  const result = readResourcePressure({
    platform: 'darwin',
    env: {},
    runCommand: () => {
      throw new Error('probe exploded')
    },
    loadAverage: () => [0, 0, 0],
    cpuCount: 8
  })
  assert.equal(result.enabled, true)
  assert.equal(result.pressured, false)
  assert.equal(result.error, 'probe exploded')
})

test('TOKENBOARD_RESOURCE_GUARD=off disables the probe entirely', () => {
  const result = readResourcePressure(darwin({ env: { TOKENBOARD_RESOURCE_GUARD: 'off' } }))
  assert.equal(result.enabled, false)
  assert.equal(result.pressured, false)
})

test('invalid guard settings are rejected rather than silently ignored', () => {
  assert.throws(
    () => readResourcePressure(darwin({ env: { TOKENBOARD_RESOURCE_GUARD: 'maybe' } })),
    /must be 'on' or 'off'/
  )
  assert.throws(
    () => readResourcePressure(darwin({ env: { TOKENBOARD_RESOURCE_MEMORY_FREE_MIN_PERCENT: 'abc' } })),
    /integer percentage/
  )
  assert.throws(
    () => readResourcePressure(darwin({ env: { TOKENBOARD_RESOURCE_MEMORY_FREE_MIN_PERCENT: '150' } })),
    /integer percentage/
  )
})

test('thresholds are configurable', () => {
  const result = readResourcePressure(darwin({ env: { TOKENBOARD_RESOURCE_MEMORY_FREE_MIN_PERCENT: '70' } }))
  assert.equal(result.pressured, true)
  assert.equal(result.reason, 'memory')
})

test('parsers handle the real command formats', () => {
  assert.equal(parseMemoryPressureOutput('Pageouts: 656596\n\nSystem-wide memory free percentage: 80%\n'), 80)
  assert.equal(parseMemoryPressureOutput(''), undefined)
  assert.deepEqual(parseSwapUsage('total = 14.00G  used = 7.00G  free = 7.00G  (encrypted)'), {
    totalMib: 14336,
    usedMib: 7168,
    usedPercent: 50
  })
  assert.equal(parseSwapUsage('nonsense'), undefined)
  assert.deepEqual(parseMeminfo('MemTotal: 100 kB\nMemAvailable: 40 kB\nSwapTotal: 10 kB\nSwapFree: 5 kB'), {
    totalKb: 100,
    availableKb: 40,
    swapTotalKb: 10,
    swapFreeKb: 5
  })
  assert.equal(parsePsiIo('some avg10=3.5 avg60=0.0'), 3.5)
  assert.equal(parsePsiIo(''), undefined)
})
