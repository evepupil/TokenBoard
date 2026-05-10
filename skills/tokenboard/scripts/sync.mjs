#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  readConfig,
  parseArgs,
  collectorDir,
  packageManagerCommand,
  packageManagerRunArgs,
  readPackageManager
} from './config.mjs'
import { normalizePathEnv } from './schedule.mjs'
import { readSince } from './sync-options.mjs'

if (isMain()) {
  const flags = parseArgs(process.argv.slice(2))
  const config = readConfig()
  const invocation = buildSyncInvocation({
    flags,
    config,
    pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    homeDir: homedir(),
    nodePath: process.execPath,
    platform: process.platform
  })

  if (!existsSync(invocation.repoDir)) {
    console.error(`TokenBoard collector is not installed: ${invocation.repoDir}`)
    console.error('Run setup.mjs again or run install-collector.mjs.')
    process.exit(1)
  }

  const result = spawnSync(
    invocation.command,
    invocation.args,
    {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: 'inherit',
      shell: invocation.shell
    }
  )

  if (result.error) {
    console.error(`Failed to run ${invocation.command}: ${result.error.message}`)
    process.exit(1)
  }

  process.exit(result.status ?? 1)
}

export function buildSyncInvocation({
  flags = {},
  config,
  env = process.env,
  pathEnv = env.PATH || '/usr/local/bin:/usr/bin:/bin',
  homeDir = homedir(),
  nodePath = process.execPath,
  platform = process.platform
}) {
  const mode = flags.mode || 'sync'
  const source = flags.source || config.source || 'all'
  const repoDir = config.collectorDir || collectorDir()
  const packageManager = readPackageManager(flags, config)
  const since = readSince({ flags, config, env })
  const delimiter = platform === 'win32' ? ';' : ':'
  return {
    command: packageManagerCommand(packageManager, platform),
    args: packageManagerRunArgs(packageManager, mode, ['--source', source]),
    cwd: join(repoDir, 'packages', 'collector'),
    repoDir,
    shell: platform === 'win32' && packageManager !== 'bun',
    env: {
      ...env,
      PATH: normalizePathEnv({
        pathEnv,
        homeDir,
        nodePath,
        delimiter
      }),
      TOKENBOARD_ENDPOINT: config.endpoint,
      TOKENBOARD_UPLOAD_TOKEN: config.uploadToken,
      TOKENBOARD_TIMEZONE: config.timezone,
      TOKENBOARD_SOURCE: source,
      TOKENBOARD_PACKAGE_MANAGER: packageManager,
      TOKENBOARD_DEFAULT_SINCE: since
    }
  }
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}
