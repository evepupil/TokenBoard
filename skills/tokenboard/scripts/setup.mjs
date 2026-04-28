#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hostname, platform } from 'node:os'
import { parseArgs, writeConfig } from './config.mjs'

const flags = parseArgs(process.argv.slice(2))
const pairingCode = flags['pairing-code'] || process.env.TOKENBOARD_PAIRING_CODE
const baseUrl = String(flags['base-url'] || process.env.TOKENBOARD_BASE_URL || 'https://tokenboard.chaosyn.com').replace(/\/$/, '')
const timezone = flags.timezone || process.env.TOKENBOARD_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone
const deviceName = flags['device-name'] || `${hostname()} ${platform()}`

if (!pairingCode) {
  console.error('Missing --pairing-code')
  process.exit(1)
}

const response = await fetch(`${baseUrl}/api/v1/device/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    pairingCode,
    deviceName,
    platform: platform(),
    timezone
  })
})

if (!response.ok) {
  console.error(`Pairing failed with status ${response.status}: ${await response.text()}`)
  process.exit(1)
}

const paired = await response.json()
writeConfig({
  endpoint: paired.endpoint,
  uploadToken: paired.uploadToken,
  deviceId: paired.deviceId,
  timezone: paired.timezone,
  source: 'all',
  createdAt: new Date().toISOString()
})
console.log('TokenBoard config written.')

function scriptPath(name) {
  return fileURLToPath(new URL(name, import.meta.url))
}

if (!flags['skip-collector']) {
  const installCollector = spawnSync(process.execPath, [scriptPath('./install-collector.mjs')], {
    stdio: 'inherit'
  })
  if (installCollector.status !== 0) process.exit(installCollector.status ?? 1)
}

if (!flags['skip-schedule']) {
  const schedule = spawnSync(process.execPath, [scriptPath('./install-schedule.mjs')], {
    stdio: 'inherit'
  })
  if (schedule.status !== 0) process.exit(schedule.status ?? 1)
}

if (!flags['skip-initial-sync']) {
  const sync = spawnSync(process.execPath, [scriptPath('./sync.mjs'), '--mode', 'sync', '--source', 'all'], {
    stdio: 'inherit'
  })
  if (sync.status !== 0) process.exit(sync.status ?? 1)
}
