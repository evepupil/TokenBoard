import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import type { CollectorConfig } from './config'
import { collectClaudeCodeUsage } from './providers/claude-code'
import { collectCodexUsage } from './providers/codex'
import { clearPendingUploadCursors, warmHookCursorHighWater } from './providers/session-cursor'
import { uploadSnapshots } from './upload'

type CliCommand = 'preview' | 'sync' | 'warm-hooks'
type CliSource = 'claude-code' | 'codex' | 'all'
type ConcreteCliSource = Exclude<CliSource, 'all'>

type CliEnv = Partial<Record<string, string>>
type SourceFailure = {
  source: ConcreteCliSource
  message: string
}

type CliDeps = {
  stdout: (line: string) => void
  stderr: (line: string) => void
  collectClaudeCodeUsage: typeof collectClaudeCodeUsage
  collectCodexUsage: typeof collectCodexUsage
  uploadSnapshots: typeof uploadSnapshots
  clearPendingUploadCursors?: typeof clearPendingUploadCursors
  warmHookCursorHighWater?: typeof warmHookCursorHighWater
}

const defaultDeps: CliDeps = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  collectClaudeCodeUsage,
  collectCodexUsage,
  uploadSnapshots,
  clearPendingUploadCursors,
  warmHookCursorHighWater
}

export async function runCollectorCli(
  args: string[],
  env: CliEnv = process.env,
  deps: CliDeps = defaultDeps
) {
  try {
    const options = parseArgs(args, env)
    const startedAtMs = Date.now()

    if (options.command === 'warm-hooks') {
      const sources = expandSources(options.source)
      await warmHookCursors(sources, deps, env, startedAtMs, 'all')
      deps.stdout(JSON.stringify({ warmed: sources }, null, 2))
      return 0
    }

    const collectionStartedAtMs = startedAtMs
    const collection = await collectSnapshots(options.source, options.timezone, deps, env)

    if (options.command === 'preview') {
      deps.stdout(JSON.stringify(collection.snapshots, null, 2))
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
      collection.snapshots
    )
    await ackHookCursors(collection.collectedSources, deps, env)
    await warmHookCursors(collection.collectedSources, deps, env, collectionStartedAtMs, options.since)
    deps.stdout(JSON.stringify(result, null, 2))
    if (options.failOnSourceError && collection.sourceFailures.length > 0) {
      deps.stderr(`One or more sources failed: ${formatSourceFailures(collection.sourceFailures)}`)
      return 1
    }
    return 0
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function expandSources(source: CliSource): ConcreteCliSource[] {
  return source === 'all' ? ['claude-code', 'codex'] : [source]
}

async function warmHookCursors(
  collectedSources: CliSource[],
  deps: CliDeps,
  env: CliEnv = process.env,
  highWaterMs = Date.now(),
  since = ''
) {
  if (env.TOKENBOARD_HOOK_MODE === '1') return
  if (since !== 'all') return
  const stateDir = resolveStateDir(env)
  for (const source of collectedSources.filter((item) => item !== 'all')) {
    const sessionsDir = source === 'codex'
      ? join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
      : join(env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || join(homedir(), '.claude'), 'projects')
    await deps.warmHookCursorHighWater?.({ stateDir, source, sessionsDir, highWaterMs })
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
    uploadToken: flags.token ?? env.TOKENBOARD_UPLOAD_TOKEN ?? '',
    since: env.TOKENBOARD_SINCE ?? env.TOKENBOARD_DEFAULT_SINCE ?? '',
    failOnSourceError: env.TOKENBOARD_FAIL_ON_SOURCE_ERROR === '1'
  }
}

async function collectSnapshots(source: CliSource, timezone: string, deps: CliDeps, env: CliEnv = process.env) {
  if (source === 'all') {
    return collectAllSnapshots(timezone, deps, env)
  }

  const snapshots: UsageSnapshot[] = []
  const collectedSources: CliSource[] = []
  const sourceFailures: SourceFailure[] = []
  if (source === 'claude-code') {
    snapshots.push(...(await deps.collectClaudeCodeUsage({ timezone, stderr: deps.stderr })))
    collectedSources.push(source)
  }

  if (source === 'codex') {
    snapshots.push(...(await deps.collectCodexUsage({ timezone, stderr: deps.stderr })))
    collectedSources.push(source)
  }

  return { snapshots, collectedSources, sourceFailures }
}

async function collectAllSnapshots(timezone: string, deps: CliDeps, env: CliEnv = process.env) {
  const snapshots: UsageSnapshot[] = []
  const collectedSources: CliSource[] = []
  const sourceFailures: SourceFailure[] = []
  const failFast = env.TOKENBOARD_HOOK_MODE === '1'
  await collectOptionalSource('claude-code', () => deps.collectClaudeCodeUsage({ timezone, stderr: deps.stderr }), snapshots, collectedSources, sourceFailures, deps, failFast)
  await collectOptionalSource('codex', () => deps.collectCodexUsage({ timezone, stderr: deps.stderr }), snapshots, collectedSources, sourceFailures, deps, failFast)
  return { snapshots, collectedSources, sourceFailures }
}

async function collectOptionalSource(
  source: ConcreteCliSource,
  collect: () => Promise<UsageSnapshot[]>,
  snapshots: UsageSnapshot[],
  collectedSources: CliSource[],
  sourceFailures: SourceFailure[],
  deps: CliDeps,
  failFast = false
) {
  try {
    snapshots.push(...(await collect()))
    collectedSources.push(source)
  } catch (error) {
    if (failFast) throw error
    const message = errorMessage(error)
    sourceFailures.push({ source, message })
    deps.stderr(`Skipping ${source} source: ${message}`)
  }
}

async function ackHookCursors(
  collectedSources: CliSource[],
  deps: CliDeps,
  env: CliEnv = process.env
) {
  if (env.TOKENBOARD_HOOK_MODE !== '1') return
  const stateDir = resolveStateDir(env)

  const sources = collectedSources.filter((source) => source !== 'all')
  for (const source of sources) {
    await deps.clearPendingUploadCursors?.({ stateDir, source })
  }
}

function resolveStateDir(env: CliEnv = process.env) {
  return env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatSourceFailures(failures: SourceFailure[]) {
  return failures.map((failure) => `${failure.source}: ${failure.message}`).join('; ')
}

function readCommand(value: string | undefined): CliCommand {
  if (value === 'preview' || value === 'sync' || value === 'warm-hooks') {
    return value
  }

  throw new Error('Usage: tokenboard <preview|sync|warm-hooks> [--source claude-code|codex|all]')
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
  process.exitCode = exitCode
}
