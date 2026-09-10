import { basename, dirname, join, resolve, sep } from 'node:path'
import { assertValidDateFilter, isAllDateFilter } from '../iso-calendar-date'
import { normalizeCodexTotalTokens } from '../codex-token-usage'
import { resolveSessionJsonlFiles } from './session-file-walk'
import { codexChildSessionReadLimits } from './codex-subagent-usage-child'
import { fingerprintCodexSessionFile, type CodexSessionFileFingerprint } from './codex-session-attribution-cache'
import { readJsonlRecords, readRecord, readString, type UnknownRecord } from './codex-subagent-usage-json'

const defaultLongContextThreshold = 200_000
export const maxCodexContextPricingFiles = 100_000

const usageDateFormatters = new Map<string, Intl.DateTimeFormat>()

// ccusage maps the synthetic auto-review model to the latest model released
// on the token event date before aggregating Codex usage.
const codexAutoReviewFallbackModels = [
  { releasedOn: '2026-04-23', model: 'gpt-5.5' },
  { releasedOn: '2026-03-05', model: 'gpt-5.4' },
  { releasedOn: '2026-02-05', model: 'gpt-5.3-codex' },
  { releasedOn: '2025-12-11', model: 'gpt-5.2-codex' },
  { releasedOn: '2025-11-13', model: 'gpt-5.1-codex' },
  { releasedOn: '2025-09-15', model: 'gpt-5-codex' },
  { releasedOn: '2025-08-07', model: 'gpt-5' }
] as const

type PricingRates = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export type CodexContextPricingRule = {
  modelIds: readonly string[]
  threshold: number
  standard: PricingRates
  longContext: PricingRates
  fastMultiplier?: number
}

export type CodexContextPricingCost = {
  usageDate: string
  model: string
  costUsd: number
}

export type CodexContextPricingUsage = {
  usageDate: string
  model: string
  /** Canonical non-context model used by ccusage for a mixed-model file. */
  attributedModel?: string
  inputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens?: number
  serviceTier: CodexServiceTier
  contextTier: 'standard' | 'long'
}

export type CodexContextPricingModelHints = ReadonlyMap<string, ReadonlySet<string>>
export type CodexContextPricingFileModelHints = ReadonlyMap<string, string>

export type CodexContextPricingFileInventory = {
  filePaths: string[]
  identityPaths: Map<string, string>
  fingerprints: Map<string, CodexSessionFileFingerprint>
  overflow: boolean
}

export type CodexServiceTier = 'standard' | 'fast' | 'priority' | null

// These are the provider-published per-token rates represented in the server
// catalogue. The threshold is a request-level switch, not the model context
// window and not a marginal above-threshold bucket.
export const codexContextPricingRules: readonly CodexContextPricingRule[] = [
  {
    modelIds: ['gpt-5.6-sol', 'gpt-5.6'],
    threshold: 272_000,
    standard: {
      input: 5 / 1_000_000,
      output: 30 / 1_000_000,
      cacheRead: 0.5 / 1_000_000,
      cacheCreation: 6.25 / 1_000_000
    },
    longContext: {
      input: 10 / 1_000_000,
      output: 45 / 1_000_000,
      cacheRead: 1 / 1_000_000,
      cacheCreation: 12.5 / 1_000_000
    },
    fastMultiplier: 2
  },
  {
    modelIds: ['gpt-5.6-terra'],
    threshold: 272_000,
    standard: {
      input: 2 / 1_000_000,
      output: 12 / 1_000_000,
      cacheRead: 0.2 / 1_000_000,
      cacheCreation: 2.5 / 1_000_000
    },
    longContext: {
      input: 4 / 1_000_000,
      output: 18 / 1_000_000,
      cacheRead: 0.4 / 1_000_000,
      cacheCreation: 5 / 1_000_000
    },
    fastMultiplier: 2
  },
  {
    modelIds: ['gpt-5.6-luna'],
    threshold: 272_000,
    standard: {
      input: 0.2 / 1_000_000,
      output: 1.2 / 1_000_000,
      cacheRead: 0.02 / 1_000_000,
      cacheCreation: 0.25 / 1_000_000
    },
    longContext: {
      input: 0.4 / 1_000_000,
      output: 1.8 / 1_000_000,
      cacheRead: 0.04 / 1_000_000,
      cacheCreation: 0.5 / 1_000_000
    },
    fastMultiplier: 2
  },
  {
    modelIds: ['gpt-5.5'],
    threshold: 272_000,
    standard: {
      input: 5 / 1_000_000,
      output: 30 / 1_000_000,
      cacheRead: 0.5 / 1_000_000,
      cacheCreation: 0
    },
    longContext: {
      input: 10 / 1_000_000,
      output: 45 / 1_000_000,
      cacheRead: 1 / 1_000_000,
      cacheCreation: 0
    },
    fastMultiplier: 2.5
  },
  {
    modelIds: ['gpt-5.5-pro'],
    threshold: 272_000,
    standard: {
      input: 30 / 1_000_000,
      output: 180 / 1_000_000,
      cacheRead: 0,
      cacheCreation: 0
    },
    longContext: {
      input: 60 / 1_000_000,
      output: 270 / 1_000_000,
      cacheRead: 0,
      cacheCreation: 0
    }
  },
  {
    modelIds: ['gpt-5.4'],
    threshold: 272_000,
    standard: {
      input: 2.5 / 1_000_000,
      output: 15 / 1_000_000,
      cacheRead: 0.25 / 1_000_000,
      cacheCreation: 0
    },
    longContext: {
      input: 5 / 1_000_000,
      output: 22.5 / 1_000_000,
      cacheRead: 0.5 / 1_000_000,
      cacheCreation: 0
    },
    fastMultiplier: 2
  },
  {
    modelIds: ['gpt-5.4-pro'],
    threshold: 272_000,
    standard: {
      input: 30 / 1_000_000,
      output: 180 / 1_000_000,
      cacheRead: 0,
      cacheCreation: 0
    },
    longContext: {
      input: 60 / 1_000_000,
      output: 270 / 1_000_000,
      cacheRead: 0,
      cacheCreation: 0
    }
  },
  {
    modelIds: ['grok-4.5'],
    threshold: defaultLongContextThreshold,
    standard: {
      input: 2 / 1_000_000,
      output: 6 / 1_000_000,
      cacheRead: 0.3 / 1_000_000,
      cacheCreation: 0
    },
    longContext: {
      input: 4 / 1_000_000,
      output: 12 / 1_000_000,
      cacheRead: 0.6 / 1_000_000,
      cacheCreation: 0
    }
  }
]

const knownContextPricingModelBases = new Set(
  codexContextPricingRules.flatMap((rule) => rule.modelIds.map((model) => model.trim().toLowerCase()))
)
const ruleByModel: Map<string, CodexContextPricingRule> = new Map(
  codexContextPricingRules.flatMap((rule) => rule.modelIds.map((model) => [normalizeModelId(model), rule] as const))
)
const canonicalModelByAlias = new Map(
  codexContextPricingRules.flatMap((rule) => {
    const canonical = normalizeModelId(rule.modelIds[0] ?? '')
    return rule.modelIds.map((model) => [normalizeModelId(model), canonical] as const)
  })
)

export function isCodexContextPricingModel(model: string) {
  return ruleByModel.has(normalizeModelId(model))
}

export function isCodexContextPricingCostGuaranteedZero(model: string) {
  const rule = ruleByModel.get(normalizeModelId(model))
  if (!rule) return false
  return (
    Object.values(rule.standard).every((rate) => rate === 0) &&
    Object.values(rule.longContext).every((rate) => rate === 0)
  )
}

export function isUnresolvedCodexContextPricingSnapshot(snapshot: {
  source: string
  model: string
  totalTokens: number
  costUsd: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}) {
  if (snapshot.source !== 'codex' || snapshot.totalTokens <= 0 || !isCodexContextPricingModel(snapshot.model)) {
    return false
  }
  if (!hasBillableCodexTokens(snapshot)) return false
  if (isCodexContextPricingCostGuaranteedZero(snapshot.model)) return snapshot.costUsd !== 0
  return true
}

export async function collectCodexContextPricingCostsFromFiles(input: {
  filePaths: readonly string[]
  identityPaths?: ReadonlyMap<string, string>
  canonicalModelsByDate?: CodexContextPricingModelHints
  canonicalModelsByFile?: CodexContextPricingFileModelHints
  timezone: string
  since?: string
  until?: string
  stderr?: (line: string) => void
}): Promise<CodexContextPricingCost[]> {
  const usages = await collectCodexContextPricingUsagesFromFiles(input)
  return priceCodexContextPricingUsages(applyCodexContextPricingUsageModelHints(usages, input.canonicalModelsByDate))
}

export async function collectCodexContextPricingUsagesFromFiles(input: {
  filePaths: readonly string[]
  identityPaths?: ReadonlyMap<string, string>
  canonicalModelsByDate?: CodexContextPricingModelHints
  canonicalModelsByFile?: CodexContextPricingFileModelHints
  timezone: string
  since?: string
  until?: string
  stderr?: (line: string) => void
}): Promise<CodexContextPricingUsage[]> {
  const since = normalizeDateFilter(input.since, 'Codex context pricing since date')
  const until = normalizeDateFilter(input.until, 'Codex context pricing until date')
  assertDateRange(since, until)
  if (input.filePaths.length > maxCodexContextPricingFiles) {
    throw new Error(`Codex context pricing scan exceeds ${maxCodexContextPricingFiles} session files`)
  }

  const totals = new Map<string, CodexContextPricingUsage>()
  const seen = new Set<string>()
  const sessionIdentitiesByAlias = new Map<string, string>()
  for (const filePath of input.filePaths) {
    const diagnostics: string[] = []
    const absolutePath = resolve(filePath)
    const identityPath = identityPathFor(absolutePath, input.identityPaths)
    const canonicalModel = input.canonicalModelsByFile?.get(absolutePath) ?? null
    const allowMixedModelPricing =
      canonicalModel && !isCodexContextPricingModel(canonicalModel)
        ? await hasMixedCodexContextPricingModels({
            filePath,
            timezone: input.timezone,
            canonicalModel
          })
        : false
    // ccusage has already attributed this file to a non-context-priced model.
    // Most such files have no context-priced event and can be skipped after a
    // bounded model scan. A session can switch models within one JSONL file,
    // so retain files that contain both model classes for event-level parsing.
    if (canonicalModel && !isCodexContextPricingModel(canonicalModel) && !allowMixedModelPricing) continue
    const relevant = await scanFile({
      ...input,
      filePath,
      since,
      until,
      stderr: (line) => diagnostics.push(line),
      totals,
      seen,
      identityPath,
      sessionIdentitiesByAlias,
      canonicalModel,
      allowMixedModelPricing,
      canonicalModelsByDate: allowMixedModelPricing ? undefined : input.canonicalModelsByDate
    })
    if (relevant) {
      for (const line of diagnostics) input.stderr?.(line)
    }
  }
  return [...totals.values()]
}

export async function collectCodexContextPricingCostsFromHomes(input: {
  codexHomes: readonly string[]
  canonicalModelsByDate?: CodexContextPricingModelHints
  canonicalModelsByFile?: CodexContextPricingFileModelHints
  timezone: string
  since?: string
  until?: string
  stderr?: (line: string) => void
  codexSymlinkRoots?: readonly string[]
}): Promise<CodexContextPricingCost[]> {
  const usages = await collectCodexContextPricingUsagesFromHomes(input)
  return priceCodexContextPricingUsages(applyCodexContextPricingUsageModelHints(usages, input.canonicalModelsByDate))
}

export async function collectCodexContextPricingUsagesFromHomes(input: {
  codexHomes: readonly string[]
  canonicalModelsByDate?: CodexContextPricingModelHints
  canonicalModelsByFile?: CodexContextPricingFileModelHints
  timezone: string
  since?: string
  until?: string
  stderr?: (line: string) => void
  codexSymlinkRoots?: readonly string[]
}): Promise<CodexContextPricingUsage[]> {
  const inventory = await discoverCodexContextPricingFiles(input)
  return collectCodexContextPricingUsagesFromFiles({
    ...input,
    filePaths: inventory.filePaths,
    identityPaths: inventory.identityPaths
  })
}

export async function discoverCodexContextPricingFiles(input: {
  codexHomes: readonly string[]
  codexSymlinkRoots?: readonly string[]
  captureFingerprints?: boolean
  allowFileOverflow?: boolean
}): Promise<CodexContextPricingFileInventory> {
  const fileCandidates = new Map<
    string,
    {
      filePath: string
      identityPath: string
      rootPriority: number
    }
  >()
  const identityPaths = new Map<string, string>()
  let discoveredFiles = 0
  let overflow = false
  for (const [homeIndex, codexHome] of input.codexHomes.entries()) {
    for (const [rootPriority, rootName] of ['sessions', 'archived_sessions'].entries()) {
      const rootPath = join(codexHome, rootName)
      const root = await resolveSessionJsonlFiles(rootPath, {
        rejectRootSymlink: true,
        rootBoundary: codexHome,
        allowedRootSymlinks: input.codexSymlinkRoots
      })
      if (!root) continue
      for await (const relativePath of root.files) {
        const physicalPath = join(root.rootDir, relativePath)
        const identityPath = resolve(rootPath, relativePath)
        const logicalPath = `${homeIndex}\u0000${archiveSessionAlias(identityPath) ?? identityPath}`
        const existing = fileCandidates.get(logicalPath)
        if (existing && existing.rootPriority <= rootPriority) continue
        if (!existing) {
          discoveredFiles += 1
          if (discoveredFiles > maxCodexContextPricingFiles) {
            if (input.allowFileOverflow) {
              overflow = true
              break
            }
            throw new Error(`Codex context pricing scan exceeds ${maxCodexContextPricingFiles} session files`)
          }
        }
        fileCandidates.set(logicalPath, { filePath: physicalPath, identityPath, rootPriority })
      }
      if (overflow) break
    }
    if (overflow) break
  }
  const filePaths = [...fileCandidates.values()].map((candidate) => candidate.filePath)
  const fingerprints = new Map<string, CodexSessionFileFingerprint>()
  if (input.captureFingerprints && !overflow) {
    for (const filePath of filePaths) {
      fingerprints.set(resolve(filePath), await fingerprintCodexSessionFile(filePath))
    }
  }
  for (const candidate of fileCandidates.values()) {
    identityPaths.set(resolve(candidate.filePath), candidate.identityPath)
  }
  return { filePaths, identityPaths, fingerprints, overflow }
}

function normalizeDateFilter(value: string | undefined, field: string) {
  if (!value || isAllDateFilter(value)) return undefined
  return assertValidDateFilter(value, field).replaceAll('-', '')
}

function assertDateRange(since: string | undefined, until: string | undefined) {
  if (since && until && since > until) {
    throw new Error(`Codex context pricing date range is reversed: ${since} > ${until}`)
  }
}

export function applyCodexContextPricingCosts<
  T extends {
    usageDate: string
    model: string
    costUsd: number
    totalTokens?: number
  }
>(snapshots: T[], costs: readonly CodexContextPricingCost[], stderr?: (line: string) => void) {
  const costsByKey = new Map<string, number>()
  for (const cost of costs) {
    const key = contextPricingKey(cost.usageDate, cost.model)
    costsByKey.set(key, (costsByKey.get(key) ?? 0) + cost.costUsd)
  }

  const matches = new Map<number, number>()
  const unmatchedCostKeys = new Set(costsByKey.keys())
  const unmatchedSnapshotsByFamily = new Map<string, number[]>()
  const requiredSnapshotIndexesByKey = new Map<string, number[]>()
  for (const [index, snapshot] of snapshots.entries()) {
    if (!requiresContextPricingCost(snapshot)) continue
    const key = contextPricingKey(snapshot.usageDate, snapshot.model)
    const requiredIndexes = requiredSnapshotIndexesByKey.get(key) ?? []
    requiredIndexes.push(index)
    requiredSnapshotIndexesByKey.set(key, requiredIndexes)
    const exactCost = costsByKey.get(key)
    if (exactCost !== undefined) {
      matches.set(index, exactCost)
      unmatchedCostKeys.delete(key)
      continue
    }
    const familyKey = contextPricingFamilyKey(snapshot.usageDate, snapshot.model)
    const entries = unmatchedSnapshotsByFamily.get(familyKey) ?? []
    entries.push(index)
    unmatchedSnapshotsByFamily.set(familyKey, entries)
  }

  for (const [key, snapshotIndexes] of requiredSnapshotIndexesByKey) {
    if (snapshotIndexes.length < 2 || !costsByKey.has(key)) continue
    const [usageDate, model] = splitContextPricingKey(key)
    stderr?.(`Codex context pricing found duplicate daily snapshots for ${usageDate}/${model}`)
    throw new Error(`Codex context pricing cannot match duplicate daily snapshots for ${usageDate}/${model}`)
  }

  const unresolvedSnapshots: number[] = []
  for (const [familyKey, snapshotIndexes] of unmatchedSnapshotsByFamily) {
    const compatibleCostKeys = [...unmatchedCostKeys].filter((key) => {
      const [usageDate, model] = splitContextPricingKey(key)
      return contextPricingFamilyKey(usageDate, model) === familyKey
    })
    if (snapshotIndexes.length === 1 && compatibleCostKeys.length === 1) {
      const [snapshotIndex] = snapshotIndexes
      const [costKey] = compatibleCostKeys
      if (snapshotIndex === undefined || costKey === undefined) {
        throw new Error('Codex context pricing matching reached an invalid state')
      }
      const cost = costsByKey.get(costKey)
      if (cost === undefined) throw new Error('Codex context pricing matching lost a raw cost')
      matches.set(snapshotIndex, cost)
      unmatchedCostKeys.delete(costKey)
      continue
    }
    unresolvedSnapshots.push(...snapshotIndexes)
  }

  for (const key of unmatchedCostKeys) {
    const cost = costsByKey.get(key)
    if (cost === undefined) throw new Error('Codex context pricing matching lost a raw cost')
    const [usageDate, model] = splitContextPricingKey(key)
    stderr?.(`Codex context pricing found ${model} usage without a matching daily snapshot for ${usageDate}`)
    throw new Error(`Codex context pricing cannot match daily snapshot for ${usageDate}/${model}`)
  }

  const snapshotIndex = unresolvedSnapshots[0]
  if (snapshotIndex !== undefined) {
    const snapshot = snapshots[snapshotIndex]
    if (!snapshot) throw new Error('Codex context pricing matching lost a daily snapshot')
    stderr?.(
      `Codex context pricing found ${snapshot.model} daily usage without an unambiguous raw cost for ${snapshot.usageDate}`
    )
    throw new Error(`Codex context pricing cannot match raw cost for ${snapshot.usageDate}/${snapshot.model}`)
  }

  return snapshots.map((snapshot, index) => {
    const cost = matches.get(index)
    return cost === undefined ? snapshot : { ...snapshot, costUsd: cost }
  })
}

export function priceCodexRequest(input: {
  model: string
  inputTokens: number
  uncachedInputTokens?: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  serviceTier?: CodexServiceTier
}) {
  const rule = ruleByModel.get(normalizeModelId(input.model))
  if (!rule) return null
  const requestContextTokens = input.inputTokens + input.cacheCreationTokens
  const rates = requestContextTokens > rule.threshold ? rule.longContext : rule.standard
  const multiplier = input.serviceTier === 'fast' || input.serviceTier === 'priority' ? (rule.fastMultiplier ?? 1) : 1
  const uncachedInputTokens = input.uncachedInputTokens ?? Math.max(0, input.inputTokens - input.cacheReadTokens)
  return (
    multiplier *
    (uncachedInputTokens * rates.input +
      input.outputTokens * rates.output +
      input.cacheReadTokens * rates.cacheRead +
      input.cacheCreationTokens * rates.cacheCreation)
  )
}

export function applyCodexContextPricingModelHints(
  costs: readonly CodexContextPricingCost[],
  canonicalModelsByDate?: CodexContextPricingModelHints
) {
  if (!canonicalModelsByDate) return [...costs]
  const totals = new Map<string, CodexContextPricingCost>()
  for (const cost of costs) {
    const model = resolveCanonicalContextPricingModel(
      normalizeModelId(cost.model),
      cost.usageDate,
      canonicalModelsByDate
    )
    const key = contextPricingKey(cost.usageDate, model)
    const current = totals.get(key)
    if (current) {
      current.costUsd += cost.costUsd
    } else {
      totals.set(key, { ...cost, model })
    }
  }
  return [...totals.values()]
}

export function priceCodexContextPricingUsages(usages: readonly CodexContextPricingUsage[]) {
  const totals = new Map<string, CodexContextPricingCost>()
  for (const usage of usages) {
    const model = normalizeModelId(usage.model)
    const cost = priceCodexUsageAtTier({ ...usage, model })
    if (cost === null) continue
    const key = contextPricingKey(usage.usageDate, model)
    const current = totals.get(key)
    if (current) current.costUsd += cost
    else totals.set(key, { usageDate: usage.usageDate, model, costUsd: cost })
  }
  return [...totals.values()]
}

export function applyCodexContextPricingUsageModelHints(
  usages: readonly CodexContextPricingUsage[],
  canonicalModelsByDate?: CodexContextPricingModelHints
) {
  const totals = new Map<string, CodexContextPricingUsage>()
  for (const usage of usages) {
    const model = resolveCanonicalContextPricingModel(
      normalizeModelId(usage.model),
      usage.usageDate,
      canonicalModelsByDate
    )
    if (!ruleByModel.has(normalizeModelId(model))) continue
    // Keep the request-level context tier observed while scanning. Do not
    // recompute it from a date/model aggregate, because that would reprice
    // every standard request as long-context once the daily total crosses the
    // threshold.
    const key = `${contextUsageKey(usage.usageDate, model, usage.serviceTier, usage.contextTier)}\u0000${
      usage.attributedModel ? normalizeModelId(usage.attributedModel) : ''
    }`
    const current = totals.get(key)
    if (current) {
      const currentTotal = codexContextUsageTotal(current)
      const usageTotal = codexContextUsageTotal(usage)
      current.inputTokens += usage.inputTokens
      current.uncachedInputTokens += usage.uncachedInputTokens
      current.outputTokens += usage.outputTokens
      current.cacheReadTokens += usage.cacheReadTokens
      current.cacheCreationTokens += usage.cacheCreationTokens
      current.totalTokens = currentTotal + usageTotal
      if (current.attributedModel !== usage.attributedModel) current.attributedModel = undefined
    } else {
      totals.set(key, { ...usage, model })
    }
  }
  return [...totals.values()]
}

function priceCodexUsageAtTier(input: CodexContextPricingUsage) {
  const rule = ruleByModel.get(normalizeModelId(input.model))
  if (!rule) return null
  const rates = input.contextTier === 'long' ? rule.longContext : rule.standard
  const multiplier = input.serviceTier === 'fast' || input.serviceTier === 'priority' ? (rule.fastMultiplier ?? 1) : 1
  return (
    multiplier *
    (input.uncachedInputTokens * rates.input +
      input.outputTokens * rates.output +
      input.cacheReadTokens * rates.cacheRead +
      input.cacheCreationTokens * rates.cacheCreation)
  )
}

export function normalizeModelId(value: string): string {
  const normalized = value.trim().toLowerCase()
  const datedModel = /^(.+)-(\d{4})(\d{2})(\d{2})$/.exec(normalized)
  if (!datedModel) return normalized

  const year = Number(datedModel[2])
  const month = Number(datedModel[3])
  const day = Number(datedModel[4])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return normalized
  }
  const base = datedModel[1] ?? normalized
  // Only collapse a dated alias when its base is a known priced model. This
  // prevents a future model such as gpt-5-20241201 from being misread as gpt-5.
  return knownContextPricingModelBases.has(base) ? base : normalized
}

function contextPricingKey(usageDate: string, model: string) {
  return `${usageDate}\u0000${normalizeModelId(model)}`
}

function contextPricingFamilyKey(usageDate: string, model: string) {
  return `${usageDate}\u0000${canonicalModelId(model)}`
}

function splitContextPricingKey(key: string) {
  const separator = key.indexOf('\u0000')
  if (separator === -1) throw new Error('Codex context pricing key is malformed')
  return [key.slice(0, separator), key.slice(separator + 1)] as const
}

function requiresContextPricingCost(snapshot: {
  model: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  totalTokens?: number
}) {
  return isCodexContextPricingModel(snapshot.model) && snapshot.totalTokens !== 0 && hasBillableCodexTokens(snapshot)
}

function hasBillableCodexTokens(snapshot: {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}) {
  const components = [
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.cacheReadTokens,
    snapshot.cacheCreationTokens
  ]
  if (components.every((value) => value === undefined)) return true
  return (
    (snapshot.inputTokens ?? 0) > 0 ||
    (snapshot.outputTokens ?? 0) > 0 ||
    (snapshot.cacheReadTokens ?? 0) > 0 ||
    (snapshot.cacheCreationTokens ?? 0) > 0
  )
}

function canonicalModelId(value: string) {
  const normalized = normalizeModelId(value)
  return canonicalModelByAlias.get(normalized) ?? normalized
}

async function scanFile(input: {
  filePath: string
  identityPath: string
  timezone: string
  since?: string
  until?: string
  stderr?: (line: string) => void
  totals: Map<string, CodexContextPricingUsage>
  seen: Set<string>
  sessionIdentitiesByAlias: Map<string, string>
  canonicalModel: string | null
  allowMixedModelPricing: boolean
  canonicalModelsByDate?: CodexContextPricingModelHints
}): Promise<boolean> {
  let currentModel: string | null = null
  let serviceTier: CodexServiceTier = null
  const archiveAlias = archiveSessionAlias(input.identityPath)
  const fallbackIdentity = archiveAlias ? `path:${archiveAlias}` : anonymousSessionIdentity(input.identityPath)
  let sessionIdentity = archiveAlias ? (input.sessionIdentitiesByAlias.get(archiveAlias) ?? null) : null
  let isSubagentSession = false
  const previousTotals = new Map<string, UsageValues>()
  const occurrences = new Map<string, number>()
  let hasRelevantModel = false
  const reportedScopeModelMismatches = new Set<string>()
  for await (const record of readJsonlRecords(input.filePath, input.stderr, {
    ...codexChildSessionReadLimits,
    label: 'Codex context pricing'
  })) {
    if (record.type === 'session_meta') {
      const identity = readSessionIdentity(record)
      if (identity && !sessionIdentity) {
        sessionIdentity = scopedSessionIdentity(identity, input.identityPath)
        if (archiveAlias) {
          const previous = input.sessionIdentitiesByAlias.get(archiveAlias)
          if (previous && previous !== sessionIdentity) {
            throw new Error(`Codex context pricing found conflicting session identities for ${archiveAlias}`)
          }
          input.sessionIdentitiesByAlias.set(archiveAlias, sessionIdentity)
        }
      } else if (identity && sessionIdentity && archiveAlias) {
        const observedIdentity = scopedSessionIdentity(identity, input.identityPath)
        if (observedIdentity !== sessionIdentity) {
          throw new Error(`Codex context pricing found conflicting session identities for ${archiveAlias}`)
        }
      }
      const payload = readRecord(record.payload)
      const source = readRecord(payload?.source)
      const subagent = readRecord(source?.subagent)
      // The parent thread id is optional in newer child-session metadata. The
      // presence of the subagent envelope is the stable child-session signal.
      isSubagentSession = subagent !== null
      continue
    }
    if (record.type === 'turn_context') {
      const payload = readRecord(record.payload)
      const model = readString(payload, ['model'])
      if (model) currentModel = model
      continue
    }
    if (record.type !== 'event_msg') continue
    const payload = readRecord(record.payload)
    if (payload?.type === 'thread_settings_applied') {
      const settings = readRecord(payload.thread_settings)
      if (settings && Object.prototype.hasOwnProperty.call(settings, 'service_tier')) {
        serviceTier = readServiceTier(readString(settings, ['service_tier']))
      }
      continue
    }
    if (payload?.type !== 'token_count') continue
    const timestamp = readString(record, ['timestamp'])
    if (!timestamp) continue
    const { info, rawModel } = readTokenCountModel(payload, currentModel)
    const modelKey = rawModel && normalizeModelId(rawModel)
    const rawPricingModel = rawModel && resolveCodexContextPricingModel(rawModel, timestamp, input.timezone)
    const date = formatUsageDate(timestamp, input.timezone)
    if (rawPricingModel && isCodexContextPricingModel(rawPricingModel)) hasRelevantModel = true
    const model =
      rawPricingModel &&
      resolveFileCanonicalContextPricingModel(
        rawPricingModel,
        input.allowMixedModelPricing ? null : input.canonicalModel,
        date,
        input.canonicalModelsByDate
      )
    const normalizedModel = model ? normalizeModelId(model) : null
    const total = readUsage(info?.total_token_usage ?? payload.total_token_usage, input.filePath)
    const last = readUsage(info?.last_token_usage ?? payload.usage, input.filePath)
    if (!total && !last) continue

    // A file attributed by ccusage to a non-context model can still contain a
    // context-priced turn. In that mixed case total_token_usage remains a
    // session-wide cumulative counter across model switches, so every model
    // in the file must share one baseline stream.
    const usageStreamModel = input.allowMixedModelPricing
      ? '__mixed-codex-session__'
      : modelKey === 'codex-auto-review'
        ? modelKey
        : input.canonicalModel
          ? (normalizedModel ?? normalizeModelId(rawPricingModel ?? modelKey ?? ''))
          : modelKey
    if (!usageStreamModel) continue
    const usageStreamKey = `${fallbackIdentity}\u0000${canonicalModelId(usageStreamModel)}`
    const previousTotal = previousTotals.get(usageStreamKey) ?? null
    if (total && previousTotal && usageEquals(total, previousTotal)) continue
    // A cumulative-only first row is a baseline. Codex child sessions can
    // start with inherited parent context in total_token_usage; charging that
    // first cumulative value would bill the parent context a second time.
    if (isSubagentSession && total && !last && !previousTotal) {
      previousTotals.set(usageStreamKey, total)
      continue
    }
    const usage = last ?? (total ? subtractUsage(total, previousTotal) : null)
    if (total) previousTotals.set(usageStreamKey, total)
    if (!usage || isEmptyUsage(usage)) continue

    if (!normalizedModel || !modelKey || !ruleByModel.has(normalizedModel)) {
      if (rawPricingModel && isCodexContextPricingModel(rawPricingModel) && !input.canonicalModel) {
        const candidates = input.canonicalModelsByDate?.get(date)
        const normalizedRawModel = normalizeModelId(rawPricingModel)
        const mismatchKey = `${date}\u0000${normalizedRawModel}`
        if (candidates?.size && !candidates.has(normalizedRawModel) && !reportedScopeModelMismatches.has(mismatchKey)) {
          reportedScopeModelMismatches.add(mismatchKey)
          input.stderr?.(
            `Codex context pricing skipped ${normalizedRawModel} usage outside the ccusage daily model scope for ${date}`
          )
        }
      }
      continue
    }
    if (!isDateInBounds(date, input.since, input.until)) continue
    const rule = ruleByModel.get(normalizedModel)
    if (!rule) continue
    const eventContentKey = [
      timestamp,
      canonicalModelId(normalizedModel),
      serviceTier ?? 'standard',
      usage.inputTokens,
      usage.uncachedInputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
      usage.outputTokens,
      usage.totalTokens
    ].join('\u0000')
    const eventBaseKey = `${fallbackIdentity}\u0000${eventContentKey}`
    const occurrence = (occurrences.get(eventBaseKey) ?? 0) + 1
    occurrences.set(eventBaseKey, occurrence)
    const identityEventKeys = [
      `${eventBaseKey}\u0000${occurrence}`,
      ...(sessionIdentity && sessionIdentity !== fallbackIdentity
        ? [`${sessionIdentity}\u0000${eventContentKey}\u0000${occurrence}`]
        : [])
    ]
    if (identityEventKeys.some((key) => input.seen.has(key))) continue
    for (const key of identityEventKeys) input.seen.add(key)
    const requestContextTokens = usage.inputTokens + usage.cacheCreationTokens
    const contextTier = requestContextTokens > rule.threshold ? 'long' : 'standard'
    const key = `${contextUsageKey(date, normalizedModel, serviceTier, contextTier)}\u0000${
      input.allowMixedModelPricing ? normalizeModelId(input.canonicalModel ?? '') : ''
    }`
    const current = input.totals.get(key)
    if (current) {
      const currentTotal = codexContextUsageTotal(current)
      const usageTotal = codexContextUsageTotal(usage)
      current.inputTokens += usage.inputTokens
      current.uncachedInputTokens += usage.uncachedInputTokens
      current.outputTokens += usage.outputTokens
      current.cacheReadTokens += usage.cacheReadTokens
      current.cacheCreationTokens += usage.cacheCreationTokens
      current.totalTokens = currentTotal + usageTotal
    } else {
      input.totals.set(key, {
        usageDate: date,
        model: normalizedModel,
        attributedModel:
          input.canonicalModel && !isCodexContextPricingModel(input.canonicalModel)
            ? normalizeModelId(input.canonicalModel)
            : undefined,
        inputTokens: usage.inputTokens,
        uncachedInputTokens: usage.uncachedInputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        totalTokens: usage.totalTokens,
        serviceTier,
        contextTier
      })
    }
  }
  return hasRelevantModel
}

function codexContextUsageTotal(
  usage: Pick<CodexContextPricingUsage, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'totalTokens'>
) {
  return usage.totalTokens ?? usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens
}

async function hasMixedCodexContextPricingModels(input: {
  filePath: string
  timezone: string
  canonicalModel: string | null
}) {
  let currentModel: string | null = null
  let hasContextModel = false
  let hasOtherModel = false
  for await (const record of readJsonlRecords(input.filePath, undefined, {
    ...codexChildSessionReadLimits,
    label: 'Codex context pricing'
  })) {
    if (record.type === 'turn_context') {
      const payload = readRecord(record.payload)
      const model = readString(payload, ['model'])
      if (model) {
        currentModel = model
        if (normalizeModelId(model) === 'codex-auto-review') {
          // ccusage can attribute a file to a non-context model while the
          // synthetic auto-review stream resolves to a billable context model.
          // Keep the synthetic stream as a distinct model class so the file
          // is retained for event-level parsing below.
          hasOtherModel = true
        } else if (isCodexContextPricingModel(model)) hasContextModel = true
        else hasOtherModel = true
      }
    } else if (record.type === 'event_msg') {
      const payload = readRecord(record.payload)
      if (payload?.type !== 'token_count') continue
      const timestamp = readString(record, ['timestamp'])
      if (!timestamp) continue
      const { info, rawModel } = readTokenCountModel(payload, currentModel)
      if (!rawModel) continue
      const model = resolveCodexContextPricingModel(rawModel, timestamp, input.timezone)
      if (isCodexContextPricingModel(model)) hasContextModel = true
      else hasOtherModel = true
      // A file-level non-context attribution is useful evidence only when the
      // token row explicitly names a context model. A context model inherited
      // solely from an older turn_context row is historical metadata and must
      // remain bound to the canonical non-context attribution.
      const explicitModel =
        readString(info, ['model']) ||
        readString(readRecord(info?.total_token_usage ?? payload.total_token_usage), ['model']) ||
        readString(readRecord(info?.last_token_usage ?? payload.usage), ['model'])
      if (
        explicitModel &&
        input.canonicalModel &&
        !isCodexContextPricingModel(input.canonicalModel) &&
        isCodexContextPricingModel(model)
      ) {
        hasOtherModel = true
      }
      if (normalizeModelId(rawModel) === 'codex-auto-review') hasOtherModel = true
    }
    if (hasContextModel && hasOtherModel) return true
  }
  return false
}

function readTokenCountModel(payload: UnknownRecord, currentModel: string | null) {
  const info = readRecord(payload.info)
  const rawModel =
    readString(info, ['model']) ||
    readString(readRecord(info?.total_token_usage ?? payload.total_token_usage), ['model']) ||
    readString(readRecord(info?.last_token_usage ?? payload.usage), ['model']) ||
    currentModel
  return { info, rawModel }
}

function resolveFileCanonicalContextPricingModel(
  rawModel: string,
  canonicalModel: string | null,
  usageDate: string,
  canonicalModelsByDate?: CodexContextPricingModelHints
) {
  if (!canonicalModel) {
    const candidates = canonicalModelsByDate?.get(usageDate)
    if (candidates?.size) {
      const normalizedRawModel = normalizeModelId(rawModel)
      if (candidates.has(normalizedRawModel)) return rawModel
      const billableCandidates = [...candidates].filter(isCodexContextPricingModel)
      if (billableCandidates.length === 1) return billableCandidates[0] as string
      return null
    }
    return rawModel
  }
  const normalizedCanonicalModel = normalizeModelId(canonicalModel)
  if (!isCodexContextPricingModel(rawModel)) return rawModel
  if (!isCodexContextPricingModel(normalizedCanonicalModel)) return null
  if (!canonicalModelsByDate) return normalizedCanonicalModel
  const candidates = canonicalModelsByDate.get(usageDate)
  if (!candidates || candidates.size === 0 || candidates.has(normalizeModelId(rawModel))) {
    return rawModel
  }
  return candidates.has(normalizedCanonicalModel) ? normalizedCanonicalModel : rawModel
}

function contextUsageKey(
  usageDate: string,
  model: string,
  serviceTier: CodexServiceTier,
  contextTier: 'standard' | 'long'
) {
  return `${usageDate}\u0000${normalizeModelId(model)}\u0000${serviceTier ?? 'standard'}\u0000${contextTier}`
}

function resolveCodexContextPricingModel(model: string, timestamp: string, timezone: string) {
  const normalizedModel = normalizeModelId(model)
  if (normalizedModel !== 'codex-auto-review') return normalizedModel
  const eventDate = formatUsageDate(timestamp, timezone)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return 'gpt-5'
  return codexAutoReviewFallbackModels.find(({ releasedOn }) => eventDate >= releasedOn)?.model ?? 'gpt-5'
}

function resolveCanonicalContextPricingModel(
  rawModel: string,
  usageDate: string,
  canonicalModelsByDate?: CodexContextPricingModelHints
) {
  if (!canonicalModelsByDate) return rawModel
  const candidates = canonicalModelsByDate.get(usageDate)
  if (!candidates || candidates.size === 0 || candidates.has(rawModel)) return rawModel

  const familyMatches = [...candidates].filter(
    (candidate) => isCodexContextPricingModel(candidate) && canonicalModelId(candidate) === canonicalModelId(rawModel)
  )
  if (familyMatches.length === 1) return familyMatches[0] as string

  const billableCandidates = [...candidates].filter(isCodexContextPricingModel)
  if (billableCandidates.length === 1) return billableCandidates[0] as string
  return rawModel
}

function identityPathFor(filePath: string, identityPaths?: ReadonlyMap<string, string>) {
  const absolutePath = resolve(filePath)
  return identityPaths?.get(absolutePath) ?? absolutePath
}

function archiveSessionAlias(filePath: string) {
  const normalizedPath = resolve(filePath).replaceAll('\\', '/')
  const match = /^(.*)\/(?:sessions|archived_sessions)\/(.+)$/.exec(normalizedPath)
  if (!match) return null
  return `${match[1]}:${match[2]}`
}

function scopedSessionIdentity(identity: string, filePath: string) {
  const profileRoot = sessionProfileRoot(filePath)
  return profileRoot ? `session:${profileRoot}:\u0000${identity}` : identity
}

function sessionProfileRoot(filePath: string) {
  const normalizedPath = resolve(filePath).replaceAll('\\', '/')
  const match = /^(.*)\/(?:sessions|archived_sessions)\/.+$/.exec(normalizedPath)
  return match?.[1] ?? null
}

function readSessionIdentity(record: UnknownRecord) {
  return (
    readString(record, ['id', 'session_id', 'sessionId', 'thread_id', 'threadId']) ||
    readString(readRecord(record.payload), ['id', 'session_id', 'sessionId', 'thread_id', 'threadId']) ||
    null
  )
}

// Archived copies keep the session path even when a damaged/truncated file no
// longer contains a usable session_meta identity. Include the profile root so
// equal filenames from independent CODEX_HOME profiles remain independent.
function anonymousSessionIdentity(filePath: string) {
  const absolutePath = resolve(filePath)
  const normalizedPath = absolutePath.replaceAll('\\', '/')
  const sessionsMarker = /^(.*)\/(?:sessions|archived_sessions)\/(.+)$/.exec(normalizedPath)
  if (sessionsMarker) {
    const profileRoot = sessionsMarker[1]
    const relativeSessionPath = sessionsMarker[2]
    return `anonymous:${profileRoot}:${relativeSessionPath}`
  }
  const fallbackDirectory = dirname(absolutePath).replaceAll(sep, '/')
  return `anonymous:${fallbackDirectory}:${basename(absolutePath)}`
}

type UsageValues = {
  raw: UnknownRecord
  inputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
}

function readUsage(value: unknown, filePath: string): UsageValues | null {
  const raw = readRecord(value)
  if (!raw) return null
  // Usage metadata can contain total-only bookkeeping rows. They do not carry
  // enough information to price a request, so ignore them instead of failing
  // the whole file before model/date filtering gets a chance to discard them.
  if (!hasAnyField(raw, ['input_tokens', 'inputTokens'])) return null
  const reportedInputTokens = readTokenNumber(raw, ['input_tokens', 'inputTokens'], 'input_tokens', filePath)
  const outputTokens = readTokenNumber(raw, ['output_tokens', 'outputTokens'], 'output_tokens', filePath)
  const cacheReadTokens = readTokenNumber(
    raw,
    ['cached_input_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens', 'cacheReadTokens'],
    'cached_input_tokens',
    filePath
  )
  const cacheCreationTokens = readTokenNumber(
    raw,
    [
      'cache_creation_input_tokens',
      'cache_write_input_tokens',
      'cacheCreationInputTokens',
      'cacheWriteInputTokens',
      'cache_write_tokens',
      'cacheCreationTokens'
    ],
    'cache_creation_input_tokens',
    filePath
  )
  const explicitTotal = readTokenNumber(raw, ['total_tokens', 'totalTokens'], 'total_tokens', filePath)
  // A zero total is emitted by incomplete and synthetic rows. It cannot tell
  // whether cached input is already included, so keep the legacy-compatible
  // input interpretation used by the rest of the Codex parser.
  const hasUsableExplicitTotal = hasAnyField(raw, ['total_tokens', 'totalTokens']) && explicitTotal > 0
  const totalTokens = normalizeCodexTotalTokens({
    inputTokens: reportedInputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    explicitTotalTokens: hasUsableExplicitTotal ? explicitTotal : undefined
  })
  // Codex has emitted both representations over time. Older records include
  // cached input in input_tokens; newer records report it as a separate
  // additive field. The total is the only reliable discriminator.
  const cacheReadIsIncludedInInput =
    !hasUsableExplicitTotal ||
    (cacheReadTokens <= reportedInputTokens && totalTokens === reportedInputTokens + cacheCreationTokens + outputTokens)
  const inputTokens = cacheReadIsIncludedInInput ? reportedInputTokens : reportedInputTokens + cacheReadTokens
  const uncachedInputTokens = cacheReadIsIncludedInInput
    ? subtractNonNegative(reportedInputTokens, cacheReadTokens)
    : reportedInputTokens
  return {
    raw,
    inputTokens,
    uncachedInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens
  }
}

function readTokenNumber(record: UnknownRecord, keys: string[], label: string, filePath: string, required = false) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    const value = record[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid Codex token usage field ${label} in ${filePath}`)
    }
    return value
  }
  if (required) throw new Error(`Codex token usage in ${filePath} is missing ${label}`)
  return 0
}

function hasAnyField(record: UnknownRecord, keys: string[]) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key))
}

function subtractUsage(current: UsageValues, previous: UsageValues | null): UsageValues {
  if (!previous) return current
  return {
    raw: current.raw,
    inputTokens: subtractNonNegative(current.inputTokens, previous.inputTokens),
    uncachedInputTokens: subtractNonNegative(current.uncachedInputTokens, previous.uncachedInputTokens),
    outputTokens: subtractNonNegative(current.outputTokens, previous.outputTokens),
    cacheReadTokens: subtractNonNegative(current.cacheReadTokens, previous.cacheReadTokens),
    cacheCreationTokens: subtractNonNegative(current.cacheCreationTokens, previous.cacheCreationTokens),
    totalTokens: subtractNonNegative(current.totalTokens, previous.totalTokens)
  }
}

function subtractNonNegative(current: number, previous: number) {
  return current >= previous ? current - previous : 0
}

function isEmptyUsage(usage: UsageValues) {
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheCreationTokens === 0
  )
}

function usageEquals(left: UsageValues, right: UsageValues) {
  return (
    left.inputTokens === right.inputTokens &&
    left.uncachedInputTokens === right.uncachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheCreationTokens === right.cacheCreationTokens &&
    left.totalTokens === right.totalTokens
  )
}

function readServiceTier(value: string | null): CodexServiceTier {
  if (value === 'default' || value === 'standard') return 'standard'
  if (value === 'fast' || value === 'priority') return 'fast'
  return null
}

function formatUsageDate(timestamp: string, timezone: string) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid Codex token usage timestamp: ${timestamp}`)
  let formatter = usageDateFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    usageDateFormatters.set(timezone, formatter)
  }
  const parts = formatter.formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function isDateInBounds(date: string, since?: string, until?: string) {
  const normalizedSince = since && !isAllDateFilter(since) ? since.replaceAll('-', '') : undefined
  const normalizedUntil = until && !isAllDateFilter(until) ? until.replaceAll('-', '') : undefined
  const compactDate = date.replaceAll('-', '')
  return (!normalizedSince || compactDate >= normalizedSince) && (!normalizedUntil || compactDate <= normalizedUntil)
}
