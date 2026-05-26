#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectorDir as defaultCollectorDir,
  configDir as defaultConfigDir,
  mergeConfig,
  parseArgs,
  readConfig,
  readPackageManager
} from './config.mjs'

export const defaultRepoUrl = 'https://github.com/evepupil/TokenBoard.git'

export function buildUpgradePlan({
  collectorDir,
  skillDir,
  configDir,
  repoUrl,
  packageManager,
  collectorExists,
  collectorIsGitRepo = collectorExists,
  workDir,
  platform = process.platform
}) {
  if (configDir && samePath(skillDir, configDir)) {
    throw new Error(`Refusing to replace TokenBoard config directory as skill install: ${skillDir}`)
  }

  const replacementDir = workDir ? joinForPlatform(workDir, 'TokenBoard') : null
  const steps = collectorExists && collectorIsGitRepo
    ? [
        { command: 'git', args: ['remote', 'set-url', 'origin', repoUrl], options: { cwd: collectorDir } },
        { command: 'git', args: ['pull', '--ff-only'], options: { cwd: collectorDir } }
      ]
    : collectorExists
      ? replacementDir
        ? [
            { command: 'remove', args: [workDir], options: { recursive: true, force: true } },
            { command: 'git', args: ['clone', '--depth', '1', repoUrl, replacementDir], options: {} },
            { command: 'remove', args: [collectorDir], options: { recursive: true, force: true } },
            { command: 'copy', args: [replacementDir, collectorDir], options: { recursive: true, force: true } },
            { command: 'remove', args: [workDir], options: { recursive: true, force: true } }
          ]
        : [
            { command: 'remove', args: [collectorDir], options: { recursive: true, force: true } },
            { command: 'git', args: ['clone', '--depth', '1', repoUrl, collectorDir], options: {} }
          ]
      : [
          { command: 'git', args: ['clone', '--depth', '1', repoUrl, collectorDir], options: {} }
        ]

  steps.push({
    command: 'copy',
    args: [joinForPlatform(collectorDir, 'skills', 'tokenboard', platform), skillDir],
    options: { recursive: true, force: true }
  })

  steps.push({
    command: corepackCommand(platform),
    args: ['pnpm', 'install', '--frozen-lockfile'],
    options: { cwd: collectorDir }
  })

  return steps
}

export function runUpgrade({
  flags = {},
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  exists = existsSync,
  copy = cpSync,
  mkdir = mkdirSync,
  readDir = readdirSync,
  remove = rmSync,
  log = console.log
} = {}) {
  const config = readConfig()
  const repoUrl = resolveRepoUrl({ flags, env, config })
  const packageManager = readPackageManager(flags, config)
  const collector = config.collectorDir || defaultCollectorDir()
  const skillDir = flags['skill-dir'] || env.TOKENBOARD_SKILL_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..')

  try {
    for (const step of buildUpgradePlan({
      collectorDir: collector,
      skillDir,
      configDir: defaultConfigDir(),
      repoUrl,
      packageManager,
      collectorExists: exists(collector),
      collectorIsGitRepo: exists(join(collector, '.git')),
      workDir: join(defaultConfigDir(), 'upgrade-work'),
      platform
    })) {
      runStep(step, { spawn, copy, remove, platform })
    }
  } catch (error) {
    log(`TokenBoard git upgrade failed, trying archive fallback: ${errorMessage(error)}`)
    runArchiveFallback({
      archiveUrl: resolveArchiveUrl({ flags, env, config, repoUrl }),
      collectorDir: collector,
      skillDir,
      packageManager,
      workDir: join(defaultConfigDir(), 'upgrade-work'),
      platform,
      spawn,
      copy,
      mkdir,
      readDir,
      remove
    })
  }

  mergeConfig({
    collectorDir: collector,
    repoUrl,
    packageManager,
    skillDir,
    upgradedAt: new Date().toISOString()
  })
  log(`TokenBoard upgraded from ${repoUrl}`)
  return { collectorDir: collector, skillDir, repoUrl, packageManager }
}

export function resolveArchiveUrl({ flags = {}, env = process.env, config = {}, repoUrl = defaultRepoUrl } = {}) {
  const explicit = flags['archive-url'] || env.TOKENBOARD_ARCHIVE_URL
  if (explicit) {
    return explicit
  }

  if (typeof config.repoUrl === 'string' && config.repoUrl.endsWith('.zip')) {
    return config.repoUrl
  }

  const github = /^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/.exec(repoUrl)
  if (github) {
    return `https://github.com/${github[1]}/${github[2]}/archive/refs/heads/master.zip`
  }

  return 'https://github.com/evepupil/TokenBoard/archive/refs/heads/master.zip'
}

export function resolveRepoUrl({ flags = {}, env = process.env, config = {} } = {}) {
  const explicit = flags['repo-url'] || env.TOKENBOARD_REPO_URL
  if (explicit) {
    return explicit
  }

  if (isGitRepoUrl(config.repoUrl)) {
    return config.repoUrl
  }

  return defaultRepoUrl
}

function isGitRepoUrl(value) {
  return typeof value === 'string' && (
    value.endsWith('.git') ||
    value.startsWith('git@') ||
    value.startsWith('ssh://')
  )
}

function runArchiveFallback({
  archiveUrl,
  collectorDir,
  skillDir,
  packageManager,
  workDir,
  platform,
  spawn,
  copy,
  mkdir,
  readDir,
  remove
}) {
  const zipPath = join(workDir, 'tokenboard.zip')
  const extractDir = join(workDir, 'extract')
  remove(workDir, { recursive: true, force: true })
  mkdir(workDir, { recursive: true })
  downloadArchive({ archiveUrl, zipPath, platform, spawn })
  extractArchive({ zipPath, extractDir, platform, spawn, mkdir })
  const extractedRoot = findExtractedRoot({ extractDir, readDir })
  remove(collectorDir, { recursive: true, force: true })
  copy(extractedRoot, collectorDir, { recursive: true, force: true })
  copy(joinForPlatform(collectorDir, 'skills', 'tokenboard'), skillDir, { recursive: true, force: true })
  runStep({
    command: corepackCommand(platform),
    args: ['pnpm', 'install', '--frozen-lockfile'],
    options: { cwd: collectorDir }
  }, { spawn, copy, remove, platform })
  remove(workDir, { recursive: true, force: true })
}

function downloadArchive({ archiveUrl, zipPath, platform, spawn }) {
  const command = platform === 'win32' ? 'powershell.exe' : 'curl'
  const args = platform === 'win32'
    ? [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '${escapePowerShellSingleQuoted(archiveUrl)}' -OutFile '${escapePowerShellSingleQuoted(zipPath)}'`
      ]
    : ['-L', archiveUrl, '-o', zipPath]
  runExternal(command, args, { spawn, platform })
}

function extractArchive({ zipPath, extractDir, platform, spawn, mkdir }) {
  mkdir(extractDir, { recursive: true })
  const command = platform === 'win32' ? 'powershell.exe' : 'unzip'
  const args = platform === 'win32'
    ? [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${escapePowerShellSingleQuoted(zipPath)}' -DestinationPath '${escapePowerShellSingleQuoted(extractDir)}' -Force`
      ]
    : ['-q', zipPath, '-d', extractDir]
  runExternal(command, args, { spawn, platform })
}

function runExternal(command, args, { spawn, platform }) {
  const result = spawn(command, args, {
    stdio: 'inherit',
    shell: platform === 'win32' && command.endsWith('.cmd')
  })
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? 1}`)
  }
}

function findExtractedRoot({ extractDir, readDir }) {
  const entries = readDir(extractDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
  if (entries.length !== 1) {
    throw new Error(`Expected one extracted TokenBoard directory in ${extractDir}`)
  }
  return join(extractDir, entries[0].name)
}

function runStep(step, runtime) {
  if (step.command === 'remove') {
    runtime.remove(step.args[0], step.options)
    return
  }

  if (step.command === 'copy') {
    runtime.copy(step.args[0], step.args[1], step.options)
    return
  }

  const result = runtime.spawn(step.command, step.args, {
    stdio: 'inherit',
    shell: runtime.platform === 'win32' && step.command.endsWith('.cmd'),
    ...step.options
  })
  if (result.status !== 0) {
    throw new Error(`${step.command} failed with exit code ${result.status ?? 1}`)
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replaceAll("'", "''")
}

function samePath(leftPath, rightPath) {
  return resolve(leftPath) === resolve(rightPath)
}

function corepackCommand(platform) {
  return platform === 'win32' ? 'corepack.cmd' : 'corepack'
}

function joinForPlatform(base, first, second) {
  const separator = String(base).includes('\\') ? '\\' : '/'
  return [String(base).replace(/[\\/]$/, ''), first, second]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(separator)
}

function runCli() {
  try {
    runUpgrade({ flags: parseArgs(process.argv.slice(2)) })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
