#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'
import {
  collectorDir as defaultCollectorDir,
  configDir as defaultConfigDir,
  mergeConfig,
  parseArgs,
  readConfig,
  readPackageManager
} from './config.mjs'
import { hasHelpFlag, printHelpIfRequested } from './cli-help.mjs'
import { defaultReleaseRepo, installClientBinary } from './client-binary.mjs'
import { redactUrlCredentials } from './redact-credentials.mjs'
import { assertSupportedNodeVersion } from './node-version.mjs'
import { recoverOrphanedBackup, runArchiveFallback, selectAvailableBackupPath } from './upgrade-archive.mjs'
import {
  buildCloneSteps,
  buildDefaultBranchPullSteps,
  buildFetchAndCheckoutRefSteps,
  corepackCommand,
  errorMessage,
  joinForPlatform,
  runStep,
  samePath
} from './upgrade-utils.mjs'

export const defaultRepoUrl = 'https://github.com/evepupil/TokenBoard.git'

// migrateToBinaryClient upgrades a git-clone install to the released binary:
// it installs the current release into the config directory's bin/ and flips
// `clientType` to 'binary' so the sync spawns the Go client from now on. The
// existing checkout is not deleted — the git client keeps working as the
// rollback (set `clientType` back to 'git'), and the skill keeps updating
// itself from the checkout until it is gone.
//
// This is explicit opt-in (`--to-binary`): the release feed and the git
// default branch are published from different places on purpose, and flipping
// the default would silently retarget every existing install.
export async function migrateToBinaryClient({
  flags = {},
  env = process.env,
  configDirectory = defaultConfigDir(),
  install = installClientBinary,
  mergeConfigFile = mergeConfig,
  log = console.log
} = {}) {
  const repo = trimmedString(flags['release-repo'] || env.TOKENBOARD_RELEASE_REPO) || defaultReleaseRepo
  const tag = trimmedString(flags['release-tag'] || env.TOKENBOARD_RELEASE_TAG) || undefined
  const baseUrl = trimmedString(flags['release-base-url'] || env.TOKENBOARD_RELEASE_BASE_URL) || undefined
  const installed = await install({ repo, tag, baseUrl, configDir: configDirectory, log })
  // The switch is recorded so the next sync knows which client to run. A
  // release source that came from a flag or the environment is recorded too:
  // every later `self-update` resolves the feed on its own, and forgetting it
  // would silently move the machine back to the default repository. The tag
  // is deliberately not recorded — it pins this one install, and persisting it
  // would freeze the client on that version.
  //
  // The install location is still derived from the config directory, so a
  // config copied to another machine cannot point at this one's binary.
  const next = mergeConfigFile({
    clientType: 'binary',
    ...(repo !== defaultReleaseRepo ? { releaseRepo: repo } : {}),
    ...(baseUrl ? { releaseBaseUrl: baseUrl } : {})
  })
  log(
    `TokenBoard will run the released Go client (${installed.version}) from now on. ` +
      'Set clientType back to "git" in the config to return to the checkout install.'
  )
  return { installed, clientType: next.clientType }
}

export function buildUpgradePlan({
  collectorDir,
  skillDir,
  configDir,
  repoUrl,
  repoRef,
  collectorExists,
  collectorIsGitRepo = collectorExists,
  workDir,
  backupDir,
  platform = process.platform
}) {
  if (configDir && samePath(skillDir, configDir, platform)) {
    throw new Error(`Refusing to replace TokenBoard config directory as skill install: ${skillDir}`)
  }
  if (collectorExists && !collectorIsGitRepo && configDir && samePath(collectorDir, configDir, platform)) {
    throw new Error(`Refusing to replace TokenBoard config directory as collector checkout: ${collectorDir}`)
  }

  const replacementDir = workDir ? joinForPlatform(workDir, 'TokenBoard') : null
  const resolvedBackupDir = backupDir || `${collectorDir}.tokenboard-upgrade-backup-${process.pid}`
  const steps =
    collectorExists && collectorIsGitRepo
      ? [
          { command: 'git', args: ['remote', 'set-url', 'origin', repoUrl], options: { cwd: collectorDir } },
          ...buildFetchAndCheckoutRefSteps({ dir: collectorDir, repoRef }),
          ...(repoRef ? [] : buildDefaultBranchPullSteps({ dir: collectorDir }))
        ]
      : collectorExists
        ? replacementDir
          ? [
              { command: 'remove', args: [workDir], options: { recursive: true, force: true } },
              ...buildCloneSteps({ repoUrl, repoRef, dir: replacementDir }),
              { command: 'replace', args: [replacementDir, collectorDir, resolvedBackupDir], options: {} },
              { command: 'remove', args: [workDir], options: { recursive: true, force: true } }
            ]
          : [
              { command: 'remove', args: [collectorDir], options: { recursive: true, force: true } },
              ...buildCloneSteps({ repoUrl, repoRef, dir: collectorDir })
            ]
        : [...buildCloneSteps({ repoUrl, repoRef, dir: collectorDir })]

  const collectorSkillDir = joinForPlatform(collectorDir, 'skills', 'tokenboard')
  if (!samePath(collectorSkillDir, skillDir, platform)) {
    // A merge copy (`recursive + force`) leaves files the upstream deleted behind forever,
    // and a failure mid-copy leaves a half-updated skill with no way back. Stage the new
    // copy beside the target and swap it in with a backup kept until the swap succeeds —
    // the same replace-with-rollback the archive path applies, so the installed skill
    // always matches the upstream tree exactly.
    const skillStagingDir = `${skillDir}.tokenboard-upgrade-staging-${process.pid}`
    const skillBackupDir = `${skillDir}.tokenboard-upgrade-backup-${process.pid}`
    steps.push(
      { command: 'remove', args: [skillStagingDir], options: { recursive: true, force: true } },
      { command: 'copy', args: [collectorSkillDir, skillStagingDir], options: { recursive: true, force: true } },
      { command: 'replace', args: [skillStagingDir, skillDir, skillBackupDir], options: {} }
    )
  }

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
  nodePath = process.execPath,
  automatic = false,
  spawn = spawnSync,
  exists = existsSync,
  copy = cpSync,
  mkdir = mkdirSync,
  readDir = readdirSync,
  remove = rmSync,
  rename = renameSync,
  readConfigFile = readConfig,
  mergeConfigFile = mergeConfig,
  configDirectory = defaultConfigDir(),
  // The default sink is the terminal. Redact it too: a manual `node scripts/upgrade.mjs` run
  // prints the configured repo URL, which may carry `user:token@host` userinfo, and the
  // scheduled path already wraps its logger the same way.
  log = (line) => console.log(redactUrlCredentials(line))
} = {}) {
  const config = readConfigFile()
  const repoUrl = resolveRepoUrl({ flags, env, config })
  const repoRef = resolveRepoRef({ flags, env, config })
  const packageManager = readPackageManager(flags, config)
  const collector = config.collectorDir || defaultCollectorDir()
  const skillDir =
    flags['skill-dir'] || env.TOKENBOARD_SKILL_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (!samePath(collector, configDirectory, platform)) {
    recoverOrphanedBackup({ collectorDir: collector, platform, readDir, rename, copy, remove, log })
  }
  const collectorExists = exists(collector)
  const collectorIsGitRepo = exists(joinForPlatform(collector, '.git'))
  const workDir = createUpgradeWorkDir(configDirectory, platform, exists)
  const backupDir =
    collectorExists && !collectorIsGitRepo
      ? selectAvailableBackupPath({ collectorDir: collector, platform, readDir })
      : undefined

  if (collectorExists && collectorIsGitRepo) {
    assertCleanGitWorktree({ collectorDir: collector, spawn })
    if (automatic) {
      assertAutomaticUpgradeBranch({
        collectorDir: collector,
        repoRef,
        spawn
      })
    }
  }

  try {
    for (const step of buildUpgradePlan({
      collectorDir: collector,
      skillDir,
      configDir: configDirectory,
      repoUrl,
      repoRef,
      collectorExists,
      collectorIsGitRepo,
      workDir,
      backupDir,
      platform
    })) {
      runStep(step, { spawn, copy, remove, rename, log, platform })
    }
  } catch (error) {
    if (collectorExists && collectorIsGitRepo) {
      throw error
    }
    log(`TokenBoard git upgrade failed, trying archive fallback: ${errorMessage(error)}`)
    runArchiveFallback({
      archiveUrls: resolveArchiveUrls({ flags, env, config, repoUrl, repoRef }),
      collectorDir: collector,
      configDir: configDirectory,
      skillDir,
      workDir,
      platform,
      spawn,
      copy,
      mkdir,
      readDir,
      remove,
      rename,
      log
    })
  }

  const refreshScriptPath = joinForPlatform(
    joinForPlatform(collector, 'skills', 'tokenboard'),
    'scripts',
    'refresh-notify-handler.mjs'
  )
  if (exists(refreshScriptPath)) {
    refreshInstalledNotifyHandler({
      collectorDir: collector,
      configDirectory,
      env,
      nodePath,
      spawn
    })
  }

  const previousCommit = config.upgradedCommit ?? null
  const upgradedCommit = resolveCurrentCommit({ collectorDir: collector, spawn })

  mergeConfigFile({
    collectorDir: collector,
    repoUrl,
    repoRef,
    packageManager,
    skillDir,
    upgradedCommit,
    upgradedAt: new Date().toISOString()
  })
  log(
    `TokenBoard upgraded from ${repoUrl}${repoRef ? `#${repoRef}` : ''} (commit ${previousCommit ?? 'unknown'} -> ${upgradedCommit ?? 'unknown'})`
  )
  return { collectorDir: collector, skillDir, repoUrl, repoRef, packageManager }
}

// Archive fallbacks and checkoutless installs have no HEAD to name; record null rather than
// failing an otherwise successful upgrade.
function resolveCurrentCommit({ collectorDir, spawn }) {
  const result = spawn('git', ['rev-parse', 'HEAD'], { cwd: collectorDir, encoding: 'utf8' })
  const commit = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  return result.status === 0 && /^[0-9a-f]{40}$/.test(commit) ? commit : null
}

function createUpgradeWorkDir(configDirectory, platform, exists) {
  const stablePath = joinForPlatform(configDirectory, 'upgrade-work')
  // A real config directory is shared by scheduled and manual upgrades. Give
  // each run its own workspace so an interrupted or concurrent archive
  // fallback cannot remove another run's extracted checkout. Test doubles
  // commonly omit the config directory; retaining the stable path there keeps
  // the plan deterministic without changing production behavior.
  if (!exists(configDirectory)) return stablePath
  return `${stablePath}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function refreshInstalledNotifyHandler({
  collectorDir,
  configDirectory,
  env = process.env,
  nodePath = process.execPath,
  spawn = spawnSync
} = {}) {
  const scriptPath = joinForPlatform(
    joinForPlatform(collectorDir, 'skills', 'tokenboard'),
    'scripts',
    'refresh-notify-handler.mjs'
  )
  const result = spawn(nodePath, [scriptPath], {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env: {
      ...env,
      TOKENBOARD_CONFIG_DIR: configDirectory
    }
  })
  if (result.error) {
    throw new Error(`TokenBoard notify handler refresh failed: ${errorMessage(result.error)}`)
  }
  if (result.status !== 0) {
    throw new Error(`TokenBoard notify handler refresh failed with exit code ${result.status ?? 1}`)
  }
  return { scriptPath }
}

export function assertCleanGitWorktree({ collectorDir, spawn = spawnSync }) {
  const result = spawn('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: collectorDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false
  })
  if (result.status !== 0) {
    throw new Error('Unable to inspect the TokenBoard collector worktree before upgrade')
  }
  if (String(result.stdout ?? '').trim()) {
    throw new Error('Refusing to upgrade a collector checkout with uncommitted changes')
  }
}

export function assertAutomaticUpgradeBranch({ collectorDir, repoRef, spawn = spawnSync }) {
  const currentBranch = readGitBranch({ collectorDir, spawn })
  if (!currentBranch) {
    throw new Error(
      'Refusing automatic TokenBoard upgrade from a detached HEAD. ' +
        'Run upgrade.mjs manually after switching the checkout to the intended branch.'
    )
  }

  const targetBranch = resolveAutomaticUpgradeBranch({ collectorDir, repoRef, spawn })
  if (!targetBranch) {
    const explicitRef = trimmedString(repoRef)
    throw new Error(
      explicitRef
        ? `Refusing automatic TokenBoard upgrade from branch ${currentBranch}: the configured ref is not a branch. ` +
            'Run upgrade.mjs manually after switching the checkout to the intended ref.'
        : `Refusing automatic TokenBoard upgrade from branch ${currentBranch}: unable to resolve the remote default branch. ` +
            'Run upgrade.mjs manually after verifying the origin remote and its default branch.'
    )
  }
  if (currentBranch !== targetBranch) {
    throw new Error(
      `Refusing automatic TokenBoard upgrade from branch ${currentBranch} to ${targetBranch}. ` +
        'Run upgrade.mjs manually after switching the checkout to the intended branch.'
    )
  }
}

function resolveAutomaticUpgradeBranch({ collectorDir, repoRef, spawn }) {
  const explicitRef = trimmedString(repoRef)
  if (explicitRef) {
    if (explicitRef.startsWith('refs/heads/')) {
      return explicitRef.slice('refs/heads/'.length)
    }
    return explicitRef.startsWith('refs/') ? '' : explicitRef
  }

  const result = spawn('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: collectorDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false
  })
  if (result.status !== 0) return ''
  const remoteHead = String(result.stdout ?? '').trim()
  return remoteHead.startsWith('origin/') ? remoteHead.slice('origin/'.length) : ''
}

function readGitBranch({ collectorDir, spawn }) {
  const result = spawn('git', ['branch', '--show-current'], {
    cwd: collectorDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false
  })
  if (result.status !== 0) {
    throw new Error('Unable to inspect the TokenBoard collector branch before automatic upgrade')
  }
  return String(result.stdout ?? '').trim()
}

export function resolveArchiveUrls({
  flags = {},
  env = process.env,
  config = {},
  repoUrl = defaultRepoUrl,
  repoRef = null
} = {}) {
  const explicit = trimmedString(flags['archive-url'] || env.TOKENBOARD_ARCHIVE_URL)
  if (explicit) {
    return [explicit]
  }

  const configuredRepoUrl = trimmedString(config.repoUrl)
  if (configuredRepoUrl.endsWith('.zip')) {
    return [configuredRepoUrl]
  }

  const github = parseGitHubRepoUrl(repoUrl)
  if (github) {
    return buildArchiveRefPaths(repoRef).map(
      (refPath) => `https://github.com/${github[1]}/${github[2]}/archive/${refPath}.zip`
    )
  }

  // The message carries the repo URL, which may hold `user:token@host` userinfo; redact it here
  // so no caller's error sink can leak it. This error reaches `console.error` on both the manual
  // and scheduled paths, which do not go through `log()`.
  throw new Error(
    `Archive fallback requires a GitHub repo URL or explicit archive URL: ${redactUrlCredentials(repoUrl)}`
  )
}

export function resolveArchiveUrl({
  flags = {},
  env = process.env,
  config = {},
  repoUrl = defaultRepoUrl,
  repoRef = null
} = {}) {
  return resolveArchiveUrls({ flags, env, config, repoUrl, repoRef })[0]
}

export function resolveRepoRef({ flags = {}, env = process.env, config = {} } = {}) {
  const explicit = flags['repo-ref'] || env.TOKENBOARD_REPO_REF
  if (explicit) return explicit
  return typeof config.repoRef === 'string' && config.repoRef.trim() ? config.repoRef : null
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
  const url = trimmedString(value)
  return (
    !!url &&
    !url.endsWith('.zip') &&
    (url.endsWith('.git') || url.startsWith('git@') || url.startsWith('ssh://') || /^https?:\/\//.test(url))
  )
}

function parseGitHubRepoUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return (
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed) ||
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed) ||
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed)
  )
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function buildArchiveRefPaths(repoRef) {
  const ref = typeof repoRef === 'string' && repoRef.trim() ? repoRef.trim() : 'master'
  if (ref.startsWith('refs/heads/')) {
    return [`refs/heads/${encodeURIComponent(ref.slice('refs/heads/'.length))}`]
  }
  if (ref.startsWith('refs/tags/')) {
    return [`refs/tags/${encodeURIComponent(ref.slice('refs/tags/'.length))}`]
  }
  return [`refs/heads/${encodeURIComponent(ref)}`, encodeURIComponent(ref)]
}

function runCli() {
  if (
    printHelpIfRequested(
      process.argv.slice(2),
      'Usage: upgrade.mjs [--repo-url URL] [--repo-ref REF] [--skill-dir DIR] [--archive-url URL] [--package-manager pnpm|bun|npm] [--to-binary]'
    )
  ) {
    return
  }
  const flags = parseArgs(process.argv.slice(2))
  if (flags['to-binary']) {
    migrateToBinaryClient({ flags, configDirectory: defaultConfigDir() }).catch((error) => {
      console.error(redactUrlCredentials(errorMessage(error)))
      process.exit(1)
    })
    return
  }
  try {
    runUpgrade({ flags })
  } catch (error) {
    // The manual path prints to the terminal directly, so redact here too: an error can carry a
    // repo URL with `user:token@host` userinfo, and this sink does not go through `log()`.
    console.error(redactUrlCredentials(errorMessage(error)))
    process.exit(1)
  }
}

if (isMainModule(import.meta.url)) {
  // The manual and automatic upgrade paths download over Node `fetch` — a release tarball for
  // `--to-binary`, and a ZIP archive fallback for a checkout upgrade. Both trust TLS hostname
  // validation for the origin before the checksums are compared, so an unsupported Node (with
  // the hostname-verification bypass) makes a hostile host able to serve matching checksums.
  // sync.mjs's preflight covers automatic upgrades; a manual `upgrade.mjs` is a fifth TLS
  // entrypoint and needs the same bound. `--help` stays a pure read on any runtime, matching
  // the CLI contract.
  if (!hasHelpFlag(process.argv.slice(2))) {
    try {
      assertSupportedNodeVersion(process.versions.node)
    } catch (error) {
      console.error(errorMessage(error))
      process.exit(1)
    }
  }
  runCli()
}
