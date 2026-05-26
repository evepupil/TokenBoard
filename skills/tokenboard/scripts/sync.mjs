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
  readPackageManager
} from './config.mjs'
import { normalizePathEnv } from './schedule.mjs'
import { readSince } from './sync-options.mjs'
import { closeScheduledLogRuntime, createScheduledLogRuntime } from './logs.mjs'
import { runUpgrade } from './upgrade.mjs'

if (isMain()) {
  const flags = parseArgs(process.argv.slice(2))
  const config = readConfig()
  const homeDir = homedir()
  const invocation = buildSyncInvocation({
    flags,
    config,
    pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    homeDir,
    nodePath: process.execPath,
    platform: process.platform
  })
  const logs = createScheduledLogRuntime({
    env: process.env,
    homeDir,
    scheduled: flags.scheduled === true
  })

  if (shouldRunUpgrade({ flags, env: process.env })) {
    try {
      runUpgrade({
        flags,
        log: (line) => {
          if (!logs) console.log(line)
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`TokenBoard upgrade skipped: ${message}`)
    }
  }

  if (!existsSync(invocation.repoDir)) {
    console.error(`TokenBoard collector is not installed: ${invocation.repoDir}`)
    console.error('Run setup.mjs again or run install-collector.mjs.')
    closeScheduledLogRuntime(logs)
    process.exit(1)
  }

  const result = spawnSync(
    invocation.command,
    invocation.args,
    {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: logs ? ['ignore', logs.stdoutFd, logs.stderrFd] : 'inherit',
      shell: invocation.shell
    }
  )

  if (result.error) {
    console.error(`Failed to run ${invocation.command}: ${result.error.message}`)
    closeScheduledLogRuntime(logs)
    process.exit(1)
  }

  closeScheduledLogRuntime(logs)
  process.exit(result.status ?? 1)
}

export function shouldRunUpgrade({ flags = {}, env = process.env } = {}) {
  if (flags['skip-upgrade'] === true) {
    return false
  }
  if (env.TOKENBOARD_SKIP_UPGRADE === '1') {
    return false
  }
  if (env.TOKENBOARD_AUTO_UPGRADE === '0') {
    return false
  }
  return true
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
    command: nodePath,
    args: ['--import', 'tsx', 'src/cli.ts', mode, '--source', source],
    cwd: join(repoDir, 'packages', 'collector'),
    repoDir,
    shell: false,
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
      TOKENBOARD_SINCE: since,
      TOKENBOARD_DEFAULT_SINCE: since
    }
  }
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}
