#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectorDir, configDir, configPath, parseArgs } from './config.mjs'
import { uninstallHooks } from './hooks.mjs'
import { uninstallSchedule } from './uninstall-schedule.mjs'

export function uninstallClient(options = {}) {
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const plan = createUninstallPlan(flags)
  const runtime = createUninstallRuntime(options)

  if (plan.removeHooks) {
    runtime.uninstallHooks(options.hookOptions || {})
  }
  runtime.uninstallSchedule(options.scheduleOptions || {})

  const removed = {
    hook: plan.removeHooks,
    schedule: true,
    collector: false,
    config: false,
    configDir: false
  }

  if (plan.removeCollector && runtime.exists(runtime.collectorDir)) {
    if (!samePath(runtime.collectorDir, runtime.configDir)) {
      removePath(runtime, runtime.collectorDir)
      removed.collector = true
    }
  }

  if (plan.removeConfig && !plan.removeConfigDir && runtime.exists(runtime.configPath)) {
    removePath(runtime, runtime.configPath, { force: true })
    removed.config = true
  }

  if (plan.removeConfigDir && runtime.exists(runtime.configDir)) {
    removePath(runtime, runtime.configDir)
    removed.configDir = true
  }

  runtime.log('TokenBoard client uninstall completed.')
  return removed
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
    exists: options.exists || existsSync,
    rm: options.rm || rmSync,
    cwd: options.cwd || process.cwd,
    chdir: options.chdir || process.chdir,
    fallbackCwd: options.fallbackCwd || homedir(),
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
  if (isInsidePath(runtime.cwd(), targetPath)) {
    runtime.chdir(runtime.fallbackCwd)
  }
}

function isInsidePath(candidatePath, targetPath) {
  const relativePath = relative(resolve(targetPath), resolve(candidatePath))
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith('/') && relativePath !== '..')
}

function samePath(leftPath, rightPath) {
  return resolve(leftPath) === resolve(rightPath)
}

function runCli() {
  try {
    uninstallClient()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
