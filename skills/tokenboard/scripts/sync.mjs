#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  readConfig,
  parseArgs,
  collectorDir,
  packageManagerCommand,
  packageManagerRunArgs,
  readPackageManager
} from './config.mjs'

const flags = parseArgs(process.argv.slice(2))
const config = readConfig()
const mode = flags.mode || 'sync'
const source = flags.source || config.source || 'all'
const repoDir = config.collectorDir || collectorDir()
const packageManager = readPackageManager(flags, config)

if (!existsSync(repoDir)) {
  console.error(`TokenBoard collector is not installed: ${repoDir}`)
  console.error('Run setup.mjs again or run install-collector.mjs.')
  process.exit(1)
}

const env = {
  ...process.env,
  TOKENBOARD_ENDPOINT: config.endpoint,
  TOKENBOARD_UPLOAD_TOKEN: config.uploadToken,
  TOKENBOARD_TIMEZONE: config.timezone,
  TOKENBOARD_SOURCE: source,
  TOKENBOARD_PACKAGE_MANAGER: packageManager
}

const result = spawnSync(
  packageManagerCommand(packageManager),
  packageManagerRunArgs(packageManager, mode, ['--source', source]),
  {
    cwd: join(repoDir, 'packages', 'collector'),
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  }
)

process.exit(result.status ?? 1)
