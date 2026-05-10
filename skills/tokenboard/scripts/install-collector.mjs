#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectorDir, mergeConfig, packageManagerCommand, parseArgs, readPackageManager } from './config.mjs'

const defaultRepoUrl = 'https://github.com/evepupil/TokenBoard.git'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    ...options
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

export function buildInstallCollectorPlan({ dir, repoUrl, packageManager, exists }) {
  const steps = exists
    ? [
        { command: 'git', args: ['remote', 'set-url', 'origin', repoUrl], options: { cwd: dir } },
        { command: 'git', args: ['pull', '--ff-only'], options: { cwd: dir } }
      ]
    : [
        { command: 'git', args: ['clone', '--depth', '1', repoUrl, dir], options: {} }
      ]

  steps.push({
    command: packageManagerCommand(packageManager),
    args: ['install'],
    options: { cwd: dir }
  })

  return steps
}

function runCli() {
  const flags = parseArgs(process.argv.slice(2))
  const repoUrl = flags['repo-url'] || process.env.TOKENBOARD_REPO_URL || defaultRepoUrl
  const packageManager = readPackageManager(flags)
  const dir = collectorDir()

  for (const step of buildInstallCollectorPlan({
    dir,
    repoUrl,
    packageManager,
    exists: existsSync(dir)
  })) {
    run(step.command, step.args, step.options)
  }

  mergeConfig({ collectorDir: dir, repoUrl, packageManager, updatedAt: new Date().toISOString() })
  console.log(`TokenBoard collector ready at ${dir}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
