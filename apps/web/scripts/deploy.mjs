import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const configPath = resolveDeployConfigPath()

runNode(['scripts/check-production-config.mjs'], {
  ...process.env,
  TOKENBOARD_WRANGLER_CONFIG: configPath
})

runPnpm(['run', 'build'])
runPnpm(['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath])
runPnpm([
  'exec',
  'wrangler',
  'd1',
  'execute',
  'DB',
  '--remote',
  '--file',
  'db/verify-critical-schema.sql',
  '--config',
  configPath
])
runPnpm(['exec', 'wrangler', 'deploy', '--config', configPath])

function resolveDeployConfigPath() {
  const envPath = process.env.TOKENBOARD_WRANGLER_CONFIG?.trim()
  if (envPath) return envPath

  const privateConfigPath = 'wrangler.production.jsonc'
  if (existsSync(privateConfigPath)) return privateConfigPath

  const generatedConfigPath = 'wrangler.production.ci.jsonc'
  runNode(['scripts/write-production-config.mjs', 'wrangler.production.example.jsonc', generatedConfigPath])
  return generatedConfigPath
}

function runNode(args, extraEnv) {
  run(process.execPath, args, extraEnv)
}

function runPnpm(args, extraEnv) {
  const packageManagerCli = process.env.TOKENBOARD_PNPM_CLI?.trim() || process.env.npm_execpath?.trim()
  if (packageManagerCli) {
    run(process.execPath, [packageManagerCli, ...args], extraEnv)
    return
  }
  run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, extraEnv)
}

function run(command, args, extraEnv) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    cwd: process.cwd()
  })
  if (result.status !== 0) {
    if (result.error) console.error(`Failed to start ${command}: ${result.error.message}`)
    process.exit(result.status ?? 1)
  }
}
