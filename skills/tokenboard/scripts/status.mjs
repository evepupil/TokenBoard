#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { configPath, readConfig } from './config.mjs'

const file = configPath()
if (!existsSync(file)) {
  console.log('TokenBoard is not configured.')
  process.exit(1)
}

const config = readConfig()
console.log(
  JSON.stringify(
    {
      configured: true,
      configPath: file,
      endpoint: config.endpoint,
      deviceId: config.deviceId,
      timezone: config.timezone,
      source: config.source,
      collectorDir: config.collectorDir
    },
    null,
    2
  )
)
