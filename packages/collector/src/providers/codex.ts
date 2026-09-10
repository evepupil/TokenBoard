import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { errorMessage } from '../error-message'
import { normalizeCcusageDailyJson, readCcusageSessionAttribution } from '../normalize-ccusage'
import { ccusagePackageSpecifier, resolvePackageRunner, type PackageRunner } from '../package-runner'
import {
  codexCommandArgs,
  packageCommandOptions,
  readDailyTimeoutMs,
  readSessionTimeoutMs
} from './codex-command-options'
import {
  createCodexSessionScopeBatchesForFiles,
  createCodexSessionScopeBatches,
  type CodexSessionScope,
  type CodexSessionScopeFileGroup
} from './codex-session-scope'
import {
  fingerprintCodexSessionFile,
  withCodexSessionAttributionCache,
  type CodexSessionAttribution,
  type CodexSessionFileFingerprint
} from './codex-session-attribution-cache'
import { applyCodexSubagentUsageCorrections } from './codex-subagent-usage'
import type { CodexSubagentUsageCacheFile } from './codex-subagent-usage-cache'
import {
  applyCodexContextPricingCosts,
  applyCodexContextPricingUsageModelHints,
  collectCodexContextPricingUsagesFromFiles,
  discoverCodexContextPricingFiles,
  isCodexContextPricingModel,
  isUnresolvedCodexContextPricingSnapshot,
  maxCodexContextPricingFiles,
  normalizeModelId,
  type CodexContextPricingModelHints,
  type CodexContextPricingFileModelHints,
  type CodexContextPricingFileInventory,
  type CodexContextPricingUsage,
  priceCodexContextPricingUsages
} from './codex-context-pricing'
import { assertHookReconciliationSnapshots, isHookMode } from './hook-incremental'
import { attachCodexHookAcknowledgement, collectCodexHookProfiles } from './codex-hook-profiles'
import { resolveCodexHomes as resolveConfiguredCodexHomes } from './codex-homes'
import { normalizeCodexSymlinkRoots } from './codex-symlink-policy'
import { projectCodexDailyCosts } from './codex-cost-projection'
import { mergeSnapshots } from './session-cursor'
import { assertValidDateFilter, assertValidDateFilterRange, isAllDateFilter } from '../iso-calendar-date'

const DEFAULT_CODEX_BATCH_SIZE = 200
const MAX_CODEX_BATCH_SIZE = 1000
const boundedCodexCollectionAttempts = 2
const hookCodexCollectionAttempts = 2
const unboundedCodexCollectionAttempts = 2
const codexHomeIndexKey = '__tokenboardCodexHomeIndex'
const canonicalAttributionChangeMessages = new Set([
  'Codex session changed during scoped collection; retry the sync',
  'Canonical Codex session attribution is missing a bounded session row; retry the sync',
  'Codex child session changed while correcting; retry the sync'
])
const childSessionChangeMessages = new Set([
  'Codex child session changed before reading; retry the sync',
  'Codex child session changed while reading; retry the sync',
  'Codex child session changed while correcting; retry the sync',
  'Codex child session changed while fingerprinting; retry the sync'
])
const contextPricingReconciliationChangePrefixes = [
  'Codex context pricing cannot split mixed-model usage for ',
  'Codex context pricing mixed-model usage exceeds canonical daily snapshot for ',
  'Codex context pricing mixed-model usage has no positive token total for ',
  'Codex context pricing mixed-model cost exceeds context-priced daily usage for ',
  'Codex context pricing mixed-model cost exceeds canonical daily snapshot for '
]

export type CollectCodexUsageOptions = {
  timezone?: string
  collectedAt?: string
  since?: string
  until?: string
  codexHome?: string
  codexHomes?: string[]
  stateDir?: string
  runner?: CommandRunner
  stderr?: (line: string) => void
  codexSymlinkRoots?: readonly string[]
}

export async function collectCodexUsage(options: CollectCodexUsageOptions = {}): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const packageRunner = resolvePackageRunner()
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  if (isHookMode()) {
    return collectCodexHookUsage({
      runner,
      packageRunner,
      options,
      collectedAt
    })
  }

  const requestedSince = options.since ?? readSince()
  const since = isAllDateFilter(requestedSince) ? 'all' : requestedSince
  const until = options.until ?? process.env.TOKENBOARD_UNTIL ?? ''
  const rangeArgs = buildRangeArgs({ since, until })
  const codexHomes = resolveCodexHomesFromOptions(options)
  const codexSymlinkRoots = resolveCodexSymlinkRootsFromOptions(options)
  const requiresCommaSafeScope = !since && !until && codexHomes.some((home) => home.includes(','))
  const usesScopedScan = (isAllDateFilter(since) && !until) || requiresCommaSafeScope
  if (usesScopedScan) {
    return collectScopedCodexUsageWithRetry({
      runner,
      packageRunner,
      rangeArgs,
      since: requiresCommaSafeScope ? 'all' : since,
      until,
      options,
      collectedAt,
      codexHomes,
      codexSymlinkRoots
    })
  }

  const env = { ...process.env, CODEX_HOME: codexHomes.join(',') }
  if (rangeArgs.length > 0) {
    return collectBoundedCodexUsage({
      runner,
      packageRunner,
      rangeArgs,
      since,
      until,
      options,
      collectedAt,
      codexHomes,
      codexSymlinkRoots
    })
  }
  return collectCodexCcusageRange({
    runner,
    packageRunner,
    rangeArgs,
    since,
    until,
    options,
    collectedAt,
    env,
    codexHomes,
    codexSymlinkRoots
  })
}

async function collectScopedCodexUsage(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  codexHomes: string[]
  codexSymlinkRoots?: readonly string[]
  requireScope?: boolean
}) {
  const snapshots: UsageSnapshot[] = []
  const contextPricingUsages: CodexContextPricingUsage[] = []
  let collectedScopes = 0
  for await (const scope of createCodexSessionScopeBatches({
    codexHomes: input.codexHomes,
    codexSymlinkRoots: input.codexSymlinkRoots,
    since: input.since,
    until: input.until,
    batchSize: readBatchSize(),
    onMissingSessionFile: (sessionPath) =>
      input.options.stderr?.(`Skipping Codex session file that disappeared before copy: ${sessionPath}`),
    onCopyFallback: input.options.stderr,
    onProjectionDiagnostic: input.options.stderr
  })) {
    collectedScopes += 1
    try {
      const batch = await collectScopedBatch({
        runner: input.runner,
        packageRunner: input.packageRunner,
        rangeArgs: input.rangeArgs,
        scope,
        codexSymlinkRoots: input.codexSymlinkRoots,
        options: input.options,
        collectedAt: input.collectedAt,
        since: input.since,
        until: input.until
      })
      snapshots.push(...batch.snapshots)
      contextPricingUsages.push(...batch.contextPricingUsages)
      await warmCanonicalAttributionsFromScope({
        stateDir: input.options.stateDir,
        timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        scope,
        sessions: batch.sessions,
        stderr: input.options.stderr
      })
      await assertCodexScopeSourcesUnchanged(scope)
    } finally {
      await scope.cleanup()
    }
  }

  if (input.requireScope && collectedScopes === 0) {
    throw new Error('Codex bounded collection cannot obtain a frozen local session scope; retry the sync')
  }

  const projected = projectCodexDailyCosts(mergeSnapshots(snapshots))
  const rawUsages = mergeContextPricingUsages(contextPricingUsages)
  return applyCollectedCodexContextPricing({
    snapshots: projected,
    usages: rawUsages,
    stderr: input.options.stderr,
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: input.collectedAt
  })
}

async function collectScopedCodexUsageWithRetry(input: Parameters<typeof collectScopedCodexUsage>[0]) {
  for (let attempt = 0; attempt < boundedCodexCollectionAttempts; attempt += 1) {
    try {
      return await collectScopedCodexUsage(input)
    } catch (error) {
      if (attempt + 1 < boundedCodexCollectionAttempts && isCodexReconciliationChange(error)) {
        input.options.stderr?.('Codex context pricing reconciliation changed; retrying the scoped collection once')
        continue
      }
      throw error
    }
  }
  throw new Error('Codex scoped collection retry loop ended unexpectedly')
}

async function collectCodexHookUsage(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  collectedAt: string
}) {
  for (let attempt = 0; attempt < hookCodexCollectionAttempts; attempt += 1) {
    try {
      return await collectCodexHookUsageAttempt(input)
    } catch (error) {
      if (attempt + 1 < hookCodexCollectionAttempts && isCodexReconciliationChange(error)) {
        input.options.stderr?.('Codex child session changed; retrying hook reconciliation once')
        continue
      }
      throw error
    }
  }

  throw new Error('Codex hook reconciliation retry loop ended unexpectedly')
}

async function collectCodexHookUsageAttempt(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  collectedAt: string
}) {
  const codexHomes = resolveCodexHomesFromOptions(input.options)
  const codexSymlinkRoots = resolveCodexSymlinkRootsFromOptions(input.options)
  const timezone = input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const incremental = await collectCodexHookProfiles({
    codexHomes,
    codexSymlinkRoots,
    stateDir: input.options.stateDir,
    stderr: input.options.stderr,
    timezone,
    collectedAt: input.collectedAt
  })

  if (!incremental.changed) {
    return []
  }

  const rangeArgs = incremental.rangeArgs
  const snapshots =
    incremental.rangeArgs.length === 0
      ? []
      : await collectScopedCodexUsage({
          runner: input.runner,
          packageRunner: input.packageRunner,
          rangeArgs,
          ...hookDateBounds(incremental.changedDates),
          options: input.options,
          collectedAt: input.collectedAt,
          codexHomes,
          codexSymlinkRoots,
          requireScope: true
        })
  if (incremental.rangeArgs.length > 0) {
    assertHookReconciliationSnapshots({
      sourceLabel: 'Codex',
      expectedDates: incremental.changedDates,
      expectedKeys: incremental.changedKeys,
      snapshots
    })
  }
  reportUnrecoverablePendingCodexPricing(incremental.unresolvedContextPricingSnapshots ?? [], input.options.stderr)
  const cachedSnapshots = incremental.cachedSnapshots.filter(
    (snapshot) => !isUnresolvedCodexContextPricingSnapshot(snapshot)
  )
  const merged = mergeSnapshots([...snapshots, ...cachedSnapshots])
  return attachCodexHookAcknowledgement(merged, incremental.acknowledgedFilesByCursorScope)
}

function reportUnrecoverablePendingCodexPricing(snapshots: readonly UsageSnapshot[], stderr?: (line: string) => void) {
  const unrecoverable = snapshots.filter((snapshot) => isUnresolvedCodexContextPricingSnapshot(snapshot))
  if (unrecoverable.length === 0) return
  const details = unrecoverable
    .map((snapshot) => `${snapshot.usageDate}/${normalizeModelId(snapshot.model)}`)
    .join(', ')
  const message = `Codex context pricing is unavailable for pending snapshots without source session files; keeping them pending: ${details}`
  stderr?.(message)
}

async function collectCodexCcusageRange(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  env: NodeJS.ProcessEnv
  codexHomes?: string[]
  codexSymlinkRoots?: readonly string[]
}) {
  for (let attempt = 0; attempt < unboundedCodexCollectionAttempts; attempt += 1) {
    try {
      return await collectCodexCcusageRangeAttempt(input)
    } catch (error) {
      if (attempt + 1 < unboundedCodexCollectionAttempts && isCodexReconciliationChange(error)) {
        input.options.stderr?.('Codex session files changed during unbounded collection; retrying once')
        continue
      }
      throw error
    }
  }
  throw new Error('Codex unbounded collection retry loop ended unexpectedly')
}

async function collectCodexCcusageRangeAttempt(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  env: NodeJS.ProcessEnv
  codexHomes?: string[]
  codexSymlinkRoots?: readonly string[]
}) {
  let inventory: CodexContextPricingFileInventory | null = null
  let inventoryError: unknown = null
  try {
    inventory = await discoverCodexContextPricingFiles({
      codexHomes: input.codexHomes ?? resolveCodexHomesFromOptions(input.options),
      codexSymlinkRoots: input.codexSymlinkRoots,
      captureFingerprints: true,
      allowFileOverflow: true
    })
  } catch (error) {
    if (isRejectedSessionRootSymlink(error)) inventoryError = error
    else throw error
  }
  const json = await input.runner(
    input.packageRunner.command,
    input.packageRunner.runPackageArgs(
      ccusagePackageSpecifier,
      'ccusage',
      codexCommandArgs({
        report: 'daily',
        rangeArgs: input.rangeArgs,
        timezone: input.options.timezone
      })
    ),
    packageCommandOptions({
      env: input.env,
      timeoutMs: readDailyTimeoutMs(),
      stderr: input.options.stderr
    })
  )
  const sessions = await collectSessionCounts({
    runner: input.runner,
    command: input.packageRunner.command,
    args: input.packageRunner.runPackageArgs(
      ccusagePackageSpecifier,
      'ccusage',
      codexCommandArgs({
        report: 'session',
        rangeArgs: input.rangeArgs,
        timezone: input.options.timezone
      })
    ),
    options: packageCommandOptions({
      env: input.env,
      timeoutMs: readSessionTimeoutMs(),
      stderr: input.options.stderr
    }),
    stderr: input.options.stderr
  })

  const normalized = await normalizeAndCorrectCodexSnapshots({
    daily: json,
    sessions,
    correctionSessions: sessions,
    codexHomes: input.codexHomes ?? resolveCodexHomesFromOptions(input.options),
    codexSymlinkRoots: input.codexSymlinkRoots,
    options: input.options,
    collectedAt: input.collectedAt,
    includeSessionOnlySnapshots: false
  })
  const projected = projectCodexDailyCosts(normalized)
  if (inventoryError) {
    if (!projected.some((snapshot) => isCodexContextPricingModel(snapshot.model) && snapshot.totalTokens > 0)) {
      return projected
    }
    throw inventoryError
  }
  if (!inventory) {
    if (!projected.some((snapshot) => isCodexContextPricingModel(snapshot.model) && snapshot.totalTokens > 0)) {
      return projected
    }
    throw new Error('Codex context pricing inventory is unavailable')
  }
  if (inventory.overflow) {
    if (!projected.some((snapshot) => isCodexContextPricingModel(snapshot.model) && snapshot.totalTokens > 0)) {
      return projected
    }
    throw new Error(`Codex context pricing scan exceeds ${maxCodexContextPricingFiles} session files`)
  }
  const canonicalSessions = hasDuplicateCodexInventoryPaths({
    codexHomes: input.codexHomes ?? resolveCodexHomesFromOptions(input.options),
    inventory
  })
    ? await collectCanonicalSessionRowsByHome({
        runner: input.runner,
        packageRunner: input.packageRunner,
        options: input.options,
        codexHomes: input.codexHomes ?? resolveCodexHomesFromOptions(input.options)
      })
    : sessions
  assertCodexContextPricingInventoryStable(
    inventory,
    await discoverCodexContextPricingFiles({
      codexHomes: input.codexHomes ?? resolveCodexHomesFromOptions(input.options),
      codexSymlinkRoots: input.codexSymlinkRoots,
      captureFingerprints: true,
      allowFileOverflow: true
    })
  )
  const rawUsages = await collectCodexContextPricingUsagesFromFiles({
    filePaths: inventory.filePaths,
    identityPaths: inventory.identityPaths,
    canonicalModelsByDate: codexContextPricingModelHints(projected),
    canonicalModelsByFile: canonicalModelsByInventoryFiles({
      sessions: canonicalSessions,
      codexHomes: input.codexHomes ?? resolveCodexHomesFromOptions(input.options),
      inventory,
      timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    }),
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    since: input.since,
    until: input.until,
    stderr: input.options.stderr
  })
  assertCodexContextPricingInventoryStable(
    inventory,
    await discoverCodexContextPricingFiles({
      codexHomes: input.codexHomes ?? resolveCodexHomesFromOptions(input.options),
      codexSymlinkRoots: input.codexSymlinkRoots,
      captureFingerprints: true,
      allowFileOverflow: true
    })
  )
  return applyCollectedCodexContextPricing({
    snapshots: projected,
    usages: rawUsages,
    stderr: input.options.stderr,
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: input.collectedAt
  })
}

function assertCodexContextPricingInventoryStable(
  before: CodexContextPricingFileInventory,
  after: CodexContextPricingFileInventory
) {
  if (before.overflow !== after.overflow) {
    throw new Error('Codex session inventory changed during unbounded collection; retry the sync')
  }
  if (before.filePaths.length !== after.filePaths.length) {
    throw new Error('Codex session inventory changed during unbounded collection; retry the sync')
  }
  for (const filePath of before.filePaths) {
    const key = resolve(filePath)
    const beforeFingerprint = before.fingerprints.get(key)
    const afterFingerprint = after.fingerprints.get(key)
    if (
      !beforeFingerprint ||
      !afterFingerprint ||
      !sameCodexContextPricingFingerprint(beforeFingerprint, afterFingerprint)
    ) {
      throw new Error('Codex session inventory changed during unbounded collection; retry the sync')
    }
    if (before.identityPaths.get(key) !== after.identityPaths.get(key)) {
      throw new Error('Codex session inventory changed during unbounded collection; retry the sync')
    }
  }
}

function sameCodexContextPricingFingerprint(left: CodexSessionFileFingerprint, right: CodexSessionFileFingerprint) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.tailSha256 === right.tailSha256
  )
}

function isUnboundedCodexCollectionChange(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === 'Codex session inventory changed during unbounded collection; retry the sync' ||
      error.message.startsWith('Codex session changed while fingerprinting;') ||
      isChildSessionChange(error) ||
      isCodexContextPricingReconciliationChange(error))
  )
}

function isRejectedSessionRootSymlink(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes('session directory') &&
    error.message.includes('symbolic links are not supported')
  )
}

async function collectBoundedCodexUsage(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  codexHomes: string[]
  codexSymlinkRoots?: string[]
}) {
  for (let attempt = 0; attempt < boundedCodexCollectionAttempts; attempt += 1) {
    try {
      return await collectBoundedCodexUsageAttempt(input)
    } catch (error) {
      if (attempt + 1 < boundedCodexCollectionAttempts && isCodexReconciliationChange(error)) {
        input.options.stderr?.('Codex canonical attribution changed; retrying the bounded collection once')
        continue
      }
      throw error
    }
  }

  throw new Error('Codex bounded collection retry loop ended unexpectedly')
}

async function collectBoundedCodexUsageAttempt(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  codexHomes: string[]
  codexSymlinkRoots?: readonly string[]
}) {
  const snapshots: UsageSnapshot[] = []
  const contextPricingUsages: CodexContextPricingUsage[] = []
  const timezone = input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  let collectedScopes = 0
  let missingSessionFiles = 0
  for await (const scope of createCodexSessionScopeBatches({
    codexHomes: input.codexHomes,
    since: input.since,
    until: input.until,
    batchSize: readBatchSize(),
    onMissingSessionFile: (sessionPath) => {
      missingSessionFiles += 1
      input.options.stderr?.(`Skipping Codex session file that disappeared before bounded copy: ${sessionPath}`)
    },
    onCopyFallback: input.options.stderr,
    onProjectionDiagnostic: input.options.stderr,
    codexSymlinkRoots: input.codexSymlinkRoots
  })) {
    collectedScopes += 1
    try {
      const cachedAttributions = await readCachedCanonicalAttributions({
        stateDir: input.options.stateDir,
        timezone,
        scope
      })
      reportCodexDiagnostics(
        input.options.stderr,
        `Codex canonical attribution cache: hits=${cachedAttributions.attributions.size} misses=${cachedAttributions.missingSourceFiles.length}`
      )
      const batch = await collectFrozenBoundedCodexBatch({
        ...input,
        scope,
        timezone,
        cachedAttributions
      })
      snapshots.push(...batch.snapshots)
      contextPricingUsages.push(...batch.contextPricingUsages)
      await warmCanonicalAttributionsFromScope({
        stateDir: input.options.stateDir,
        timezone,
        scope,
        attributions: batch.canonicalAttributions,
        stderr: input.options.stderr
      })
      await assertCodexScopeSourcesUnchanged(scope)
    } finally {
      await scope.cleanup()
    }
  }
  if (collectedScopes === 0 && missingSessionFiles > 0) {
    throw new Error('Codex bounded collection cannot obtain a frozen local session scope; retry the sync')
  }
  const projected = projectCodexDailyCosts(mergeSnapshots(snapshots))
  const rawUsages = mergeContextPricingUsages(contextPricingUsages)
  return applyCollectedCodexContextPricing({
    snapshots: projected,
    usages: rawUsages,
    stderr: input.options.stderr,
    timezone,
    collectedAt: input.collectedAt
  })
}

async function collectFrozenBoundedCodexBatch(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  scope: CodexSessionScope
  timezone: string
  codexSymlinkRoots?: readonly string[]
  cachedAttributions: {
    attributions: ReadonlyMap<string, CodexSessionAttribution>
    missingSourceFiles: string[]
  }
}) {
  const env = { ...process.env, CODEX_HOME: input.scope.codexHome }
  const daily = await input.runner(
    input.packageRunner.command,
    input.packageRunner.runPackageArgs(
      ccusagePackageSpecifier,
      'ccusage',
      codexCommandArgs({
        report: 'daily',
        rangeArgs: input.rangeArgs,
        singleThread: true,
        timezone: input.options.timezone
      })
    ),
    packageCommandOptions({
      env,
      timeoutMs: readDailyTimeoutMs(),
      stderr: input.options.stderr
    })
  )
  const boundedSessions = hasDuplicateScopedSessionRelativePaths(input.scope)
    ? await collectScopedSessionCountsByHome({
        runner: input.runner,
        packageRunner: input.packageRunner,
        options: input.options,
        scope: input.scope,
        rangeArgs: input.rangeArgs
      })
    : await collectSessionCounts({
        runner: input.runner,
        command: input.packageRunner.command,
        args: input.packageRunner.runPackageArgs(
          ccusagePackageSpecifier,
          'ccusage',
          codexCommandArgs({
            report: 'session',
            rangeArgs: input.rangeArgs,
            singleThread: true,
            timezone: input.options.timezone
          })
        ),
        options: packageCommandOptions({
          env,
          timeoutMs: readSessionTimeoutMs(),
          stderr: input.options.stderr
        }),
        stderr: input.options.stderr,
        required: true
      })
  const canonicalAttributions = await collectCanonicalAttributionsForMissingFiles({
    runner: input.runner,
    packageRunner: input.packageRunner,
    options: input.options,
    scope: input.scope,
    sourceFiles: input.cachedAttributions.missingSourceFiles,
    codexSymlinkRoots: input.codexSymlinkRoots
  })
  const sessions = replaceScopedSessionAttributions({
    boundedSessions,
    canonicalAttributions,
    cachedAttributions: input.cachedAttributions.attributions,
    scope: input.scope,
    timezone: input.timezone,
    since: input.since,
    until: input.until
  })
  const snapshots = await normalizeAndCorrectCodexSnapshots({
    daily,
    sessions,
    correctionSessions: boundedSessions,
    codexHomes: input.scope.codexHomes,
    codexSymlinkRoots: input.codexSymlinkRoots,
    options: input.options,
    collectedAt: input.collectedAt,
    includeSessionOnlySnapshots: true,
    subagentCacheFiles: cacheFilesForScope(input.scope)
  })
  const contextPricingUsages = await collectCodexContextPricingUsagesFromFiles({
    filePaths: [...input.scope.sourceFiles.keys()],
    canonicalModelsByDate: codexContextPricingModelHints(snapshots),
    canonicalModelsByFile: canonicalModelsByScopedFile({
      scope: input.scope,
      attributions: new Map([...input.cachedAttributions.attributions, ...canonicalAttributions])
    }),
    timezone: input.timezone,
    since: input.since,
    until: input.until,
    stderr: input.options.stderr
  })
  return {
    snapshots,
    contextPricingUsages,
    canonicalAttributions
  }
}

async function readCachedCanonicalAttributions(input: {
  stateDir?: string
  timezone: string
  scope: CodexSessionScope
}) {
  const sourceFiles = [...input.scope.sourceFileFingerprints.keys()]
  if (!input.stateDir || sourceFiles.length === 0) {
    return {
      attributions: new Map<string, CodexSessionAttribution>(),
      missingSourceFiles: sourceFiles
    }
  }
  const attributions = await withCodexSessionAttributionCache({
    stateDir: input.stateDir,
    timezone: input.timezone,
    callback: async (cache) => {
      const attributions = new Map<string, CodexSessionAttribution>()
      for (const [sourceFile, fingerprint] of input.scope.sourceFileFingerprints) {
        const attribution = cache.lookupByFingerprint({ filePath: sourceFile, fingerprint })
        if (attribution) attributions.set(sourceFile, attribution)
      }
      return attributions
    }
  })
  return {
    attributions,
    missingSourceFiles: sourceFiles.filter((sourceFile) => !attributions.has(sourceFile))
  }
}

async function collectCanonicalAttributionsForMissingFiles(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  scope: CodexSessionScope
  sourceFiles: string[]
  codexSymlinkRoots?: readonly string[]
}) {
  const attributions = new Map<string, CodexSessionAttribution>()
  if (input.sourceFiles.length === 0) return attributions

  const frozenFileToSourceFile = new Map<string, string>()
  const groups: CodexSessionScopeFileGroup[] = input.sourceFiles.map((sourceFile) => {
    const homeIndex = input.scope.sourceFileHomeIndexes.get(sourceFile)
    const codexHome = homeIndex === undefined ? undefined : input.scope.codexHomes[homeIndex]
    const frozenFile = scopedFileForSourceFile(sourceFile, input.scope.sourceFiles)
    if (!codexHome || !frozenFile) {
      throw new Error('Codex canonical attribution lost its source profile mapping')
    }
    frozenFileToSourceFile.set(frozenFile, sourceFile)
    return { files: [{ codexHome, filePath: frozenFile }] }
  })

  reportCodexDiagnostics(input.options.stderr, `Codex canonical attribution scan: files=${input.sourceFiles.length}`)
  if (input.sourceFiles.length === input.scope.sourceFileFingerprints.size) {
    return collectCanonicalAttributionsFromScope({
      runner: input.runner,
      packageRunner: input.packageRunner,
      options: input.options,
      scope: input.scope
    })
  }

  for await (const scope of createCodexSessionScopeBatchesForFiles({
    codexHomes: input.scope.codexHomes,
    groups,
    batchSize: readBatchSize(),
    codexSymlinkRoots: input.codexSymlinkRoots,
    onMissingSessionFile: (sessionPath) =>
      input.options.stderr?.(
        `Skipping Codex session file that disappeared before canonical attribution: ${sessionPath}`
      ),
    onCopyFallback: input.options.stderr,
    onProjectionDiagnostic: input.options.stderr
  })) {
    try {
      const scopedAttributions = await collectCanonicalAttributionsFromScope({
        runner: input.runner,
        packageRunner: input.packageRunner,
        options: input.options,
        scope
      })
      await assertCodexScopeSourcesUnchanged(scope)
      for (const [frozenFile, attribution] of scopedAttributions) {
        const sourceFile = frozenFileToSourceFile.get(frozenFile)
        if (!sourceFile) {
          throw new Error('Codex canonical attribution lost its frozen source-file mapping')
        }
        attributions.set(sourceFile, attribution)
      }
    } finally {
      await scope.cleanup()
    }
  }
  return attributions
}

async function collectCanonicalAttributionsFromScope(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  scope: CodexSessionScope
}) {
  const attributions = new Map<string, CodexSessionAttribution>()
  const activeHomeIndexes = scopedSessionHomeIndexes(input.scope)
  const homeIndexes =
    hasDuplicateScopedSessionRelativePaths(input.scope) || activeHomeIndexes.length < input.scope.codexHomes.length
      ? activeHomeIndexes
      : [undefined]
  for (const homeIndex of homeIndexes) {
    const sessions = await collectSessionCounts({
      runner: input.runner,
      command: input.packageRunner.command,
      args: input.packageRunner.runPackageArgs(
        ccusagePackageSpecifier,
        'ccusage',
        codexCommandArgs({
          report: 'session',
          singleThread: true,
          timezone: input.options.timezone
        })
      ),
      options: packageCommandOptions({
        env: {
          ...process.env,
          CODEX_HOME: homeIndex === undefined ? input.scope.codexHome : input.scope.codexHomes[homeIndex]
        },
        timeoutMs: readSessionTimeoutMs(),
        stderr: input.options.stderr
      }),
      stderr: input.options.stderr,
      required: true
    })
    for (const row of readSessionRows(sessions)) {
      const sourceFile = resolveScopedSessionSourceFile(row, input.scope, homeIndex)
      const attribution = readCcusageSessionAttribution(
        row,
        input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        'codex'
      )
      if (sourceFile && attribution) attributions.set(sourceFile, attribution)
    }
  }
  return attributions
}

async function collectScopedSessionCountsByHome(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  scope: CodexSessionScope
  rangeArgs: string[]
}) {
  const rows: Record<string, unknown>[] = []
  for (const homeIndex of scopedSessionHomeIndexes(input.scope)) {
    const sessions = await collectSessionCounts({
      runner: input.runner,
      command: input.packageRunner.command,
      args: input.packageRunner.runPackageArgs(
        ccusagePackageSpecifier,
        'ccusage',
        codexCommandArgs({
          report: 'session',
          rangeArgs: input.rangeArgs,
          singleThread: true,
          timezone: input.options.timezone
        })
      ),
      options: packageCommandOptions({
        env: { ...process.env, CODEX_HOME: input.scope.codexHomes[homeIndex] },
        timeoutMs: readSessionTimeoutMs(),
        stderr: input.options.stderr
      }),
      stderr: input.options.stderr,
      required: true
    })
    for (const row of readSessionRows(sessions)) {
      rows.push({ ...row, [codexHomeIndexKey]: homeIndex })
    }
  }
  return { sessions: rows }
}

function reportCodexDiagnostics(stderr: ((line: string) => void) | undefined, line: string) {
  if (process.env.TOKENBOARD_COLLECTOR_DIAGNOSTICS === '1') stderr?.(line)
}

function mergeContextPricingUsages(usages: readonly CodexContextPricingUsage[]) {
  const merged = new Map<string, CodexContextPricingUsage>()
  for (const usage of usages) {
    const model = normalizeModelId(usage.model)
    const attributedModel = usage.attributedModel ? normalizeModelId(usage.attributedModel) : ''
    const key = `${usage.usageDate}\u0000${model}\u0000${attributedModel}\u0000${usage.serviceTier ?? 'standard'}\u0000${usage.contextTier}`
    const current = merged.get(key)
    if (current) {
      current.inputTokens += usage.inputTokens
      current.uncachedInputTokens += usage.uncachedInputTokens
      current.outputTokens += usage.outputTokens
      current.cacheReadTokens += usage.cacheReadTokens
      current.cacheCreationTokens += usage.cacheCreationTokens
      current.totalTokens =
        current.totalTokens === undefined || usage.totalTokens === undefined
          ? undefined
          : current.totalTokens + usage.totalTokens
    } else {
      merged.set(key, { ...usage, model })
    }
  }
  return [...merged.values()]
}

function splitMixedCodexContextPricingSnapshots(
  snapshots: readonly UsageSnapshot[],
  usages: readonly CodexContextPricingUsage[],
  costs: readonly { usageDate: string; model: string; costUsd: number }[],
  stderr: ((line: string) => void) | undefined,
  timezone: string,
  collectedAt: string
) {
  const contextEntries = new Map<
    string,
    {
      snapshot: UsageSnapshot
      attributedUsages: Map<
        string,
        {
          inputTokens: number
          outputTokens: number
          cacheCreationTokens: number
          cacheReadTokens: number
          totalTokens: number
          costUsd: number
        }
      >
    }
  >()
  for (const usage of usages) {
    const attributedModel = usage.attributedModel
    if (!attributedModel) continue
    const model = normalizeModelId(usage.model)
    const normalizedAttributedModel = normalizeModelId(attributedModel)
    const key = `${usage.usageDate}\u0000${model}`
    const current = contextEntries.get(key)
    const inputTokens = usage.inputTokens
    const outputTokens = usage.outputTokens
    const cacheCreationTokens = usage.cacheCreationTokens
    const cacheReadTokens = usage.cacheReadTokens
    const totalTokens = usage.totalTokens ?? inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
    const usageCost = priceCodexContextPricingUsages([usage])[0]?.costUsd ?? 0
    if (current) {
      current.snapshot.inputTokens += inputTokens
      current.snapshot.outputTokens += outputTokens
      current.snapshot.cacheCreationTokens += cacheCreationTokens
      current.snapshot.cacheReadTokens += cacheReadTokens
      current.snapshot.totalTokens += totalTokens
      addMixedContextUsage(current.attributedUsages, normalizedAttributedModel, {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens,
        costUsd: usageCost
      })
    } else {
      const attributedUsages = new Map<
        string,
        {
          inputTokens: number
          outputTokens: number
          cacheCreationTokens: number
          cacheReadTokens: number
          totalTokens: number
          costUsd: number
        }
      >()
      addMixedContextUsage(attributedUsages, normalizedAttributedModel, {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens,
        costUsd: usageCost
      })
      contextEntries.set(key, {
        attributedUsages,
        snapshot: {
          source: 'codex',
          usageDate: usage.usageDate,
          timezone,
          model,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          totalTokens,
          costUsd: 0,
          sessionCount: 0,
          collectedAt
        }
      })
    }
  }

  if (contextEntries.size === 0) return [...snapshots]
  const result = snapshots.map((snapshot) => ({ ...snapshot }))
  const canonicalContextSnapshots = new Set<UsageSnapshot>()
  const costsByKey = new Map(
    costs.map((cost) => [`${cost.usageDate}\u0000${normalizeModelId(cost.model)}`, cost.costUsd])
  )
  for (const { snapshot: contextSnapshot, attributedUsages } of contextEntries.values()) {
    const existingContextSnapshot = result.find(
      (snapshot) =>
        snapshot.usageDate === contextSnapshot.usageDate &&
        normalizeModelId(snapshot.model) === normalizeModelId(contextSnapshot.model)
    )
    if (existingContextSnapshot) {
      // A same-day context row may already exist for sessions that ccusage
      // attributed directly to the context-priced model. Mixed sessions still
      // need to be removed from their non-context canonical rows and merged
      // into that existing row before its corrected cost is applied.
      existingContextSnapshot.inputTokens += contextSnapshot.inputTokens
      existingContextSnapshot.outputTokens += contextSnapshot.outputTokens
      existingContextSnapshot.cacheCreationTokens += contextSnapshot.cacheCreationTokens
      existingContextSnapshot.cacheReadTokens += contextSnapshot.cacheReadTokens
      existingContextSnapshot.totalTokens += contextSnapshot.totalTokens
    }
    const canonicalEntries: Array<{
      canonical: UsageSnapshot
      usage: {
        inputTokens: number
        outputTokens: number
        cacheCreationTokens: number
        cacheReadTokens: number
        totalTokens: number
        costUsd: number
      }
    }> = []
    let totalAttributedTokens = 0
    let totalMixedCost = 0
    for (const [attributedModel, attributedUsage] of attributedUsages) {
      const canonical = result.find(
        (snapshot) =>
          snapshot.usageDate === contextSnapshot.usageDate && normalizeModelId(snapshot.model) === attributedModel
      )
      if (!canonical) {
        const message = `Codex context pricing cannot split mixed-model usage for ${contextSnapshot.usageDate}/${contextSnapshot.model}`
        stderr?.(message)
        throw new Error(message)
      }
      if (
        attributedUsage.inputTokens > canonical.inputTokens ||
        attributedUsage.outputTokens > canonical.outputTokens ||
        attributedUsage.cacheCreationTokens > canonical.cacheCreationTokens ||
        attributedUsage.cacheReadTokens > canonical.cacheReadTokens ||
        attributedUsage.totalTokens > canonical.totalTokens
      ) {
        const message = `Codex context pricing mixed-model usage exceeds canonical daily snapshot for ${contextSnapshot.usageDate}`
        stderr?.(message)
        throw new Error(message)
      }
      canonicalEntries.push({ canonical, usage: attributedUsage })
      totalAttributedTokens += attributedUsage.totalTokens
      totalMixedCost += attributedUsage.costUsd
    }
    const contextCost =
      costsByKey.get(`${contextSnapshot.usageDate}\u0000${normalizeModelId(contextSnapshot.model)}`) ?? 0
    if (!Number.isSafeInteger(totalAttributedTokens) || totalAttributedTokens <= 0) {
      const message = `Codex context pricing mixed-model usage has no positive token total for ${contextSnapshot.usageDate}`
      stderr?.(message)
      throw new Error(message)
    }
    if (!Number.isFinite(totalMixedCost) || totalMixedCost < 0 || totalMixedCost > contextCost + 1e-12) {
      const message = `Codex context pricing mixed-model cost exceeds context-priced daily usage for ${contextSnapshot.usageDate}`
      stderr?.(message)
      throw new Error(message)
    }
    for (const entry of canonicalEntries) {
      const amount = entry.usage.costUsd
      if (!Number.isFinite(amount) || amount < 0 || amount > entry.canonical.costUsd + 1e-12) {
        const message = `Codex context pricing mixed-model cost exceeds canonical daily snapshot for ${contextSnapshot.usageDate}`
        stderr?.(message)
        throw new Error(message)
      }
      entry.canonical.inputTokens -= entry.usage.inputTokens
      entry.canonical.outputTokens -= entry.usage.outputTokens
      entry.canonical.cacheCreationTokens -= entry.usage.cacheCreationTokens
      entry.canonical.cacheReadTokens -= entry.usage.cacheReadTokens
      entry.canonical.totalTokens -= entry.usage.totalTokens
      entry.canonical.costUsd = Math.max(0, entry.canonical.costUsd - amount)
      canonicalContextSnapshots.add(entry.canonical)
    }
    if (existingContextSnapshot) {
      existingContextSnapshot.costUsd = contextCost
    } else {
      contextSnapshot.costUsd = contextCost
      result.push(contextSnapshot)
    }
  }

  for (const canonical of canonicalContextSnapshots) {
    if (
      canonical.inputTokens !== 0 ||
      canonical.outputTokens !== 0 ||
      canonical.cacheCreationTokens !== 0 ||
      canonical.cacheReadTokens !== 0 ||
      canonical.totalTokens !== 0
    ) {
      continue
    }
    canonical.correction = 'codex-context-pricing'
  }
  return result
}

function addMixedContextUsage(
  usages: Map<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheCreationTokens: number
      cacheReadTokens: number
      totalTokens: number
      costUsd: number
    }
  >,
  attributedModel: string,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens: number
    cacheReadTokens: number
    totalTokens: number
    costUsd: number
  }
) {
  const current = usages.get(attributedModel)
  if (current) {
    current.inputTokens += usage.inputTokens
    current.outputTokens += usage.outputTokens
    current.cacheCreationTokens += usage.cacheCreationTokens
    current.cacheReadTokens += usage.cacheReadTokens
    current.totalTokens += usage.totalTokens
    current.costUsd += usage.costUsd
    return
  }
  usages.set(attributedModel, { ...usage })
}

function applyCollectedCodexContextPricing(input: {
  snapshots: readonly UsageSnapshot[]
  usages: readonly CodexContextPricingUsage[]
  stderr?: (line: string) => void
  timezone: string
  collectedAt: string
}) {
  const mappedUsages = applyCodexContextPricingUsageModelHints(
    input.usages,
    codexContextPricingModelHints(input.snapshots)
  )
  const costs = priceCodexContextPricingUsages(mappedUsages)
  const split = splitMixedCodexContextPricingSnapshots(
    input.snapshots,
    mappedUsages,
    costs,
    input.stderr,
    input.timezone,
    input.collectedAt
  )
  return applyCodexContextPricingCosts(split, costs, input.stderr)
}

function codexContextPricingModelHints(snapshots: readonly UsageSnapshot[]): CodexContextPricingModelHints {
  const hints = new Map<string, Set<string>>()
  for (const snapshot of snapshots) {
    if (snapshot.totalTokens <= 0 || !isCodexContextPricingModel(snapshot.model)) continue
    const models = hints.get(snapshot.usageDate) ?? new Set<string>()
    models.add(normalizeModelId(snapshot.model))
    hints.set(snapshot.usageDate, models)
  }
  return hints
}

function isCanonicalAttributionChange(error: unknown) {
  return (
    error instanceof Error &&
    (canonicalAttributionChangeMessages.has(error.message) || isCodexContextPricingReconciliationChange(error))
  )
}

function isChildSessionChange(error: unknown) {
  return error instanceof Error && childSessionChangeMessages.has(error.message)
}

function isCodexContextPricingReconciliationChange(error: unknown) {
  return (
    error instanceof Error &&
    contextPricingReconciliationChangePrefixes.some((prefix) => error.message.startsWith(prefix))
  )
}

function isCodexReconciliationChange(error: unknown) {
  return isUnboundedCodexCollectionChange(error) || isCanonicalAttributionChange(error)
}

async function normalizeAndCorrectCodexSnapshots(input: {
  daily: unknown
  sessions: unknown
  correctionSessions: unknown
  codexHomes: string[]
  codexSymlinkRoots?: readonly string[]
  options: CollectCodexUsageOptions
  collectedAt: string
  includeSessionOnlySnapshots: boolean
  subagentCacheFiles?: ReadonlyMap<string, CodexSubagentUsageCacheFile>
}) {
  const snapshots = normalizeCcusageDailyJson(input.daily, {
    source: 'codex',
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: input.collectedAt,
    sessions: input.sessions,
    includeSessionOnlySnapshots: input.includeSessionOnlySnapshots
  })
  return applyCodexSubagentUsageCorrections({
    snapshots,
    sessions: input.correctionSessions,
    codexHomes: input.codexHomes,
    codexSymlinkRoots: input.codexSymlinkRoots,
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    stderr: input.options.stderr,
    stateDir: input.options.stateDir,
    cacheFiles: input.subagentCacheFiles
  })
}

function readSessionRows(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const record = input as Record<string, unknown>
  for (const key of ['sessions', 'data', 'rows', 'items']) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value.filter(
        (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row)
      )
    }
  }
  return []
}

function resolveScopedSessionSourceFile(row: Record<string, unknown>, scope: CodexSessionScope, homeIndex?: number) {
  const rowHomeIndex =
    typeof row[codexHomeIndexKey] === 'number' && Number.isSafeInteger(row[codexHomeIndexKey])
      ? (row[codexHomeIndexKey] as number)
      : undefined
  const resolvedHomeIndex = homeIndex ?? rowHomeIndex
  const codexHomes =
    resolvedHomeIndex === undefined
      ? scope.codexHomes
      : [scope.codexHomes[resolvedHomeIndex]].filter((value): value is string => Boolean(value))
  for (const codexHome of codexHomes) {
    for (const directory of ['sessions', 'archived_sessions']) {
      const file = resolveSessionFileFromRow(row, join(codexHome, directory))
      if (!file) continue
      const sourceFile = scope.sourceFiles.get(file)
      if (sourceFile) return sourceFile
    }
  }
  return null
}

function hasDuplicateScopedSessionRelativePaths(scope: CodexSessionScope) {
  const relativePaths = new Set<string>()
  for (const [scopedFile, sourceFile] of scope.sourceFiles) {
    const homeIndex = scope.sourceFileHomeIndexes.get(sourceFile)
    if (homeIndex === undefined) continue
    const relativePath = relative(scope.codexHomes[homeIndex], scopedFile)
    if (relativePaths.has(relativePath)) return true
    relativePaths.add(relativePath)
  }
  return false
}

function scopedSessionHomeIndexes(scope: CodexSessionScope) {
  return [
    ...new Set(
      [...scope.sourceFiles.values()]
        .map((sourceFile) => scope.sourceFileHomeIndexes.get(sourceFile))
        .filter((value): value is number => value !== undefined)
    )
  ].sort((left, right) => left - right)
}

function resolveSessionFileFromRow(row: Record<string, unknown>, root: string) {
  const directory = typeof row.directory === 'string' ? row.directory : ''
  const sessionFile = typeof row.sessionFile === 'string' ? row.sessionFile : ''
  const sessionId = typeof row.sessionId === 'string' ? row.sessionId : ''
  const name = sessionFile || sessionId
  if (!name) return null
  if (!isSafeSessionDirectory(directory)) return null
  const filename = name.endsWith('.jsonl') ? name : `${name}.jsonl`
  const file = resolve(root, directory, filename)
  return isPathInside(root, file) ? file : null
}

function isSafeSessionDirectory(directory: string) {
  return !isAbsolute(directory) && !directory.split(/[\\/]+/).some((segment) => segment === '..')
}

function isPathInside(parent: string, child: string) {
  const relativePath = relative(parent, child)
  return !isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
}

function replaceScopedSessionAttributions(input: {
  boundedSessions: unknown
  canonicalAttributions: ReadonlyMap<string, CodexSessionAttribution>
  cachedAttributions: ReadonlyMap<string, CodexSessionAttribution>
  scope: CodexSessionScope
  timezone: string
  since?: string
  until?: string
}) {
  const canonicalBySourceFile = new Map(input.cachedAttributions)
  for (const [sourceFile, attribution] of input.canonicalAttributions) {
    canonicalBySourceFile.set(sourceFile, attribution)
  }
  const canonicalDateRange = {
    since: dateFilterToIso(input.since, true),
    until: dateFilterToIso(input.until)
  }
  return mapSessionRows(input.boundedSessions, (row) => {
    const sourceFile = resolveScopedSessionSourceFile(row, input.scope)
    const attribution = sourceFile ? canonicalBySourceFile.get(sourceFile) : null
    if (!attribution) {
      throw new Error('Canonical Codex session attribution is missing a bounded session row; retry the sync')
    }
    return {
      ...row,
      ...(isDateWithinCodexRange(attribution.usageDate, canonicalDateRange)
        ? { lastActivity: attribution.usageDate }
        : {}),
      models: { [attribution.model]: { totalTokens: 1 } }
    }
  })
}

function isDateWithinCodexRange(usageDate: string, range: { since: string | null; until: string | null }) {
  return (!range.since || usageDate >= range.since) && (!range.until || usageDate <= range.until)
}

function dateFilterToIso(value: string | undefined, allowAll = false) {
  if (!value || (allowAll && isAllDateFilter(value))) return null
  const compact = assertValidDateFilter(value, 'Codex bounded date').replaceAll('-', '')
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}

function mapSessionRows(input: unknown, transform: (row: Record<string, unknown>) => Record<string, unknown>) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  for (const key of ['sessions', 'data', 'rows', 'items']) {
    if (Array.isArray(record[key])) {
      return {
        ...record,
        [key]: record[key].map((row) =>
          row && typeof row === 'object' && !Array.isArray(row) ? transform(row as Record<string, unknown>) : row
        )
      }
    }
  }
  return input
}

async function collectScopedBatch(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  scope: CodexSessionScope
  codexSymlinkRoots?: readonly string[]
  options: CollectCodexUsageOptions
  collectedAt: string
  since?: string
  until?: string
}) {
  const env = { ...process.env, CODEX_HOME: input.scope.codexHome }
  const daily = await input.runner(
    input.packageRunner.command,
    input.packageRunner.runPackageArgs(
      ccusagePackageSpecifier,
      'ccusage',
      codexCommandArgs({
        report: 'daily',
        rangeArgs: input.rangeArgs,
        singleThread: true,
        timezone: input.options.timezone
      })
    ),
    packageCommandOptions({
      env,
      timeoutMs: readDailyTimeoutMs(),
      stderr: input.options.stderr
    })
  )
  const sessions = await collectSessionCounts({
    runner: input.runner,
    command: input.packageRunner.command,
    args: input.packageRunner.runPackageArgs(
      ccusagePackageSpecifier,
      'ccusage',
      codexCommandArgs({
        report: 'session',
        rangeArgs: input.rangeArgs,
        singleThread: true,
        timezone: input.options.timezone
      })
    ),
    options: packageCommandOptions({
      env,
      timeoutMs: readSessionTimeoutMs(),
      stderr: input.options.stderr
    }),
    stderr: input.options.stderr
  })
  const snapshots = await normalizeAndCorrectCodexSnapshots({
    daily,
    sessions,
    correctionSessions: sessions,
    codexHomes: input.scope.codexHomes,
    codexSymlinkRoots: input.codexSymlinkRoots,
    options: input.options,
    collectedAt: input.collectedAt,
    includeSessionOnlySnapshots: false,
    subagentCacheFiles: cacheFilesForScope(input.scope)
  })
  const contextPricingUsages = await collectCodexContextPricingUsagesFromFiles({
    filePaths: [...input.scope.sourceFiles.keys()],
    canonicalModelsByDate: codexContextPricingModelHints(snapshots),
    canonicalModelsByFile: canonicalModelsByScopedFileFromSessionRows({
      sessions,
      scope: input.scope,
      timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    }),
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    since: input.since,
    until: input.until,
    stderr: input.options.stderr
  })
  return {
    snapshots,
    sessions,
    contextPricingUsages
  }
}

async function warmCanonicalAttributionsFromScope(input: {
  stateDir?: string
  timezone: string
  scope: CodexSessionScope
  sessions?: unknown
  attributions?: ReadonlyMap<string, CodexSessionAttribution>
  stderr?: (line: string) => void
}) {
  if (!input.stateDir) return
  const attributions = new Map(input.attributions)
  if (!input.attributions) {
    for (const row of readSessionRows(input.sessions)) {
      const sourceFile = resolveScopedSessionSourceFile(row, input.scope)
      const attribution = readCcusageSessionAttribution(row, input.timezone, 'codex')
      if (sourceFile && attribution) attributions.set(sourceFile, attribution)
    }
  }
  if (attributions.size === 0) return
  await withCodexSessionAttributionCache({
    stateDir: input.stateDir,
    timezone: input.timezone,
    callback: async (cache) => {
      for (const [sourceFile, attribution] of attributions) {
        const scopedFile = scopedFileForSourceFile(sourceFile, input.scope.sourceFiles)
        if (!scopedFile) {
          throw new Error('Codex scoped session attribution lost its source-file mapping')
        }
        const expectedFingerprint = input.scope.sourceFileFingerprints.get(sourceFile)
        if (!expectedFingerprint) {
          throw new Error('Codex scoped session attribution lost its source-file fingerprint')
        }
        if (input.scope.projectedSourceFiles.has(sourceFile)) {
          const currentSourceFingerprint = await fingerprintCodexSessionFile(sourceFile)
          if (!sameCodexContextPricingFingerprint(currentSourceFingerprint, expectedFingerprint)) {
            throw new Error('Codex session changed during scoped collection; retry the sync')
          }
        } else {
          const copiedFingerprint = await fingerprintCodexSessionFile(scopedFile)
          if (!sameFrozenScopeContent(copiedFingerprint, expectedFingerprint)) {
            throw new Error('Codex scoped session attribution changed unexpectedly')
          }
        }
        const stored = await cache.storeIfUnchanged({
          filePath: sourceFile,
          fingerprint: expectedFingerprint,
          attribution
        })
        if (!stored) {
          input.stderr?.('Skipping stale Codex canonical attribution cache write for a session that changed after copy')
        }
      }
    }
  })
}

function scopedFileForSourceFile(sourceFile: string, sourceFiles: ReadonlyMap<string, string>) {
  for (const [scopedFile, originalFile] of sourceFiles) {
    if (originalFile === sourceFile) return scopedFile
  }
  return null
}

function canonicalModelsByScopedFile(input: {
  scope: CodexSessionScope
  attributions: ReadonlyMap<string, CodexSessionAttribution>
}): CodexContextPricingFileModelHints {
  const models = new Map<string, string>()
  for (const [scopedFile, sourceFile] of input.scope.sourceFiles) {
    const attribution = input.attributions.get(sourceFile)
    if (attribution) models.set(scopedFile, attribution.model)
  }
  return models
}

function canonicalModelsByScopedFileFromSessionRows(input: {
  sessions: unknown
  scope: CodexSessionScope
  timezone: string
}): CodexContextPricingFileModelHints {
  const models = new Map<string, string>()
  for (const row of readSessionRows(input.sessions)) {
    const sourceFile = resolveScopedSessionSourceFile(row, input.scope)
    if (!sourceFile) continue
    const scopedFile = scopedFileForSourceFile(sourceFile, input.scope.sourceFiles)
    const attribution = readCcusageSessionAttribution(row, input.timezone, 'codex')
    if (scopedFile && attribution) models.set(scopedFile, attribution.model)
  }
  return models
}

function canonicalModelsByInventoryFiles(input: {
  sessions: unknown
  codexHomes: readonly string[]
  inventory: CodexContextPricingFileInventory
  timezone: string
}): CodexContextPricingFileModelHints {
  const filesByIdentityPath = new Map<string, string>()
  for (const filePath of input.inventory.filePaths) {
    const identityPath = input.inventory.identityPaths.get(resolve(filePath))
    if (identityPath) filesByIdentityPath.set(resolve(identityPath), filePath)
  }

  const models = new Map<string, string>()
  for (const row of readSessionRows(input.sessions)) {
    const attribution = readCcusageSessionAttribution(row, input.timezone, 'codex')
    if (!attribution) continue
    const directory = typeof row.directory === 'string' ? row.directory : ''
    const sessionName =
      typeof row.sessionFile === 'string' ? row.sessionFile : typeof row.sessionId === 'string' ? row.sessionId : ''
    if (!sessionName) continue
    if (!isSafeSessionDirectory(directory)) continue
    const filename = sessionName.endsWith('.jsonl') ? sessionName : `${sessionName}.jsonl`
    const rowHomeIndex =
      typeof row[codexHomeIndexKey] === 'number' && Number.isSafeInteger(row[codexHomeIndexKey])
        ? (row[codexHomeIndexKey] as number)
        : undefined
    const homeIndexes = rowHomeIndex === undefined ? input.codexHomes.map((_codexHome, index) => index) : [rowHomeIndex]
    for (const homeIndex of homeIndexes) {
      const codexHome = input.codexHomes[homeIndex]
      if (!codexHome) continue
      for (const rootName of ['sessions', 'archived_sessions']) {
        const root = resolve(codexHome, rootName)
        const identityPath = resolve(root, directory, filename)
        if (!isPathInside(root, identityPath)) continue
        const filePath = filesByIdentityPath.get(identityPath)
        if (filePath) models.set(resolve(filePath), attribution.model)
      }
    }
  }
  return models
}

async function collectCanonicalSessionRowsByHome(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  codexHomes: readonly string[]
}) {
  const rows: Record<string, unknown>[] = []
  for (const [homeIndex, codexHome] of input.codexHomes.entries()) {
    const sessions = await collectSessionCounts({
      runner: input.runner,
      command: input.packageRunner.command,
      args: input.packageRunner.runPackageArgs(
        ccusagePackageSpecifier,
        'ccusage',
        codexCommandArgs({
          report: 'session',
          timezone: input.options.timezone
        })
      ),
      options: packageCommandOptions({
        env: { ...process.env, CODEX_HOME: codexHome },
        timeoutMs: readSessionTimeoutMs(),
        stderr: input.options.stderr
      }),
      stderr: input.options.stderr,
      required: true
    })
    for (const row of readSessionRows(sessions)) {
      rows.push({ ...row, [codexHomeIndexKey]: homeIndex })
    }
  }
  return { sessions: rows }
}

function hasDuplicateCodexInventoryPaths(input: {
  codexHomes: readonly string[]
  inventory: CodexContextPricingFileInventory
}) {
  const homeByRelativePath = new Map<string, number>()
  for (const filePath of input.inventory.filePaths) {
    const identityPath = input.inventory.identityPaths.get(resolve(filePath))
    if (!identityPath) continue
    const location = codexInventoryPathLocation(identityPath, input.codexHomes)
    if (!location) continue
    const previousHomeIndex = homeByRelativePath.get(location.relativePath)
    if (previousHomeIndex !== undefined && previousHomeIndex !== location.homeIndex) return true
    homeByRelativePath.set(location.relativePath, location.homeIndex)
  }
  return false
}

function codexInventoryPathLocation(identityPath: string, codexHomes: readonly string[]) {
  const resolvedIdentityPath = resolve(identityPath)
  for (const [homeIndex, codexHome] of codexHomes.entries()) {
    for (const rootName of ['sessions', 'archived_sessions']) {
      const root = resolve(codexHome, rootName)
      if (!isPathInside(root, resolvedIdentityPath)) continue
      return {
        homeIndex,
        relativePath: relative(root, resolvedIdentityPath)
      }
    }
  }
  return null
}

function sameFrozenScopeContent(
  fingerprint: Awaited<ReturnType<typeof fingerprintCodexSessionFile>>,
  expected: Awaited<ReturnType<typeof fingerprintCodexSessionFile>>
) {
  return fingerprint.size === expected.size && fingerprint.tailSha256 === expected.tailSha256
}

async function assertCodexScopeSourcesUnchanged(scope: CodexSessionScope) {
  // Ordinary frozen copies intentionally retain the historical stale-copy
  // semantics: the live source may advance while ccusage parses the frozen
  // bytes, and the cache layer reports that race independently.  A projected
  // file, however, is read directly from the live source and must be checked
  // before its result is committed.
  for (const sourceFile of scope.projectedSourceFiles) {
    const expected = scope.sourceFileFingerprints.get(sourceFile)
    if (!expected) {
      throw new Error('Codex projected session scope lost its source-file fingerprint')
    }
    const current = await fingerprintCodexSessionFile(sourceFile)
    if (!sameCodexContextPricingFingerprint(expected, current)) {
      throw new Error('Codex session changed during scoped collection; retry the sync')
    }
  }
}

function cacheFilesForScope(scope: CodexSessionScope) {
  const cacheFiles = new Map<string, CodexSubagentUsageCacheFile>()
  for (const [scopedFile, sourceFile] of scope.sourceFiles) {
    if (scope.projectedSourceFiles.has(sourceFile)) continue
    const sourceFingerprint = scope.sourceFileFingerprints.get(sourceFile)
    if (!sourceFingerprint) {
      throw new Error('Codex frozen session scope lost its source-file fingerprint')
    }
    cacheFiles.set(scopedFile, { sourceFile, sourceFingerprint })
  }
  return cacheFiles
}

async function collectSessionCounts({
  runner,
  command,
  args,
  options,
  stderr = console.error,
  required = false
}: {
  runner: CommandRunner
  command: string
  args: string[]
  options: Parameters<CommandRunner>[2]
  stderr?: (line: string) => void
  required?: boolean
}) {
  try {
    return await runner(command, args, options)
  } catch (error) {
    if (required) throw error
    stderr(
      `Codex daily tokens collected, but session counts are unavailable; continuing with sessionCount=0: ${errorMessage(error)}`
    )
    return { data: [] }
  }
}

function buildRangeArgs(options: { since?: string; until?: string }) {
  const range = assertValidDateFilterRange({
    ...options,
    sinceField: 'Codex since date',
    untilField: 'Codex until date'
  })
  const args: string[] = []
  if (range.since) args.push('--since', range.since)
  if (range.until) args.push('--until', range.until)
  return args
}

function hookDateBounds(dates: string[]) {
  const first = dates[0]
  const last = dates.at(-1)
  if (!first || !last) {
    throw new Error('Codex hook reconciliation is missing changed usage dates')
  }
  return {
    since: first.replaceAll('-', ''),
    until: last.replaceAll('-', '')
  }
}

function readSince() {
  const since = process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || ''
  return since || ''
}

function resolveCodexHomesFromOptions(options: CollectCodexUsageOptions) {
  const hasExplicitOptions = options.codexHomes !== undefined || options.codexHome !== undefined
  return resolveConfiguredCodexHomes({
    explicitHomes: options.codexHomes,
    legacyValue: options.codexHome ?? (options.codexHomes === undefined ? process.env.CODEX_HOME : undefined),
    jsonValue: hasExplicitOptions ? undefined : process.env.TOKENBOARD_CODEX_HOMES_JSON
  })
}

function resolveCodexSymlinkRootsFromOptions(options: CollectCodexUsageOptions) {
  if (options.codexSymlinkRoots !== undefined) return normalizeCodexSymlinkRoots(options.codexSymlinkRoots)
  const configured = process.env.TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON
  return configured === undefined ? undefined : normalizeCodexSymlinkRoots(configured)
}

function readBatchSize() {
  const value = Number(process.env.TOKENBOARD_CODEX_BATCH_SIZE || DEFAULT_CODEX_BATCH_SIZE)
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_CODEX_BATCH_SIZE
  }
  return Math.min(Math.floor(value), MAX_CODEX_BATCH_SIZE)
}
