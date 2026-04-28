#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsx', 'src/cli.ts', ...process.argv.slice(2)],
  {
    cwd: packageDir,
    stdio: 'inherit',
    shell: false
  }
)

process.exit(result.status ?? 1)

