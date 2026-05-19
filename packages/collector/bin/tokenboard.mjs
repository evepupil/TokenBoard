#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (isMain()) {
  const { command, args } = buildInvocation({
    packageManager: process.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm',
    platform: process.platform,
    passthroughArgs: process.argv.slice(2)
  })

  const result = spawnSync(
    command,
    args,
    {
      cwd: packageDir,
      stdio: 'inherit',
      shell: false
    }
  )

  process.exit(result.status ?? 1)
}

export function buildInvocation({
  packageManager = 'pnpm',
  platform = process.platform,
  passthroughArgs = []
} = {}) {
  const command = platform === 'win32' ? windowsCommand(packageManager) : packageManager
  const args =
    packageManager === 'npm'
      ? ['exec', '--', 'tsx', 'src/cli.ts', ...passthroughArgs]
      : packageManager === 'bun'
        ? ['x', 'tsx', 'src/cli.ts', ...passthroughArgs]
        : ['exec', 'tsx', 'src/cli.ts', ...passthroughArgs]

  return { command, args }
}

function windowsCommand(packageManager) {
  return packageManager === 'bun' ? 'bun.exe' : `${packageManager}.cmd`
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}
