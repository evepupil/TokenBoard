#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { collectorDir, configDir, mergeConfig, parseArgs, readPackageManager } from './config.mjs'
import {
  buildCloneSteps,
  buildDefaultBranchPullSteps,
  buildFetchAndCheckoutRefSteps,
  errorMessage,
  runStep,
  samePath
} from './upgrade-utils.mjs'

const defaultRepoUrl = 'https://github.com/evepupil/TokenBoard.git'

function run(command, args, options = {}) {
  try {
    runStep(
      { command, args, options },
      {
        spawn: spawnSync,
        remove: rmSync,
        platform: process.platform
      }
    )
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}

export function buildInstallCollectorPlan({
  dir,
  repoUrl,
  repoRef,
  exists,
  isGitRepo = exists,
  configDir,
  platform = process.platform
}) {
  if (exists && !isGitRepo && configDir && samePath(dir, configDir, platform)) {
    throw new Error(`Refusing to replace TokenBoard config directory as collector checkout: ${dir}`)
  }

  const steps =
    exists && isGitRepo
      ? [
          { command: 'git', args: ['remote', 'set-url', 'origin', repoUrl], options: { cwd: dir } },
          ...buildFetchAndCheckoutRefSteps({ dir, repoRef }),
          ...(repoRef ? [] : buildDefaultBranchPullSteps({ dir }))
        ]
      : exists
        ? [
            { command: 'remove', args: [dir], options: { recursive: true, force: true } },
            ...buildCloneSteps({ repoUrl, repoRef, dir })
          ]
        : [...buildCloneSteps({ repoUrl, repoRef, dir })]

  steps.push({
    command: corepackCommand(platform),
    args: ['pnpm', 'install', '--frozen-lockfile'],
    options: { cwd: dir }
  })
  return steps
}

function runCli() {
  const flags = parseArgs(process.argv.slice(2))
  const repoUrl = flags['repo-url'] || process.env.TOKENBOARD_REPO_URL || defaultRepoUrl
  const repoRef = flags['repo-ref'] || process.env.TOKENBOARD_REPO_REF || null
  const packageManager = readPackageManager(flags)
  const dir = collectorDir()

  for (const step of buildInstallCollectorPlan({
    dir,
    repoUrl,
    repoRef,
    exists: existsSync(dir),
    isGitRepo: existsSync(join(dir, '.git')),
    configDir: configDir(),
    platform: process.platform
  })) {
    run(step.command, step.args, step.options)
  }

  mergeConfig({ collectorDir: dir, repoUrl, repoRef, packageManager, updatedAt: new Date().toISOString() })
  console.log(`TokenBoard collector ready at ${dir}`)
}

function corepackCommand(platform) {
  return platform === 'win32' ? 'corepack.cmd' : 'corepack'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
