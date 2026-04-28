import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import type { CollectorConfig } from './config'
import { collectClaudeCodeUsage } from './providers/claude-code'
import { collectCodexUsage } from './providers/codex'
import { uploadSnapshots } from './upload'

type CliCommand = 'preview' | 'sync'
type CliSource = 'claude-code' | 'codex' | 'all'

type CliEnv = Partial<Record<string, string>>

type CliDeps = {
  stdout: (line: string) => void
  stderr: (line: string) => void
  collectClaudeCodeUsage: typeof collectClaudeCodeUsage
  collectCodexUsage: typeof collectCodexUsage
  uploadSnapshots: typeof uploadSnapshots
}

const defaultDeps: CliDeps = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  collectClaudeCodeUsage,
  collectCodexUsage,
  uploadSnapshots
}

export async function runCollectorCli(
  args: string[],
  env: CliEnv = process.env,
  deps: CliDeps = defaultDeps
) {
  try {
    const options = parseArgs(args, env)
    const snapshots = await collectSnapshots(options.source, options.timezone, deps)

    if (options.command === 'preview') {
      deps.stdout(JSON.stringify(snapshots, null, 2))
      return 0
    }

    const missing = [
      options.endpoint ? null : 'TOKENBOARD_ENDPOINT',
      options.uploadToken ? null : 'TOKENBOARD_UPLOAD_TOKEN'
    ].filter((value): value is string => Boolean(value))

    if (missing.length > 0) {
      deps.stderr(`Missing required config for sync: ${missing.join(', ')}`)
      return 1
    }

    const result = await deps.uploadSnapshots(
      {
        endpoint: options.endpoint,
        uploadToken: options.uploadToken,
        timezone: options.timezone
      },
      snapshots
    )
    deps.stdout(JSON.stringify(result, null, 2))
    return 0
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function parseArgs(args: string[], env: CliEnv) {
  const command = readCommand(args[0])
  const flags = readFlags(args.slice(1))
  const source = readSource(flags.source ?? env.TOKENBOARD_SOURCE ?? 'all')
  const timezone = flags.timezone ?? env.TOKENBOARD_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  return {
    command,
    source,
    timezone,
    endpoint: flags.endpoint ?? env.TOKENBOARD_ENDPOINT ?? '',
    uploadToken: flags.token ?? env.TOKENBOARD_UPLOAD_TOKEN ?? ''
  }
}

async function collectSnapshots(source: CliSource, timezone: string, deps: CliDeps) {
  const snapshots: UsageSnapshot[] = []
  if (source === 'claude-code' || source === 'all') {
    snapshots.push(...(await deps.collectClaudeCodeUsage({ timezone })))
  }

  if (source === 'codex' || source === 'all') {
    snapshots.push(...(await deps.collectCodexUsage({ timezone })))
  }

  return snapshots
}

function readCommand(value: string | undefined): CliCommand {
  if (value === 'preview' || value === 'sync') {
    return value
  }

  throw new Error('Usage: tokenboard <preview|sync> [--source claude-code|codex|all]')
}

function readSource(value: string): CliSource {
  if (value === 'claude-code' || value === 'codex' || value === 'all') {
    return value
  }

  throw new Error(`Invalid source: ${value}`)
}

function readFlags(args: string[]) {
  const flags: Record<string, string> = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) {
      continue
    }

    const key = arg.slice(2)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }

    flags[key] = value
    index += 1
  }

  return flags
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await runCollectorCli(process.argv.slice(2))
  process.exit(exitCode)
}
