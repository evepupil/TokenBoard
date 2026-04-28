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
