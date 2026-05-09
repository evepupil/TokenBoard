#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageManager = process.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm'
const command = process.platform === 'win32' ? `${packageManager}.cmd` : packageManager
const args =
  packageManager === 'npm'
    ? ['exec', '--', 'tsx', 'src/cli.ts', ...process.argv.slice(2)]
    : packageManager === 'bun'
      ? ['run', 'tsx', 'src/cli.ts', ...process.argv.slice(2)]
      : ['exec', 'tsx', 'src/cli.ts', ...process.argv.slice(2)]

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
