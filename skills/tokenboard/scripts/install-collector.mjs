#!/usr/bin/env node
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isMainModule } from './is-main.mjs'
import { printHelpIfRequested } from './cli-help.mjs'
import { join } from 'node:path'
import {
  collectorDir,
  configDir,
  mergeConfig,
  parseArgs,
  readClientType,
  readConfig,
  readPackageManager
} from './config.mjs'
import { defaultReleaseRepo, installClientBinary } from './client-binary.mjs'
import { redactUrlCredentials } from './redact-credentials.mjs'
import { assertSupportedNodeVersion } from './node-version.mjs'
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
        rename: renameSync,
        copy: cpSync,
        platform: process.platform
      }
    )
  } catch (error) {
    // A failed clone or fetch echoes the repo URL, which may carry
    // `user:token@host` userinfo.
    console.error(redactUrlCredentials(errorMessage(error)))
    process.exit(1)
  }
}

export function buildBinaryInstallConfig({ repo, baseUrl, updatedAt }) {
  // Every later `self-update` resolves the feed on its own, so a non-default
  // source has to outlive this install — the same rule `migrateToBinaryClient`
  // follows. The tag is deliberately not recorded: it pins one install, and
  // persisting it would freeze the client on that version.
  return {
    clientType: 'binary',
    updatedAt,
    ...(repo && repo !== defaultReleaseRepo ? { releaseRepo: repo } : {}),
    ...(baseUrl ? { releaseBaseUrl: baseUrl } : {})
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
        ? (() => {
            // Never delete the existing checkout before its replacement exists: a failed
            // clone (offline, bad ref) must leave the original directory untouched, not an
            // empty one. Stage the clone beside the target and swap it in with a backup
            // kept until the swap succeeds — the same replace-with-rollback the upgrade
            // path uses for a non-git collector.
            const stagingDir = `${dir}.tokenboard-install-staging-${process.pid}`
            const backupDir = `${dir}.tokenboard-upgrade-backup-${process.pid}`
            return [
              { command: 'remove', args: [stagingDir], options: { recursive: true, force: true } },
              ...buildCloneSteps({ repoUrl, repoRef, dir: stagingDir }),
              { command: 'replace', args: [stagingDir, dir, backupDir], options: {} }
            ]
          })()
        : [...buildCloneSteps({ repoUrl, repoRef, dir })]

  steps.push({
    command: corepackCommand(platform),
    args: ['pnpm', 'install', '--frozen-lockfile'],
    options: { cwd: dir }
  })
  return steps
}

// resolveGitInstallOptions resolves the three settings a git install records.
// Each falls back to the saved config before its default: a bare re-run (the
// recovery path sync.mjs names when the checkout is missing) must not silently
// reset a configured mirror, ref or package manager to the project defaults.
export function resolveGitInstallOptions({ flags = {}, env = process.env, saved = {} } = {}) {
  return {
    repoUrl: flags['repo-url'] || env.TOKENBOARD_REPO_URL || saved.repoUrl || defaultRepoUrl,
    repoRef: flags['repo-ref'] || env.TOKENBOARD_REPO_REF || saved.repoRef || null,
    packageManager: readPackageManager(flags, saved)
  }
}

function runCli() {
  if (
    printHelpIfRequested(
      process.argv.slice(2),
      'Usage: install-collector.mjs [--repo-url URL] [--repo-ref REF] [--package-manager pnpm|bun|npm] [--client git|binary] [--release-repo OWNER/REPO] [--release-tag TAG] [--release-base-url URL]'
    )
  ) {
    return
  }
  // Before the clone: pnpm's engine-strict check only fires once the checkout
  // exists, and a git install on an unsupported Node should not leave a fresh
  // clone behind just to refuse it. The binary install below needs no Node at
  // all past this point, but the Go client it drops in is what later syncs run,
  // and those syncs do require the floor.
  try {
    assertSupportedNodeVersion(process.versions.node)
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
  const flags = parseArgs(process.argv.slice(2))
  const dir = collectorDir()
  let saved = {}
  let clientType
  try {
    // The saved config is consulted so a bare re-run on a binary install does
    // not silently clone git and switch the machine back to `git`, and so the
    // mirror, ref and package manager it records survive the re-run.
    if (existsSync(join(configDir(), 'config.json'))) {
      saved = readConfig()
    }
    clientType = readClientType({ flags, env: process.env, config: saved })
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }

  if (clientType === 'binary') {
    // A binary install has no checkout to clone or pull: the release tarball
    // carries everything the client needs. The config directory is the binary's
    // home, so this is the only install step. A non-default feed recorded at
    // install time is reused, for the same reason as the git settings below.
    const repo = flags['release-repo'] || process.env.TOKENBOARD_RELEASE_REPO || saved.releaseRepo || defaultReleaseRepo
    const baseUrl =
      flags['release-base-url'] || process.env.TOKENBOARD_RELEASE_BASE_URL || saved.releaseBaseUrl || undefined
    installClientBinary({
      repo,
      tag: flags['release-tag'] || process.env.TOKENBOARD_RELEASE_TAG || undefined,
      baseUrl,
      configDir: configDir(),
      // The installer reports a failed bundled-ccusage write through this
      // channel. Without it the default is a no-op and the warning is lost,
      // leaving the client installed with no bundled copy and no sign of it.
      log: (line) => console.log(line)
    })
      .then((installed) => {
        mergeConfig(buildBinaryInstallConfig({ repo, baseUrl, updatedAt: new Date().toISOString() }))
        console.log(`TokenBoard client ${installed.version} ready at ${installed.path}`)
      })
      .catch((error) => {
        // The release base URL and repo can carry `user:token@host` userinfo
        // (a private mirror), and this sink is the terminal or a CI log.
        console.error(redactUrlCredentials(errorMessage(error)))
        process.exit(1)
      })
    return
  }

  const { repoUrl, repoRef, packageManager } = resolveGitInstallOptions({ flags, env: process.env, saved })

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

  mergeConfig({
    collectorDir: dir,
    repoUrl,
    repoRef,
    packageManager,
    clientType: 'git',
    updatedAt: new Date().toISOString()
  })
  console.log(`TokenBoard collector ready at ${dir}`)
}

function corepackCommand(platform) {
  return platform === 'win32' ? 'corepack.cmd' : 'corepack'
}

if (isMainModule(import.meta.url)) {
  runCli()
}
