import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function configDir() {
  return process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

export function configPath() {
  return join(configDir(), 'config.json')
}

export function collectorDir() {
  return process.env.TOKENBOARD_COLLECTOR_DIR || join(configDir(), 'TokenBoard')
}

export function readPackageManager(flags = {}, config = {}) {
  const value =
    flags['package-manager'] ||
    process.env.TOKENBOARD_PACKAGE_MANAGER ||
    config.packageManager ||
    'pnpm'

  if (value === 'pnpm' || value === 'bun' || value === 'npm') {
    return value
  }

  throw new Error(`Unsupported package manager: ${value}. Expected pnpm, bun, or npm.`)
}

export function packageManagerCommand(packageManager) {
  if (process.platform !== 'win32') {
    return packageManager
  }

  return `${packageManager}.cmd`
}

export function packageManagerRunArgs(packageManager, scriptName, scriptArgs = []) {
  if (packageManager === 'npm') {
    return ['run', scriptName, '--', ...scriptArgs]
  }

  return ['run', scriptName, ...scriptArgs]
}

export function readConfig() {
  const file = configPath()
  if (!existsSync(file)) {
    throw new Error(`TokenBoard config not found: ${file}`)
  }

  return JSON.parse(readFileSync(file, 'utf8'))
}

export function writeConfig(config) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

export function mergeConfig(patch) {
  const current = existsSync(configPath()) ? readConfig() : {}
  writeConfig({ ...current, ...patch })
}

export function parseArgs(args) {
  const flags = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[index + 1]
    if (!next || next.startsWith('--')) {
      flags[key] = true
      continue
    }
    flags[key] = next
    index += 1
  }
  return flags
}
