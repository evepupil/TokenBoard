import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { errorMessage } from './error-message'
import { collectAntigravityCliUsage } from './providers/antigravity-cli'
import {
  collectAntigravityIdeUsage,
  collectAntigravityUsage,
  isAntigravityPartialUsageError
} from './providers/antigravity-gui'
import { isUnavailableLanguageServerError } from './providers/antigravity-gui-environment'
import { collectClaudeCodeUsage } from './providers/claude-code'
import { collectCodexUsage } from './providers/codex'
import { resolveCodexHomes as resolveConfiguredCodexHomes } from './providers/codex-homes'
import { collectDeepSeekHarnessUsage } from './providers/deepseek-harness'
import { collectGrokBuildUsage } from './providers/grok-build'
import { collectOpenCodeUsage } from './providers/opencode'
import { collectPiUsage } from './providers/pi'
import { readCodexHookAcknowledgement, resolveCodexHookCursorPlan } from './providers/codex-hook-profiles'
import { normalizeCodexSymlinkRoots } from './providers/codex-symlink-policy'
import { clearPendingUploadCursors, cursorSnapshotGroupKey, warmHookCursorHighWater } from './providers/session-cursor'
import { withCursorLock } from './providers/session-cursor-store'
import { uploadSnapshots } from './upload'
import { assertValidTimeZone } from './timezone'
import { isAllDateFilter } from './iso-calendar-date'

const concreteCliSources = [
  'claude-code',
  'codex',
  'antigravity-cli',
  'antigravity',
  'antigravity-ide',
  'opencode',
  'pi',
  'grok-build',
  'deepseek-harness'
] as const
const warmHookSources = ['claude-code', 'codex'] as const

type CliCommand = 'preview' | 'sync' | 'warm-hooks'
type CliSource =
  | 'claude-code'
  | 'codex'
  | 'antigravity-cli'
  | 'antigravity'
  | 'antigravity-ide'
  | 'opencode'
  | 'pi'
  | 'grok-build'
  | 'deepseek-harness'
  | 'all'
type ConcreteCliSource = Exclude<CliSource, 'all'>

type CliEnv = Partial<Record<string, string>>
type SourceFailure = {
  fatal: boolean
  source: ConcreteCliSource
  message: string
}

type CollectOptionalSourceOptions = {
  deferFailure?: boolean
  failFast?: boolean
  failOnNonUnavailable?: boolean
  ignoreLanguageServerUnavailable?: boolean
  ignoreUnavailable?: boolean
}

type CollectionContext = {
  timezone: string
  since: string
  until: string
  cursorScope?: string
  deps: CliDeps
  env: CliEnv
}

type CliDeps = {
  stdout: (line: string) => void
  stderr: (line: string) => void
  collectClaudeCodeUsage: typeof collectClaudeCodeUsage
  collectCodexUsage: typeof collectCodexUsage
  collectAntigravityCliUsage?: typeof collectAntigravityCliUsage
  collectAntigravityUsage?: typeof collectAntigravityUsage
  collectAntigravityIdeUsage?: typeof collectAntigravityIdeUsage
  collectOpenCodeUsage?: typeof collectOpenCodeUsage
  collectPiUsage?: typeof collectPiUsage
  collectGrokBuildUsage?: typeof collectGrokBuildUsage
  collectDeepSeekHarnessUsage?: typeof collectDeepSeekHarnessUsage
  uploadSnapshots: typeof uploadSnapshots
  clearPendingUploadCursors?: typeof clearPendingUploadCursors
  warmHookCursorHighWater?: typeof warmHookCursorHighWater
  withCursorLock?: typeof withCursorLock
}

const defaultDeps: CliDeps = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  collectClaudeCodeUsage,
  collectCodexUsage,
  collectAntigravityCliUsage,
  collectAntigravityUsage,
  collectAntigravityIdeUsage,
  collectOpenCodeUsage,
  collectPiUsage,
  collectGrokBuildUsage,
  collectDeepSeekHarnessUsage,
  uploadSnapshots,
  clearPendingUploadCursors,
  warmHookCursorHighWater,
  withCursorLock
}

export async function runCollectorCli(
  args: string[],
  env: CliEnv = process.env,
  deps: CliDeps = defaultDeps
): Promise<number> {
  try {
    const options = parseArgs(args, env)
    if (deps.withCursorLock && env.TOKENBOARD_COLLECTOR_LOCK_HELD !== '1') {
      return await deps.withCursorLock(join(resolveStateDir(env), 'collector-run'), () =>
        runCollectorCli(args, { ...env, TOKENBOARD_COLLECTOR_LOCK_HELD: '1' }, deps)
      )
    }
    const startedAtMs = Date.now()

    if (options.command === 'warm-hooks') {
      const sources = expandSources(options.source)
      await warmHookCursors(sources, deps, env, startedAtMs, 'all')
      deps.stdout(JSON.stringify({ warmed: sources }, null, 2))
      return 0
    }

    if (options.command === 'sync') {
      const missing = [
        options.endpoint ? null : 'TOKENBOARD_ENDPOINT',
        options.uploadToken ? null : 'TOKENBOARD_UPLOAD_TOKEN'
      ].filter((value): value is string => Boolean(value))
      if (missing.length > 0) {
        deps.stderr(`Missing required config for sync: ${missing.join(', ')}`)
        return 1
      }
    }

    const collectionStartedAtMs = startedAtMs
    const cursorScope = options.command === 'sync' ? cursorScopeFromEndpoint(options.endpoint) : undefined
    const collectionContext = {
      timezone: options.timezone,
      since: options.since,
      until: options.until,
      cursorScope,
      deps,
      env
    }
    const collection = await collectSnapshots(options.source, collectionContext)
    const hasFatalSourceFailure = collection.sourceFailures.some((failure) => failure.fatal)
    const shouldFailForSourceErrors =
      (options.failOnSourceError || options.source !== 'all') && collection.sourceFailures.length > 0
    const collectionFailed = hasFatalSourceFailure || shouldFailForSourceErrors

    if (options.command === 'preview') {
      deps.stdout(JSON.stringify(collection.snapshots, null, 2))
      if (collectionFailed) {
        deps.stderr(`One or more sources failed: ${formatSourceFailures(collection.sourceFailures)}`)
        return 1
      }
      return 0
    }

    const result = await deps.uploadSnapshots(
      {
        endpoint: options.endpoint,
        uploadToken: options.uploadToken,
        timezone: options.timezone
      },
      collection.snapshots
    )
    await ackUploadCursors({
      collectedSources: collection.collectedSources,
      cursorScope,
      since: options.since,
      snapshots: collection.snapshots,
      timezone: options.timezone,
      deps,
      env
    })
    await warmHookCursors(collection.collectedSources, deps, env, collectionStartedAtMs, options.since, options.until)
    deps.stdout(JSON.stringify(result, null, 2))
    if (collectionFailed) {
      deps.stderr(`One or more sources failed: ${formatSourceFailures(collection.sourceFailures)}`)
      return 1
    }
    return 0
  } catch (error) {
    deps.stderr(errorMessage(error))
    return 1
  }
}

function expandSources(source: CliSource): ConcreteCliSource[] {
  return source === 'all' ? [...warmHookSources] : [source]
}

async function warmHookCursors(
  collectedSources: CliSource[],
  deps: CliDeps,
  env: CliEnv = process.env,
  highWaterMs = Date.now(),
  since = '',
  until = ''
) {
  if (env.TOKENBOARD_HOOK_MODE === '1') return
  if (!isAllDateFilter(since) || until) return
  const stateDir = resolveStateDir(env)
  for (const source of collectedSources.filter((item) => item !== 'all')) {
    // Only Claude Code and Codex install notification hooks; every other source
    // has no hook cursor to warm and must not fall through to the Claude path.
    if (source !== 'claude-code' && source !== 'codex') continue
    if (source === 'codex') {
      const codexHomes = resolveCodexHomes(env)
      const cursorPlan = await resolveCodexHookCursorPlan({ codexHomes, stateDir })
      for (const [index, codexHome] of codexHomes.entries()) {
        await deps.warmHookCursorHighWater?.({
          stateDir,
          source,
          cursorScope: cursorPlan.cursorScopes[index],
          sessionsDir: join(codexHome, 'sessions'),
          highWaterMs
        })
      }
      continue
    }
    await deps.warmHookCursorHighWater?.({
      stateDir,
      source,
      sessionsDir: join(env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || join(homedir(), '.claude'), 'projects'),
      highWaterMs
    })
  }
}

function parseArgs(args: string[], env: CliEnv) {
  const command = readCommand(args[0])
  const flags = readFlags(args.slice(1))
  const source = readSource(flags.source ?? env.TOKENBOARD_SOURCE ?? 'all')
  const hookMode = env.TOKENBOARD_HOOK_MODE === '1'
  const untilFlag = flags.until
  assertSupportedUntil({
    command,
    source,
    until: untilFlag ?? '',
    hookMode
  })
  const until = untilFlag ?? (supportsUntil({ command, source, hookMode }) ? (env.TOKENBOARD_UNTIL ?? '') : '')
  const timezone = assertValidTimeZone(
    flags.timezone ?? env.TOKENBOARD_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  )

  return {
    command,
    source,
    timezone,
    endpoint: flags.endpoint ?? env.TOKENBOARD_ENDPOINT ?? '',
    uploadToken: flags.token ?? env.TOKENBOARD_UPLOAD_TOKEN ?? '',
    since: flags.since ?? (env.TOKENBOARD_SINCE || env.TOKENBOARD_DEFAULT_SINCE || ''),
    until,
    failOnSourceError: env.TOKENBOARD_FAIL_ON_SOURCE_ERROR === '1'
  }
}

function assertSupportedUntil(input: { command: CliCommand; source: CliSource; until: string; hookMode: boolean }) {
  if (!input.until) return
  if (input.command === 'warm-hooks') {
    throw new Error('--until is not supported for warm-hooks; the command does not collect usage')
  }
  if (input.hookMode) {
    throw new Error('--until is not supported in hook mode; hook sync computes its own incremental window')
  }
  if (!supportsUntil(input)) {
    throw new Error('--until is only supported for Claude Code and Codex sources')
  }
}

function supportsUntil(input: { command: CliCommand; source: CliSource; hookMode: boolean }) {
  return (
    input.command !== 'warm-hooks' && !input.hookMode && (input.source === 'claude-code' || input.source === 'codex')
  )
}

async function collectSnapshots(source: CliSource, context: CollectionContext) {
  if (source === 'all') {
    return collectAllSnapshots(context)
  }

  const snapshots: UsageSnapshot[] = []
  const collectedSources: CliSource[] = []
  const sourceFailures: SourceFailure[] = []
  await collectOptionalSource(
    source,
    () => collectSingleSource(source, context),
    snapshots,
    collectedSources,
    sourceFailures,
    context.deps,
    { failFast: true }
  )

  return { snapshots, collectedSources, sourceFailures }
}

async function collectAllSnapshots(context: CollectionContext) {
  const { cursorScope, deps, env, since, timezone, until } = context
  const snapshots: UsageSnapshot[] = []
  const collectedSources: CliSource[] = []
  const sourceFailures: SourceFailure[] = []
  const hookMode = env.TOKENBOARD_HOOK_MODE === '1'
  const failFast = hookMode
  const standardContext = { timezone, since, until, stderr: deps.stderr }
  await collectOptionalSource(
    'claude-code',
    () => deps.collectClaudeCodeUsage(standardContext),
    snapshots,
    collectedSources,
    sourceFailures,
    deps,
    { failFast }
  )
  await collectOptionalSource(
    'codex',
    () =>
      deps.collectCodexUsage({
        ...standardContext,
        stateDir: resolveStateDir(env),
        codexHomes: resolveCodexHomes(env),
        codexSymlinkRoots: resolveCodexSymlinkRoots(env)
      }),
    snapshots,
    collectedSources,
    sourceFailures,
    deps,
    { failFast }
  )
  if (hookMode) {
    return { snapshots, collectedSources, sourceFailures }
  }
  const antigravityOptions = {
    deferFailure: true,
    failFast,
    failOnNonUnavailable: true,
    ignoreUnavailable: true,
    ignoreLanguageServerUnavailable: env.TOKENBOARD_FAIL_ON_SOURCE_ERROR !== '1'
  }
  const antigravityContext = { timezone, since, stateDir: resolveStateDir(env), cursorScope, stderr: deps.stderr }
  await collectOptionalSource(
    'antigravity-cli',
    () => readAntigravityCollector(deps)(antigravityContext),
    snapshots,
    collectedSources,
    sourceFailures,
    deps,
    antigravityOptions
  )
  await collectOptionalSource(
    'antigravity',
    () => readAntigravityGuiCollector(deps)(antigravityContext),
    snapshots,
    collectedSources,
    sourceFailures,
    deps,
    antigravityOptions
  )
  await collectOptionalSource(
    'antigravity-ide',
    () => readAntigravityIdeCollector(deps)(antigravityContext),
    snapshots,
    collectedSources,
    sourceFailures,
    deps,
    antigravityOptions
  )
  // Tools most users do not have installed: a missing local store is reported as
  // unavailable and skipped rather than failing the whole run.
  const optionalSourceOptions = { deferFailure: true, failFast, failOnNonUnavailable: true, ignoreUnavailable: true }
  await collectOptionalSource(
    'opencode',
    () => readOpenCodeCollector(deps)(standardContext),
    snapshots,
    collectedSources,
    sourceFailures,
    deps,
    optionalSourceOptions
  )
  await collectOptionalSource(
    'pi',
    () => readPiCollector(deps)(standardContext),
    snapshots,
    collectedSources,
    sourceFailures,
    deps,
    optionalSourceOptions
  )
  await collectOptionalSource(
    'grok-build',
    () => readGrokBuildCollector(deps)(standardContext),
    snapshots,
    collectedSources,
    sourceFailures,
    deps,
    optionalSourceOptions
  )
  await collectOptionalSource(
    'deepseek-harness',
    () => readDeepSeekHarnessCollector(deps)(standardContext),
    snapshots,
    collectedSources,
    sourceFailures,
    deps,
    optionalSourceOptions
  )
  return { snapshots, collectedSources, sourceFailures }
}

function readOpenCodeCollector(deps: CliDeps) {
  return deps.collectOpenCodeUsage ?? noopCollector
}

function readPiCollector(deps: CliDeps) {
  return deps.collectPiUsage ?? noopCollector
}

function readGrokBuildCollector(deps: CliDeps) {
  return deps.collectGrokBuildUsage ?? noopCollector
}

function readDeepSeekHarnessCollector(deps: CliDeps) {
  return deps.collectDeepSeekHarnessUsage ?? noopCollector
}

async function noopCollector(): Promise<UsageSnapshot[]> {
  return []
}

function readAntigravityCollector(deps: CliDeps) {
  return deps.collectAntigravityCliUsage ?? noopAntigravityCollector
}

function readAntigravityGuiCollector(deps: CliDeps) {
  return deps.collectAntigravityUsage ?? noopAntigravityCollector
}

function readAntigravityIdeCollector(deps: CliDeps) {
  return deps.collectAntigravityIdeUsage ?? noopAntigravityCollector
}

async function noopAntigravityCollector(): Promise<UsageSnapshot[]> {
  return []
}

function collectSingleSource(source: ConcreteCliSource, context: CollectionContext) {
  const { cursorScope, deps, env, since, timezone, until } = context
  const standardContext = { timezone, since, until, stderr: deps.stderr }
  if (source === 'claude-code') return deps.collectClaudeCodeUsage(standardContext)
  if (source === 'codex') {
    return deps.collectCodexUsage({
      ...standardContext,
      stateDir: resolveStateDir(env),
      codexHomes: resolveCodexHomes(env),
      codexSymlinkRoots: resolveCodexSymlinkRoots(env)
    })
  }
  if (source === 'opencode') return readOpenCodeCollector(deps)(standardContext)
  if (source === 'pi') return readPiCollector(deps)(standardContext)
  if (source === 'grok-build') return readGrokBuildCollector(deps)(standardContext)
  if (source === 'deepseek-harness') return readDeepSeekHarnessCollector(deps)(standardContext)
  const antigravityContext = { timezone, since, stateDir: resolveStateDir(env), cursorScope, stderr: deps.stderr }
  if (source === 'antigravity-cli') return readAntigravityCollector(deps)(antigravityContext)
  if (source === 'antigravity') return readAntigravityGuiCollector(deps)(antigravityContext)
  return readAntigravityIdeCollector(deps)(antigravityContext)
}

async function collectOptionalSource(
  source: ConcreteCliSource,
  collect: () => Promise<UsageSnapshot[]>,
  snapshots: UsageSnapshot[],
  collectedSources: CliSource[],
  sourceFailures: SourceFailure[],
  deps: CliDeps,
  options: CollectOptionalSourceOptions = {}
) {
  try {
    snapshots.push(...(await collect()))
    collectedSources.push(source)
  } catch (error) {
    const message = errorMessage(error)
    if (isAntigravityPartialUsageError(error)) {
      snapshots.push(...error.snapshots)
      collectedSources.push(source)
      sourceFailures.push({ source, message: sourceFailureMessage(source, 'partial', message), fatal: error.fatal })
      deps.stderr(formatAntigravityDiagnostic(source, 'partial', message))
      return
    }
    if (
      options.ignoreUnavailable &&
      isOptionalSourceUnavailable(source, message, options.ignoreLanguageServerUnavailable)
    ) {
      deps.stderr(
        source.startsWith('antigravity')
          ? formatAntigravityDiagnostic(source, 'unavailable', message)
          : `Skipping unavailable ${source} source: ${message}`
      )
      return
    }
    if (options.failFast || (options.failOnNonUnavailable && !options.deferFailure)) {
      throw safeSourceError(source, error, message)
    }
    const fatal = Boolean(options.failOnNonUnavailable)
    sourceFailures.push({
      source,
      message: source.startsWith('antigravity') ? sourceFailureMessage(source, 'failed', message) : message,
      fatal
    })
    if (source.startsWith('antigravity')) {
      deps.stderr(formatAntigravityDiagnostic(source, 'failed', message))
      return
    }
    deps.stderr(`Skipping ${source} source: ${message}`)
  }
}

async function ackUploadCursors(input: {
  collectedSources: CliSource[]
  cursorScope?: string
  since: string
  snapshots: UsageSnapshot[]
  timezone: string
  deps: CliDeps
  env: CliEnv
}) {
  const stateDir = resolveStateDir(input.env)

  const sources = input.collectedSources.filter((source) => source !== 'all')
  for (const source of sources) {
    if (!shouldAckCursor(source, input.env)) continue
    try {
      const cursorScopes = source === 'codex' ? await codexCursorScopes(input.env, stateDir) : [undefined]
      const codexAcknowledgement = source === 'codex' ? readCodexHookAcknowledgement(input.snapshots) : undefined
      for (const cursorScope of cursorScopes) {
        const acknowledgedFiles = codexAcknowledgement?.find((entry) => entry.cursorScope === cursorScope)?.files
        await input.deps.clearPendingUploadCursors?.({
          stateDir,
          source,
          cursorScope: source.startsWith('antigravity') ? input.cursorScope : cursorScope,
          since: source.startsWith('antigravity') ? input.since : undefined,
          timezone: source.startsWith('antigravity') ? input.timezone : undefined,
          acknowledgedSnapshotGroups:
            codexAcknowledgement === undefined ? snapshotGroupsForSource(input.snapshots, source) : undefined,
          acknowledgedSnapshotFiles: codexAcknowledgement === undefined ? undefined : (acknowledgedFiles ?? [])
        })
      }
    } catch (error) {
      throw safeSourceError(source, error, errorMessage(error))
    }
  }
}

function snapshotGroupsForSource(snapshots: UsageSnapshot[], source: ConcreteCliSource) {
  return [
    ...new Set(
      snapshots.filter((snapshot) => snapshot.source === source).map((snapshot) => cursorSnapshotGroupKey(snapshot))
    )
  ]
}

function shouldAckCursor(source: ConcreteCliSource, env: CliEnv) {
  if (source.startsWith('antigravity')) return true
  return env.TOKENBOARD_HOOK_MODE === '1'
}

function resolveStateDir(env: CliEnv = process.env) {
  return env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

async function codexCursorScopes(env: CliEnv, stateDir: string) {
  const codexHomes = resolveCodexHomes(env)
  const plan = await resolveCodexHookCursorPlan({ codexHomes, stateDir })
  return plan.usesProfileCursors ? [undefined, ...plan.cursorScopes] : [undefined]
}

function resolveCodexHomes(env: CliEnv) {
  return resolveConfiguredCodexHomes({
    legacyValue: env.CODEX_HOME,
    jsonValue: env.TOKENBOARD_CODEX_HOMES_JSON
  })
}

function resolveCodexSymlinkRoots(env: CliEnv) {
  const configured = env.TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON
  return configured === undefined ? undefined : normalizeCodexSymlinkRoots(configured)
}

function cursorScopeFromEndpoint(endpoint: string) {
  return endpoint ? new URL(endpoint).origin : undefined
}

function formatAntigravityDiagnostic(
  source: ConcreteCliSource,
  status: 'unavailable' | 'partial' | 'failed',
  message: string
) {
  return `Antigravity collection: source=${source} status=${status} category=${antigravityErrorCategory(message)}`
}

function sourceFailureMessage(source: ConcreteCliSource, status: 'partial' | 'failed', message: string) {
  if (!source.startsWith('antigravity')) return message
  return `status=${status} category=${antigravityErrorCategory(message)}`
}

function safeSourceError(source: ConcreteCliSource, error: unknown, message: string) {
  if (!source.startsWith('antigravity')) return error
  return new Error(formatAntigravityDiagnostic(source, 'failed', message), { cause: error })
}

function antigravityErrorCategory(message: string) {
  if (
    message.includes('Antigravity SQLite metadata cursor reset detected') &&
    message.includes('rerun with --since all')
  ) {
    return 'sqlite-full-baseline-required'
  }
  if (message.toLowerCase().includes('cursor')) return 'cursor-state-failed'
  if (message.includes('Antigravity SQLite reader unavailable')) return 'sqlite-reader-unavailable'
  if (
    message.includes(
      'Antigravity CLI requires --since all before a bounded scan can complete an incomplete SQLite directory scan'
    )
  ) {
    return 'sqlite-full-baseline-required'
  }
  if (
    message.includes('Antigravity CLI --since all requires a complete SQLite directory scan') ||
    message.includes('Antigravity GUI --since all requires a complete SQLite directory scan') ||
    message.includes('Antigravity CLI full history scan could not read every enumerated SQLite database') ||
    message.includes('Antigravity GUI full history scan could not read every enumerated SQLite database')
  ) {
    return 'sqlite-directory-incomplete'
  }
  if (
    message.includes('Antigravity conversations directory not found') ||
    message.includes('No Antigravity conversations found')
  )
    return 'history-unavailable'
  if (isAntigravityMetadataLimitError(message)) return 'metadata-limit-exceeded'
  if (isAntigravityInvalidMetadataError(message)) return 'invalid-metadata'
  if (
    message.includes('Antigravity language server unavailable after DB history was collected') ||
    isUnavailableLanguageServerError(new Error(message))
  ) {
    return 'language-server-unavailable'
  }
  if (message.includes('Failed to read Antigravity SQLite metadata')) return 'sqlite-read-failed'
  if (message.includes('Failed to read Antigravity metadata')) return 'metadata-read-failed'
  return 'collection-failed'
}

function isAntigravityMetadataLimitError(message: string) {
  return (
    message.includes('Antigravity metadata response exceeded the ') ||
    message.includes('Antigravity generator metadata response exceeded the ') ||
    message.includes('Antigravity language server metadata exceeded the ')
  )
}

function isAntigravityInvalidMetadataError(message: string) {
  return (
    message.includes('Invalid Antigravity') ||
    message.includes('Antigravity metadata request returned invalid JSON for ')
  )
}

function formatSourceFailures(failures: SourceFailure[]) {
  return failures.map((failure) => `${failure.source}: ${failure.message}`).join('; ')
}

function isOptionalSourceUnavailable(
  source: ConcreteCliSource,
  message: string,
  ignoreLanguageServerUnavailable = false
) {
  if (source === 'opencode') {
    return message.includes('OpenCode database not found') || message.includes('OpenCode SQLite reader unavailable')
  }
  if (source === 'pi') return message.includes('No Pi sessions found')
  if (source === 'grok-build') return message.includes('No Grok Build sessions found')
  if (source === 'deepseek-harness') return message.includes('No DeepSeek Harness sessions found')
  if (!source.startsWith('antigravity')) return false
  return (
    message.includes('Antigravity SQLite reader unavailable') ||
    (ignoreLanguageServerUnavailable && isUnavailableLanguageServerError(new Error(message))) ||
    message.includes('Antigravity conversations directory not found') ||
    message.includes('No Antigravity conversations found')
  )
}

function readCommand(value: string | undefined): CliCommand {
  if (value === 'preview' || value === 'sync' || value === 'warm-hooks') {
    return value
  }

  throw new Error(
    'Usage: tokenboard <preview|sync|warm-hooks> [--source claude-code|codex|antigravity-cli|antigravity|antigravity-ide|opencode|pi|grok-build|deepseek-harness|all]'
  )
}

function readSource(value: string): CliSource {
  if (value === 'all' || isConcreteCliSource(value)) {
    return value
  }

  throw new Error(`Invalid source: ${value}`)
}

function isConcreteCliSource(value: string): value is ConcreteCliSource {
  return (concreteCliSources as readonly string[]).includes(value)
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
