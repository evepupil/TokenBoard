import {
  corepackCommand,
  errorMessage,
  escapePowerShellSingleQuoted,
  joinForPlatform,
  movePath,
  runStep,
  samePath
} from './upgrade-utils.mjs'
import { renameSync, statSync } from 'node:fs'
import { basename, dirname, win32 as windowsPath } from 'node:path'

export function runArchiveFallback({
  archiveUrl,
  archiveUrls,
  collectorDir,
  configDir,
  skillDir,
  workDir,
  platform,
  spawn,
  copy,
  mkdir,
  readDir,
  remove,
  rename = renameSync,
  stat = statSync,
  log = () => {}
}) {
  if (configDir && samePath(skillDir, configDir, platform)) {
    throw new Error(`Refusing to replace TokenBoard config directory as skill install: ${skillDir}`)
  }
  if (configDir && samePath(collectorDir, configDir, platform)) {
    throw new Error(`Refusing to replace TokenBoard config directory as collector checkout: ${collectorDir}`)
  }

  const urls = normalizeArchiveUrls({ archiveUrl, archiveUrls })
  const zipPath = joinForPlatform(workDir, 'tokenboard.zip')
  const extractDir = joinForPlatform(workDir, 'extract')
  const replacementDir = joinForPlatform(workDir, 'TokenBoard')
  recoverOrphanedBackup({ collectorDir, platform, readDir, rename, copy, remove, log })
  const backupDir = selectAvailableBackupPath({ collectorDir, platform, readDir, stat })
  remove(workDir, { recursive: true, force: true })
  mkdir(workDir, { recursive: true })
  let backupCreated = false
  let replacementInstalled = false
  try {
    downloadArchive({ archiveUrls: urls, zipPath, platform, spawn })
    extractArchive({ zipPath, extractDir, platform, spawn, mkdir })
    const extractedRoot = findExtractedRoot({ extractDir, readDir })
    copy(extractedRoot, replacementDir, { recursive: true, force: true })
    runStep(
      {
        command: corepackCommand(platform),
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: replacementDir }
      },
      { spawn, copy, remove, platform }
    )

    try {
      movePath(collectorDir, backupDir, { rename, copy, remove })
      backupCreated = true
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    try {
      movePath(replacementDir, collectorDir, { rename, copy, remove })
      replacementInstalled = true
    } catch (error) {
      if (backupCreated) {
        try {
          remove(collectorDir, { recursive: true, force: true })
          movePath(backupDir, collectorDir, { rename, copy, remove })
          backupCreated = false
        } catch (restoreError) {
          throw new Error(`${errorMessage(error)}; existing collector restore failed: ${errorMessage(restoreError)}`, {
            cause: error
          })
        }
      }
      throw error
    }

    const collectorSkillDir = joinForPlatform(collectorDir, 'skills', 'tokenboard')
    if (!samePath(collectorSkillDir, skillDir, platform)) {
      copy(collectorSkillDir, skillDir, { recursive: true, force: true })
    }
  } catch (error) {
    if (backupCreated) {
      try {
        remove(collectorDir, { recursive: true, force: true })
        movePath(backupDir, collectorDir, { rename, copy, remove })
        backupCreated = false
        replacementInstalled = false
      } catch (restoreError) {
        throw new Error(`${errorMessage(error)}; existing collector restore failed: ${errorMessage(restoreError)}`, {
          cause: error
        })
      }
    } else if (replacementInstalled) {
      try {
        remove(collectorDir, { recursive: true, force: true })
        replacementInstalled = false
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)}; failed to remove incomplete collector: ${errorMessage(cleanupError)}`,
          { cause: error }
        )
      }
    }
    try {
      remove(workDir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; upgrade workspace cleanup failed: ${errorMessage(cleanupError)}`, {
        cause: error
      })
    }
    throw error
  }

  // The replacement is committed once the new collector and installed skill
  // are in place. Temporary workspace cleanup must not roll that replacement
  // back when Windows still has a file open in the extracted checkout.
  try {
    remove(workDir, { recursive: true, force: true })
  } catch (error) {
    log(`TokenBoard collector upgraded, but temporary workspace cleanup failed: ${errorMessage(error)}`)
  }

  if (replacementInstalled && backupCreated) {
    try {
      remove(backupDir, { recursive: true, force: true })
      backupCreated = false
    } catch (error) {
      log(`TokenBoard collector upgraded, but old checkout cleanup failed: ${errorMessage(error)}`)
    }
  }
}

export function recoverOrphanedBackup({ collectorDir, platform, readDir, rename, copy, remove, stat = statSync, log }) {
  const pathApi = platform === 'win32' ? windowsPath : { dirname, basename }
  const parentDir = pathApi.dirname(collectorDir)
  const collectorName = pathApi.basename(collectorDir)
  const backupPrefix = `${collectorName}.tokenboard-upgrade-backup-`
  let entries
  try {
    entries = readDir(parentDir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }

  const normalizedCollectorName = normalizeEntryName(collectorName, platform)
  if (entries.some((entry) => normalizeEntryName(entry.name, platform) === normalizedCollectorName)) return
  const backups = entries
    .filter(
      (entry) => entry.name.startsWith(backupPrefix) && (typeof entry.isDirectory !== 'function' || entry.isDirectory())
    )
    .map((entry) => entry.name)
  if (backups.length === 0) return
  const orderedBackups = backups
    .map((name) => ({ name, mtimeMs: readBackupMtime({ parentDir, name, platform, stat }) }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name))
  const selectedBackup = orderedBackups[0].name
  const backupPath = joinForPlatform(parentDir, selectedBackup)
  movePath(backupPath, collectorDir, { rename, copy, remove })
  if (orderedBackups.length > 1) {
    log(
      `Recovered newest orphaned TokenBoard collector backup before upgrade: ${selectedBackup}; retained ${orderedBackups.length - 1} older backup(s)`
    )
  } else {
    log(`Recovered orphaned TokenBoard collector backup before upgrade: ${selectedBackup}`)
  }
}

export function selectAvailableBackupPath({ collectorDir, platform, readDir, stat = statSync }) {
  const pathApi = platform === 'win32' ? windowsPath : { dirname, basename }
  const parentDir = pathApi.dirname(collectorDir)
  const baseName = `${pathApi.basename(collectorDir)}.tokenboard-upgrade-backup-${process.pid}`
  let names = new Set()
  try {
    names = new Set(
      readDir(parentDir, { withFileTypes: true }).map((entry) => normalizeEntryName(entry.name, platform))
    )
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }

  let suffix = 0
  while (true) {
    const name = suffix === 0 ? baseName : `${baseName}-${suffix}`
    if (!names.has(normalizeEntryName(name, platform))) return joinForPlatform(parentDir, name)
    suffix += 1
  }
}

function readBackupMtime({ parentDir, name, platform, stat }) {
  try {
    const value = stat(joinForPlatform(parentDir, name))
    return Number.isFinite(Number(value?.mtimeMs)) ? Number(value.mtimeMs) : 0
  } catch {
    return 0
  }
}

function normalizeEntryName(value, platform) {
  const name = String(value)
  return platform === 'win32' || platform === 'darwin' ? name.toLowerCase() : name
}

function normalizeArchiveUrls({ archiveUrl, archiveUrls }) {
  const urls = Array.isArray(archiveUrls) && archiveUrls.length > 0 ? archiveUrls : [archiveUrl]
  return urls.filter((url) => typeof url === 'string' && url.trim()).map((url) => url.trim())
}

function downloadArchive({ archiveUrls, zipPath, platform, spawn }) {
  const command = platform === 'win32' ? 'powershell.exe' : 'curl'
  let lastError
  for (const archiveUrl of archiveUrls) {
    const args =
      platform === 'win32'
        ? [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '${escapePowerShellSingleQuoted(archiveUrl)}' -OutFile '${escapePowerShellSingleQuoted(zipPath)}'`
          ]
        : ['-fL', archiveUrl, '-o', zipPath]
    try {
      runExternal(command, args, { spawn, platform })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('No TokenBoard archive URL candidates were provided')
}

function extractArchive({ zipPath, extractDir, platform, spawn, mkdir }) {
  mkdir(extractDir, { recursive: true })
  const command = platform === 'win32' ? 'powershell.exe' : 'unzip'
  const args =
    platform === 'win32'
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
  const entries = readDir(extractDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  if (entries.length !== 1) {
    throw new Error(`Expected one extracted TokenBoard directory in ${extractDir}`)
  }
  return joinForPlatform(extractDir, entries[0].name)
}
