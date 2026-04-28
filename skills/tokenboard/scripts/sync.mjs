#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readConfig, parseArgs, collectorDir } from './config.mjs'

const flags = parseArgs(process.argv.slice(2))
const config = readConfig()
const mode = flags.mode || 'sync'
const source = flags.source || config.source || 'all'
const repoDir = config.collectorDir || collectorDir()

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
  TOKENBOARD_SOURCE: source
}

const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['--filter', '@tokenboard/collector', mode, '--', '--source', source],
  {
    cwd: repoDir,
    env,
    stdio: 'inherit',
    shell: false
  }
)

process.exit(result.status ?? 1)
