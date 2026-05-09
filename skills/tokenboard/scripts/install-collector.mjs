#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { collectorDir, mergeConfig, packageManagerCommand, parseArgs, readPackageManager } from './config.mjs'

const flags = parseArgs(process.argv.slice(2))
const repoUrl = flags['repo-url'] || process.env.TOKENBOARD_REPO_URL || 'https://github.com/evepupil/TokenBoard.git'
const packageManager = readPackageManager(flags)
const dir = collectorDir()

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    ...options
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!existsSync(dir)) {
  run('git', ['clone', '--depth', '1', repoUrl, dir])
} else {
  run('git', ['pull', '--ff-only'], { cwd: dir })
}

run(packageManagerCommand(packageManager), ['install'], { cwd: dir })
mergeConfig({ collectorDir: dir, repoUrl, packageManager, updatedAt: new Date().toISOString() })
console.log(`TokenBoard collector ready at ${dir}`)
