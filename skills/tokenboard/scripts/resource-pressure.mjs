import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'

// A hook run is an opportunistic sync: it costs one full scan of the user's history
// (measured at 4.6-7.6 GB resident on real machines) and the scheduled sync collects the
// same usage anyway. Starting that scan on a machine that is already out of memory or
// thrashing is how a two-minute sync turns into a 26-minute one that fails on the way out
// (2026-11-24: TLS handshake timeout after 26.4 minutes under 37.9 GB of compressed memory).
// This module answers one question — is the machine in a state where a scan should wait? —
// with cheap, read-only probes, and fails open: an unreadable metric never stops a sync.
export const defaultMemoryFreeMinPercent = 10
export const defaultSwapUsedMaxPercent = 90
export const defaultIoAvg10Max = 60
// Load average counts runnable plus uninterruptible (disk wait) processes, so this is the
// one signal that covers CPU and I/O contention on macOS, where there is no PSI. Two per
// CPU is the point where a scan competes with the machine instead of sharing it.
export const defaultLoadPerCpuMax = 2

export function readResourcePressure({
  platform = process.platform,
  env = process.env,
  runCommand = defaultRunCommand,
  readFile = (path) => readFileSync(path, 'utf8'),
  loadAverage = () => os.loadavg(),
  cpuCount = os.cpus().length,
  freemem = () => os.freemem(),
  totalmem = () => os.totalmem()
} = {}) {
  if (!isGuardEnabled(env)) {
    return { enabled: false, pressured: false, detail: 'resource guard disabled' }
  }
  const memoryFreeMin = readPercentEnv(env, 'TOKENBOARD_RESOURCE_MEMORY_FREE_MIN_PERCENT', defaultMemoryFreeMinPercent)
  const swapUsedMax = readPercentEnv(env, 'TOKENBOARD_RESOURCE_SWAP_USED_MAX_PERCENT', defaultSwapUsedMaxPercent)
  const ioAvg10Max = readPercentEnv(env, 'TOKENBOARD_RESOURCE_IO_AVG10_MAX', defaultIoAvg10Max)

  const metrics = { platform }
  try {
    if (platform === 'darwin') {
      collectDarwinMetrics(metrics, runCommand)
    } else if (platform === 'win32') {
      // Node reads GlobalMemoryStatusEx on Windows, so `freemem` is the available physical
      // memory there. It must not be used on macOS or Linux, where it reports free pages
      // rather than reclaimable memory and reads as near-zero on a healthy machine.
      collectWindowsMetrics(metrics, freemem, totalmem)
    } else {
      collectLinuxMetrics(metrics, readFile)
    }
    collectLoadMetrics(metrics, loadAverage, cpuCount)
  } catch (error) {
    // Fail open. A probe that cannot read the machine is not evidence of pressure, and the
    // scan has no other backstop if every hook run started refusing to run.
    return { enabled: true, pressured: false, error: errorMessage(error), metrics }
  }

  const breaches = []
  if (metrics.memoryFreePercent !== undefined && metrics.memoryFreePercent < memoryFreeMin) {
    breaches.push({
      reason: 'memory',
      text: `memory free ${formatPercent(metrics.memoryFreePercent)}% < ${memoryFreeMin}%`
    })
  }
  if (metrics.swapUsedPercent !== undefined && metrics.swapUsedPercent >= swapUsedMax) {
    breaches.push({
      reason: 'swap',
      text: `swap used ${formatPercent(metrics.swapUsedPercent)}% >= ${swapUsedMax}%`
    })
  }
  if (metrics.ioAvg10 !== undefined && metrics.ioAvg10 >= ioAvg10Max) {
    breaches.push({ reason: 'io', text: `io pressure ${formatPercent(metrics.ioAvg10)} >= ${ioAvg10Max}` })
  }
  if (metrics.loadPerCpu !== undefined && metrics.loadPerCpu > defaultLoadPerCpuMax) {
    breaches.push({
      reason: 'load',
      text: `load ${formatPercent(metrics.load1m)} (${formatPercent(metrics.loadPerCpu)}/cpu, 1m) > ${defaultLoadPerCpuMax}/cpu`
    })
  }

  return {
    enabled: true,
    pressured: breaches.length > 0,
    ...(breaches.length > 0
      ? { reason: breaches[0].reason, detail: breaches.map((breach) => breach.text).join('; ') }
      : {}),
    metrics
  }
}

// Production wiring: notify.mjs's main block builds this probe and hands it to the
// coordinator, so every hook-triggered sync (including the trailing retries) is gated.
export function createResourcePressureProbe(options = {}) {
  return () => readResourcePressure(options)
}

function isGuardEnabled(env) {
  const value = env?.TOKENBOARD_RESOURCE_GUARD
  if (value === undefined || value === '') return true
  if (value === 'off') return false
  if (value === 'on') return true
  throw new Error("TOKENBOARD_RESOURCE_GUARD must be 'on' or 'off'")
}

// Invalid thresholds throw rather than silently falling back, matching how the other hook
// env knobs are read: a typo should be visible in the run log, not quietly change behaviour.
function readPercentEnv(env, name, fallback) {
  const raw = env?.[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be an integer percentage between 1 and 99`)
  const value = Number(raw)
  if (value > 99) throw new Error(`${name} must be an integer percentage between 1 and 99`)
  return value
}

function collectDarwinMetrics(metrics, runCommand) {
  const memory = runCommand('/usr/bin/memory_pressure', [])
  const freePercent = parseMemoryPressureOutput(memory?.stdout)
  if (freePercent !== undefined) metrics.memoryFreePercent = freePercent

  const swap = runCommand('/usr/bin/sysctl', ['-n', 'vm.swapusage'])
  const swapUsage = parseSwapUsage(swap?.stdout)
  if (swapUsage) {
    metrics.swapUsedPercent = swapUsage.usedPercent
    metrics.swapTotalMib = swapUsage.totalMib
  }
}

function collectLinuxMetrics(metrics, readFile) {
  const meminfo = parseMeminfo(readFile('/proc/meminfo'))
  if (meminfo.totalKb > 0) {
    metrics.memoryFreePercent = (meminfo.availableKb / meminfo.totalKb) * 100
  }
  if (meminfo.swapTotalKb > 0) {
    metrics.swapUsedPercent = ((meminfo.swapTotalKb - meminfo.swapFreeKb) / meminfo.swapTotalKb) * 100
    metrics.swapTotalMib = meminfo.swapTotalKb / 1024
  }
  // PSI (kernel 4.20+, cgroup v2 hosts) is the only direct I/O contention signal here. When
  // the file is absent the rule simply does not apply; a missing signal is not pressure.
  let psi
  try {
    psi = parsePsiIo(readFile('/proc/pressure/io'))
  } catch {
    psi = undefined
  }
  if (psi !== undefined) metrics.ioAvg10 = psi
}

function collectWindowsMetrics(metrics, freemem, totalmem) {
  const total = totalmem()
  if (!(total > 0)) return
  metrics.memoryFreePercent = (freemem() / total) * 100
}

function collectLoadMetrics(metrics, loadAverage, cpuCount) {
  const load = loadAverage()
  // Windows reports [0, 0, 0] because it has no load average; a real zero-load machine is
  // possible too, so the signal is only recorded when it is actually measured.
  if (!Array.isArray(load) || !Number.isFinite(load[0]) || load[0] <= 0) return
  if (!Number.isSafeInteger(cpuCount) || cpuCount <= 0) return
  metrics.load1m = load[0]
  metrics.loadPerCpu = load[0] / cpuCount
  metrics.cpuCount = cpuCount
}

export function parseMemoryPressureOutput(stdout) {
  const match = /System-wide memory free percentage:\s*([\d.]+)%/.exec(String(stdout ?? ''))
  return match ? Number(match[1]) : undefined
}

// `sysctl -n vm.swapusage` prints e.g.
// `total = 14336.00M  used = 13273.25M  free = 1062.75M  (encrypted)`.
export function parseSwapUsage(stdout) {
  const text = String(stdout ?? '')
  const total = /total\s*=\s*([\d.]+)([MG])/.exec(text)
  const used = /used\s*=\s*([\d.]+)([MG])/.exec(text)
  if (!total || !used) return undefined
  const totalMib = toMib(total[1], total[2])
  const usedMib = toMib(used[1], used[2])
  if (!(totalMib > 0)) return undefined
  return { totalMib, usedMib, usedPercent: (usedMib / totalMib) * 100 }
}

export function parseMeminfo(text) {
  const value = (key) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(String(text ?? ''))
    return match ? Number(match[1]) : undefined
  }
  const totalKb = value('MemTotal') ?? 0
  // MemFree is not usable as "available": page cache counts toward it. MemAvailable is the
  // kernel's own estimate and is the only number that tracks memory pressure here.
  const availableKb = value('MemAvailable') ?? value('MemFree') ?? 0
  return {
    totalKb,
    availableKb,
    swapTotalKb: value('SwapTotal') ?? 0,
    swapFreeKb: value('SwapFree') ?? 0
  }
}

// `/proc/pressure/io`: `some avg10=12.34 avg60=... avg300=... total=...`. `some` is the share
// of wall time at least one task was stalled on I/O — the same shape as memory PSI.
export function parsePsiIo(text) {
  const match = /some avg10=([\d.]+)/.exec(String(text ?? ''))
  return match ? Number(match[1]) : undefined
}

function toMib(value, unit) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return unit === 'G' ? number * 1024 : number
}

function formatPercent(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function defaultRunCommand(command, args) {
  // Bound the probe: a wedged sysctl must not hold the hook worker, and this runs before a
  // scan that is itself up to 30 minutes long, so a few seconds are affordable here.
  return spawnSync(command, args, { encoding: 'utf8', timeout: 4_000, windowsHide: true })
}
