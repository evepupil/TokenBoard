#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 as windowsPath } from 'node:path'
import { isMainModule } from './is-main.mjs'
import { collectorDir, configDir, configPath, parseArgs } from './config.mjs'
import { printHelpIfRequested } from './cli-help.mjs'
import { deviceLinkPath } from './device-link.mjs'
import { errorMessage } from './error-message.mjs'
import { uninstallHooks } from './hooks.mjs'
import { uninstallSchedule } from './uninstall-schedule.mjs'

export function uninstallClient(options = {}) {
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const plan = createUninstallPlan(flags)
  const runtime = createUninstallRuntime(options)

  // Every removal target is validated before anything is removed — the hooks and schedule
  // included — so a refused path cannot leave a half-uninstalled machine: the collector
  // used to be deleted before the config-directory guard had a chance to refuse, and the
  // guards themselves used to run only after the hooks and schedule were already gone.
  const removeCollector =
    plan.removeCollector &&
    runtime.exists(runtime.collectorDir) &&
    !samePath(runtime.collectorDir, runtime.configDir, runtime.platform)
  if (removeCollector) assertRemovableCollectorDir(runtime)

  const removeConfigDir = plan.removeConfigDir && runtime.exists(runtime.configDir)
  if (removeConfigDir) assertRemovableConfigDir(runtime)

  // `--remove-config` deletes the single config file inside the config directory, so the
  // same directory guard applies: that file only ever lives in the tool's own directory.
  const removeConfigFile = plan.removeConfig && !plan.removeConfigDir && runtime.exists(runtime.configPath)
  if (removeConfigFile) assertRemovableConfigDir(runtime)

  const hookResult = plan.removeHooks ? runtime.uninstallHooks(options.hookOptions || {}) : null
  // The schedule is still removed when the Antigravity restore is incomplete: the abort
  // below preserves the recovery data (the collector and config directories), not the whole
  // install, and stopping the scheduled uploads is part of what the user asked for.
  runtime.uninstallSchedule(options.scheduleOptions || {})
  if (hasIncompleteHookRemoval(hookResult)) {
    throw new Error('Antigravity statusline restoration is incomplete; local recovery state was preserved')
  }

  const removed = {
    hook: plan.removeHooks,
    schedule: true,
    collector: false,
    config: false,
    configDir: false,
    deviceLink: false
  }

  if (removeCollector) {
    removePath(runtime, runtime.collectorDir)
    removed.collector = true
  }

  if (removeConfigFile) {
    removePath(runtime, runtime.configPath, { force: true })
    removed.config = true
  }

  if (removeConfigDir) {
    const deviceLinkWasPresent = runtime.exists(runtime.deviceLinkPath)
    removePath(runtime, runtime.configDir)
    removed.configDir = true
    removed.deviceLink = deviceLinkWasPresent
  }

  runtime.log('TokenBoard client uninstall completed.')
  return removed
}

function hasIncompleteHookRemoval(result) {
  return result?.hooks?.some((hook) => hook?.incomplete === true) === true
}

function createUninstallPlan(flags) {
  const removeCollector = Boolean(flags.all || flags['remove-collector'])
  const removeConfigDir = Boolean(flags.all || flags['remove-config-dir'])
  return {
    removeCollector,
    removeConfig: Boolean(flags['remove-config']),
    removeConfigDir,
    removeHooks: Boolean(
      flags.all ||
      flags['remove-hook'] ||
      flags['remove-hooks'] ||
      removeCollector ||
      flags['remove-config'] ||
      removeConfigDir
    )
  }
}

function createUninstallRuntime(options) {
  return {
    collectorDir: options.collectorDir || collectorDir(),
    configDir: options.configDir || configDir(),
    configPath: options.configPath || configPath(),
    deviceLinkPath: options.deviceLinkPath || deviceLinkPath(options.configDir || configDir()),
    exists: options.exists || existsSync,
    rm: options.rm || rmSync,
    cwd: options.cwd || process.cwd,
    chdir: options.chdir || process.chdir,
    fallbackCwd: options.fallbackCwd || homedir(),
    homeDir: options.homeDir || homedir(),
    platform: options.platform || process.platform,
    log: options.log || console.log,
    uninstallHooks: options.uninstallHooks || uninstallHooks,
    uninstallSchedule: options.uninstallSchedule || uninstallSchedule
  }
}

function removePath(runtime, targetPath, options = { recursive: true, force: true }) {
  leaveDirectoryBeforeRemove(runtime, targetPath)
  runtime.rm(targetPath, options)
}

function leaveDirectoryBeforeRemove(runtime, targetPath) {
  if (isInsidePath(runtime.cwd(), targetPath, runtime.platform)) {
    runtime.chdir(runtime.fallbackCwd)
  }
}

function isInsidePath(candidatePath, targetPath, platform = process.platform) {
  // The POSIX branch must be the POSIX implementation, not the host's: a test (or a
  // Windows host simulating a Linux install) passes POSIX paths with `platform: 'linux'`,
  // and the host `resolve`/`relative` would rewrite them as win32 paths and misjudge.
  const pathApi = platform === 'win32' ? windowsPath : posix
  const resolvedTarget = pathApi.resolve(targetPath)
  const resolvedCandidate = pathApi.resolve(candidatePath)
  if (platform === 'win32' && !sameWindowsRoot(resolvedTarget, resolvedCandidate)) {
    return false
  }
  const relativePath = pathApi.relative(resolvedTarget, resolvedCandidate)
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${pathApi.sep}`) && !relativePath.startsWith(pathApi.sep) && relativePath !== '..')
  )
}

function sameWindowsRoot(leftPath, rightPath) {
  return windowsPath.parse(leftPath).root.toLowerCase() === windowsPath.parse(rightPath).root.toLowerCase()
}

function samePath(leftPath, rightPath, platform = process.platform) {
  const pathApi = platform === 'win32' ? windowsPath : posix
  const normalize = (value) => {
    const resolved = pathApi.resolve(String(value))
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(leftPath) === normalize(rightPath)
}

function runCli() {
  if (
    printHelpIfRequested(
      process.argv.slice(2),
      'Usage: uninstall.mjs [--all] [--remove-collector] [--remove-config] [--remove-config-dir] [--remove-hook|--remove-hooks]'
    )
  ) {
    return
  }
  try {
    uninstallClient()
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}

if (isMainModule(import.meta.url)) {
  runCli()
}

// `TOKENBOARD_CONFIG_DIR` is a plain environment variable and the config directory is
// removed recursively, so pointing it at `$HOME` or `/` made `--remove-config-dir` — and
// `--all`, which the skill documents — delete that whole tree, `~/.ssh` and all, silently,
// with no dry run and no prompt.
//
// A TokenBoard config directory is always `~/.tokenboard`, or a `.tokenboard-*` variant for a
// second install. Matching that namespaced prefix — rather than merely "a dot-directory" — is
// what keeps the recursive delete from following a stray `TOKENBOARD_CONFIG_DIR` into `~/.ssh`,
// `~/.aws`, `~/.claude`, `~/.config`, or any other dot-directory the user owns but this tool
// never created. Requiring at least three path segments additionally rejects a filesystem root,
// a bare relative name, and a top-level directory. The other installers do not validate this
// themselves, so the guard belongs here, where the deletion happens.
function assertRemovableConfigDir(runtime) {
  const target = String(runtime.configDir)
  const trimmed = target.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]+/).filter(Boolean)
  const basename = (segments.at(-1) ?? '').toLowerCase()
  const isTokenboardDir = basename === '.tokenboard' || basename.startsWith('.tokenboard-')
  if (!isTokenboardDir || segments.length < 3) {
    throw new Error(
      `Refusing to remove ${target}: the TokenBoard config directory must be the tool's own ~/.tokenboard (or a ~/.tokenboard-* variant), not a home directory, filesystem root, or another dot-directory. Remove it by hand if that is really what you want.`
    )
  }
}

// `TOKENBOARD_COLLECTOR_DIR` is a plain environment variable and the collector checkout is
// removed recursively, so pointing it at `$HOME` or `/` made `--remove-collector` — and
// `--all` — delete that whole tree, `~/.ssh` and all, silently, with no dry run and no
// prompt. The config-directory guard above cannot cover this deletion: it validates a
// different path, and the collector used to be removed before that guard ever ran.
//
// Unlike the config directory, the checkout has no fixed name — an override may point at
// any clone, and the archive fallback install has no `.git` — so identity is checked by
// content: every install path leaves `package.json` beside `skills/tokenboard`, and a
// directory without both markers is refused rather than deleted. The home-directory and
// root checks close the case where a stray variable points at a directory that carries the
// markers only because the repo really was cloned into the user's home.
function assertRemovableCollectorDir(runtime) {
  const target = String(runtime.collectorDir)
  const pathApi = runtime.platform === 'win32' ? windowsPath : posix
  const resolvedTarget = pathApi.resolve(target)
  const segments = resolvedTarget.split(/[\\/]+/).filter(Boolean)
  const isHome = samePath(resolvedTarget, runtime.homeDir, runtime.platform)
  const hasCheckoutMarkers =
    runtime.exists(pathApi.join(resolvedTarget, 'package.json')) &&
    runtime.exists(pathApi.join(resolvedTarget, 'skills', 'tokenboard'))
  if (isHome || segments.length < 2 || !hasCheckoutMarkers) {
    throw new Error(
      `Refusing to remove ${target}: the TokenBoard collector checkout must contain package.json and skills/tokenboard, and must not be a home directory or a filesystem root. Remove it by hand if that is really what you want.`
    )
  }
}
