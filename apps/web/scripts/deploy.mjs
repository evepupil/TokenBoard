import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const configPath = resolveDeployConfigPath()

run('node', ['scripts/check-production-config.mjs'], {
  ...process.env,
  TOKENBOARD_WRANGLER_CONFIG: configPath
})

run('pnpm', ['run', 'build'])
run('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath])
run('pnpm', ['exec', 'wrangler', 'deploy', '--config', configPath])

function resolveDeployConfigPath() {
  const envPath = process.env.TOKENBOARD_WRANGLER_CONFIG?.trim()
  if (envPath) return envPath

  const privateConfigPath = 'wrangler.production.jsonc'
  if (existsSync(privateConfigPath)) return privateConfigPath

  const generatedConfigPath = 'wrangler.production.ci.jsonc'
  run('node', ['scripts/write-production-config.mjs', 'wrangler.production.example.jsonc', generatedConfigPath])
  return generatedConfigPath
}

function run(command, args, extraEnv) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    cwd: process.cwd()
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
