import { join } from 'node:path'
import {
  corepackCommand,
  escapePowerShellSingleQuoted,
  joinForPlatform,
  runStep
} from './upgrade-utils.mjs'

export function runArchiveFallback({
  archiveUrl,
  collectorDir,
  skillDir,
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
