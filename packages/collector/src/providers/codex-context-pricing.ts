import { lstat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { maxSnapshotCostUsd } from '@tokenboard/usage-core'
import { assertValidDateFilter, isAllDateFilter } from '../iso-calendar-date'
import { resolveCodexRawUsage } from '../codex-token-usage'
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
  priorityMultiplier?: number
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

type OversizedContextPricingRowSummary = {
  rows: number
  scans: number
  largestBytes: number
}

const oversizedContextPricingRowPattern =
  /^Skipped ([1-9][0-9]*) oversized Codex context pricing JSONL rows? without usage or subagent metadata \(largest ([1-9][0-9]*) bytes\)$/

export type CodexContextPricingModelHints = ReadonlyMap<string, ReadonlySet<string>>
export type CodexContextPricingFileModelHints = ReadonlyMap<string, string>

// Memoizes fingerprint computation within a single collect: the same file set is
// fingerprinted up to three times per run (initial discovery plus two inventory-stability
// assertions), and each fingerprint opens the file and hashes its tail. A memo hit still
// verifies the stat identity (size/mtime/ctime/ino) first, so a file changed between passes
// recomputes and the stability assertion keeps its teeth. The memo lives for one collect
// only — cross-run reuse would weaken the changed-while-collecting detection.
export type CodexSessionFingerprintMemo = {
  get: (filePath: string) => Promise<CodexSessionFileFingerprint>
}

export function createCodexSessionFingerprintMemo(): CodexSessionFingerprintMemo {
  const memo = new Map<string, CodexSessionFileFingerprint>()
  return {
    async get(filePath: string) {
      const cached = memo.get(filePath)
      if (cached) {
        try {
          const current = await lstat(filePath)
          if (sameStatIdentity(current, cached)) return cached
        } catch {
          // fall through to recompute; a vanished file surfaces the same error it would
          // have without the memo.
        }
      }
      const fingerprint = await fingerprintCodexSessionFile(filePath)
      memo.set(filePath, fingerprint)
      return fingerprint
    }
  }
}

function sameStatIdentity(
  current: { size: number; mtimeMs: number; ctimeMs: number; ino: number },
  fingerprint: CodexSessionFileFingerprint
) {
  return (
    current.size === fingerprint.size &&
    current.mtimeMs === fingerprint.mtimeMs &&
    current.ctimeMs === fingerprint.ctimeMs &&
    current.ino === fingerprint.ino
  )
}

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

type CodexContextPricingIndexes = {
  knownModelBases: ReadonlySet<string>
  ruleByModel: ReadonlyMap<string, CodexContextPricingRule>
  canonicalModelByAlias: ReadonlyMap<string, string>
}

const codexContextPricingStorage = new AsyncLocalStorage<CodexContextPricingIndexes>()
const defaultCodexContextPricingIndexes = buildCodexContextPricingIndexes(codexContextPricingRules)

export type DynamicCodexPricingModel = {
  provider?: string
  modelId: string
  inputCostPerMillion: number
  outputCostPerMillion: number
  cacheReadCostPerMillion: number | null
  cacheWriteCostPerMillion: number | null
  pricing: Readonly<Record<string, unknown>>
}

export async function withCodexContextPricingRules<T>(
  rules: readonly CodexContextPricingRule[],
  callback: () => Promise<T> | T
): Promise<T> {
  return await codexContextPricingStorage.run(buildCodexContextPricingIndexes(rules), callback)
}

export function buildCodexContextPricingRules(
  models: readonly DynamicCodexPricingModel[],
  baseRules: readonly CodexContextPricingRule[] = codexContextPricingRules,
  stderr?: (line: string) => void,
  excludedModelIds: ReadonlySet<string> = new Set()
) {
  const knownBaseIds = new Set(
    baseRules.flatMap((rule) => rule.modelIds.map((modelId) => modelId.trim().toLowerCase()))
  )
  const excluded = new Set<string>()
  for (const modelId of excludedModelIds) {
    const normalized = modelId.trim().toLowerCase()
    excluded.add(normalized)
    excluded.add(normalizeModelIdWithBases(normalized, knownBaseIds))
  }
  const rules: CodexContextPricingRule[] = baseRules
    .map((rule) => ({
      ...rule,
      modelIds: rule.modelIds.filter((modelId) => {
        const normalized = modelId.trim().toLowerCase()
        return !excluded.has(normalized) && !excluded.has(normalizeModelIdWithBases(normalized, knownBaseIds))
      }),
      standard: { ...rule.standard },
      longContext: { ...rule.longContext }
    }))
    .filter((rule) => rule.modelIds.length > 0)
  const ruleById = new Map<string, CodexContextPricingRule>()
  const baseModelBases = new Set(rules.flatMap((rule) => rule.modelIds.map((model) => model.trim().toLowerCase())))
  for (const rule of rules) {
    for (const modelId of rule.modelIds) {
      ruleById.set(normalizeModelIdWithBases(modelId, baseModelBases), rule)
    }
  }

  for (const model of selectUnambiguousDynamicPricingModels(models)) {
    const normalizedModelId = normalizeModelIdWithBases(model.modelId, baseModelBases)
    if (excluded.has(model.modelId.trim().toLowerCase()) || excluded.has(normalizedModelId)) continue
    const tier = readDynamicContextTier(model.pricing)
    const existing = ruleById.get(normalizedModelId)
    if (!tier) {
      // A single threshold rule cannot safely represent changing prices across
      // multiple published context tiers. Remove only this model from a shared
      // static rule instead of silently repricing it with stale rates.
      if (hasChangingDynamicContextTiers(model.pricing)) {
        removeContextPricingRuleForModel(rules, ruleById, normalizedModelId, baseModelBases)
        stderr?.(
          `TokenBoard model pricing: skipping dynamic Codex context rule for ${model.modelId}; multiple changing context tiers cannot be represented by the request-level rule`
        )
      }
      continue
    }
    const standard = dynamicRates(model, existing?.standard)
    const longContext = dynamicLongContextRates(model, tier, existing?.longContext)
    if (!standard || !longContext) {
      const missingCachePrices = [
        standard?.cacheRead === undefined || longContext?.cacheRead === undefined ? 'cache-read' : null,
        standard?.cacheCreation === undefined || longContext?.cacheCreation === undefined ? 'cache-write' : null
      ].filter((value): value is string => value !== null)
      stderr?.(
        `TokenBoard model pricing: skipping dynamic Codex context rule for ${model.modelId}; cache pricing is incomplete (${missingCachePrices.join(', ')})`
      )
      continue
    }
    if (existing) removeContextPricingRuleForModel(rules, ruleById, normalizedModelId, baseModelBases)
    const dynamicRule: CodexContextPricingRule = {
      modelIds: [...new Set([model.modelId, normalizedModelId])],
      threshold: tier.threshold,
      standard,
      longContext,
      fastMultiplier: readDynamicMultiplier(model.pricing) ?? existing?.fastMultiplier,
      priorityMultiplier: readDynamicPriorityMultiplier(model.pricing) ?? existing?.priorityMultiplier
    }
    rules.push(dynamicRule)
    ruleById.set(normalizedModelId, dynamicRule)
  }
  return rules
}

function removeContextPricingRuleForModel(
  rules: CodexContextPricingRule[],
  ruleById: Map<string, CodexContextPricingRule>,
  normalizedModelId: string,
  knownModelBases: ReadonlySet<string>
) {
  const existing = ruleById.get(normalizedModelId)
  if (!existing) return

  for (const [key, value] of ruleById) {
    if (value === existing) ruleById.delete(key)
  }

  const remainingModelIds = existing.modelIds.filter(
    (modelId) => normalizeModelIdWithBases(modelId, knownModelBases) !== normalizedModelId
  )
  const index = rules.indexOf(existing)
  if (remainingModelIds.length === 0) {
    if (index >= 0) rules.splice(index, 1)
    return
  }

  const replacement = { ...existing, modelIds: remainingModelIds }
  if (index >= 0) rules[index] = replacement
  for (const modelId of remainingModelIds) {
    ruleById.set(normalizeModelIdWithBases(modelId, knownModelBases), replacement)
  }
}

/**
 * The catalogue is provider-scoped while Codex records only carry a model id.
 * Rows for the same id whose prices disagree cannot be told apart, so the id
 * stays with the static fallback (or unresolved). When every priced row
 * agrees exactly, though, no information is lost by collapsing the group to
 * one representative: prefer the official vendor row (a known provider id)
 * and fall back to input order. All-zero rows only collapse with other
 * all-zero rows — a free-tier promo must not leak into a priced group, and
 * a priced row must not be dragged to zero by a promo row. The representative
 * is picked from the same group the agreement check compares, so an official
 * vendor's $0 placeholder row can never represent a group that has real prices.
 */
export function selectUnambiguousDynamicPricingModels<T extends CollectorPricingModelLike>(models: readonly T[]) {
  const byModelId = new Map<string, T[]>()
  for (const model of models) {
    const key = model.modelId.trim().toLowerCase()
    const entries = byModelId.get(key) ?? []
    entries.push(model)
    byModelId.set(key, entries)
  }
  const collapsed = new Map<string, T>()
  for (const [key, entries] of byModelId) {
    if (entries.length === 1) {
      collapsed.set(key, entries[0])
      continue
    }
    if (!dynamicPriceRowsAgree(entries)) continue
    collapsed.set(key, pickCollapsedRepresentative(dynamicPriceAgreementGroup(entries)))
  }
  return models.filter((model) => collapsed.get(model.modelId.trim().toLowerCase()) === model)
}

type CollectorPricingModelLike = {
  modelId: string
  provider?: string
  inputCostPerMillion: number
  outputCostPerMillion: number
  cacheReadCostPerMillion: number | null
  cacheWriteCostPerMillion: number | null
  pricing: Readonly<Record<string, unknown>>
}

/** Rows agree when their priced signature is identical; all-zero rows compare only with all-zero rows. */
function dynamicPriceRowsAgree(entries: readonly CollectorPricingModelLike[]) {
  const group = dynamicPriceAgreementGroup(entries)
  const signature = priceRowSignature(group[0])
  return group.every((entry) => priceRowSignature(entry) === signature)
}

/**
 * The rows the agreement check and the representative choice both see. When any row carries a
 * real price, zero rows drop out of the group entirely — including an official vendor's $0
 * placeholder row, which would otherwise win the representative pick and silently price the
 * model as free. Only when the whole group is zero-priced do zero rows compare with each other.
 */
function dynamicPriceAgreementGroup<T extends CollectorPricingModelLike>(entries: readonly T[]): readonly T[] {
  const priced = entries.filter((entry) => priceRowIsPositive(entry))
  return priced.length > 0 ? priced : entries
}

function priceRowIsPositive(entry: CollectorPricingModelLike) {
  return entry.inputCostPerMillion > 0 || entry.outputCostPerMillion > 0
}

function priceRowSignature(entry: CollectorPricingModelLike) {
  return JSON.stringify([
    entry.inputCostPerMillion,
    entry.outputCostPerMillion,
    entry.cacheReadCostPerMillion,
    entry.cacheWriteCostPerMillion,
    entry.pricing ?? null
  ])
}

export const officialVendorProviderIds = new Set([
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'moonshotai',
  'zhipuai',
  'zai',
  'xiaomi',
  'alibaba',
  'xai',
  'minimax',
  'nvidia',
  'longcat'
])

// Rows that agree on price can still disagree on context window, and the
// representative carries its own into maxInputTokens. Picking the first match
// would make that value depend on the order rows arrive in — and that order is
// the catalogue's `ORDER BY`, not a property of this code. Prefer an official
// vendor, then the alphabetically first provider, so the choice is reproducible.
function pickCollapsedRepresentative<T extends CollectorPricingModelLike>(entries: readonly T[]): T {
  return [...entries].sort((left, right) => {
    const leftOfficial = officialVendorProviderIds.has((left.provider ?? '').trim().toLowerCase())
    const rightOfficial = officialVendorProviderIds.has((right.provider ?? '').trim().toLowerCase())
    if (leftOfficial !== rightOfficial) return leftOfficial ? -1 : 1
    const leftProvider = (left.provider ?? '').trim().toLowerCase()
    const rightProvider = (right.provider ?? '').trim().toLowerCase()
    if (leftProvider !== rightProvider) return leftProvider < rightProvider ? -1 : 1
    return left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0
  })[0]!
}

export function isCodexContextPricingModel(model: string) {
  return currentCodexContextPricingIndexes().ruleByModel.has(normalizeModelId(model))
}

export function isCodexContextPricingCostGuaranteedZero(model: string) {
  const rule = currentCodexContextPricingIndexes().ruleByModel.get(normalizeModelId(model))
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
  const oversizedDiagnostics: OversizedContextPricingRowSummary = { rows: 0, scans: 0, largestBytes: 0 }
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
      for (const line of diagnostics) {
        const summary = parseOversizedContextPricingRowSummary(line)
        if (summary) {
          oversizedDiagnostics.rows += summary.rows
          oversizedDiagnostics.scans += 1
          oversizedDiagnostics.largestBytes = Math.max(oversizedDiagnostics.largestBytes, summary.largestBytes)
          continue
        }
        input.stderr?.(line)
      }
    }
  }
  if (oversizedDiagnostics.rows > 0) {
    const rowLabel = oversizedDiagnostics.rows === 1 ? 'row' : 'rows'
    const scanLabel = oversizedDiagnostics.scans === 1 ? 'scan' : 'scans'
    input.stderr?.(
      `Skipped ${oversizedDiagnostics.rows} oversized Codex context pricing JSONL ${rowLabel} without usage or subagent metadata across ${oversizedDiagnostics.scans} ${scanLabel} (largest ${oversizedDiagnostics.largestBytes} bytes)`
    )
  }
  return [...totals.values()]
}

function parseOversizedContextPricingRowSummary(line: string): { rows: number; largestBytes: number } | null {
  const match = oversizedContextPricingRowPattern.exec(line)
  if (!match) return null
  const rows = Number(match[1])
  const largestBytes = Number(match[2])
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(largestBytes)) return null
  return { rows, largestBytes }
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
  fingerprintMemo?: CodexSessionFingerprintMemo
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
        allowedRootSymlinks: input.codexSymlinkRoots,
        // This scan carries its own total-file budget and an `allowFileOverflow` degrade; the
        // walker's default per-directory cap is far below it and would throw first, turning the
        // degrade into a hard failure. Raise the per-directory entry cap to this scan's own
        // budget so the file budget below is what governs overflow — not the listing limit. The
        // walker's depth cap still applies (the real codex tree is a handful of levels deep, so
        // it does not bite); only the entry cap is widened here.
        maxEntries: maxCodexContextPricingFiles
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
      const fingerprint = await (input.fingerprintMemo?.get(resolve(filePath)) ?? fingerprintCodexSessionFile(filePath))
      fingerprints.set(resolve(filePath), fingerprint)
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
    if (cost === undefined) return snapshot
    // The rates here come from a dynamic catalogue and the tokens from a user's own session
    // files, so neither is bounded by this module. The shared `usageSnapshotSchema` validated
    // the snapshot *before* context pricing rewrote its cost, and this is the only place that
    // writes one afterwards — the subagent path re-parses for the same reason. A non-finite,
    // negative, or above-`maxSnapshotCostUsd` product (an extreme rate times an extreme token
    // count) would otherwise leave the collector as a cost the server rejects at ingest, far
    // from the cause.
    if (!Number.isFinite(cost) || cost < 0 || cost > maxSnapshotCostUsd) {
      throw new Error(`Codex context pricing produced an invalid cost for ${snapshot.usageDate}/${snapshot.model}`)
    }
    return { ...snapshot, costUsd: cost }
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
  const rule = currentCodexContextPricingIndexes().ruleByModel.get(normalizeModelId(input.model))
  if (!rule) return null
  const requestContextTokens = input.inputTokens + input.cacheCreationTokens
  const rates = requestContextTokens > rule.threshold ? rule.longContext : rule.standard
  const multiplier = serviceTierMultiplier(rule, input.serviceTier)
  const uncachedInputTokens = input.uncachedInputTokens ?? Math.max(0, input.inputTokens - input.cacheReadTokens)
  return (
    multiplier *
    (uncachedInputTokens * rates.input +
      input.outputTokens * rates.output +
      input.cacheReadTokens * rates.cacheRead +
      input.cacheCreationTokens * rates.cacheCreation)
  )
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
    if (!currentCodexContextPricingIndexes().ruleByModel.has(normalizeModelId(model))) continue
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
  const rule = currentCodexContextPricingIndexes().ruleByModel.get(normalizeModelId(input.model))
  if (!rule) return null
  const rates = input.contextTier === 'long' ? rule.longContext : rule.standard
  const multiplier = serviceTierMultiplier(rule, input.serviceTier)
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
  return currentCodexContextPricingIndexes().knownModelBases.has(base) ? base : normalized
}

function currentCodexContextPricingIndexes() {
  return codexContextPricingStorage.getStore() ?? defaultCodexContextPricingIndexes
}

function buildCodexContextPricingIndexes(rules: readonly CodexContextPricingRule[]): CodexContextPricingIndexes {
  const knownModelBases = new Set(rules.flatMap((rule) => rule.modelIds.map((model) => model.trim().toLowerCase())))
  const ruleByModel = new Map(
    rules.flatMap((rule) =>
      rule.modelIds.map((model) => [normalizeModelIdWithBases(model, knownModelBases), rule] as const)
    )
  )
  const canonicalModelByAlias = new Map(
    rules.flatMap((rule) => {
      const canonical = normalizeModelIdWithBases(rule.modelIds[0] ?? '', knownModelBases)
      return rule.modelIds.map((model) => [normalizeModelIdWithBases(model, knownModelBases), canonical] as const)
    })
  )
  return { knownModelBases, ruleByModel, canonicalModelByAlias }
}

function normalizeModelIdWithBases(value: string, knownModelBases: ReadonlySet<string>) {
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
  return knownModelBases.has(base) ? base : normalized
}

function serviceTierMultiplier(rule: CodexContextPricingRule, serviceTier: CodexServiceTier | undefined) {
  if (serviceTier === 'fast') return rule.fastMultiplier ?? 1
  if (serviceTier === 'priority') return rule.priorityMultiplier ?? rule.fastMultiplier ?? 1
  return 1
}

function dynamicRates(model: DynamicCodexPricingModel, fallback?: PricingRates): PricingRates | null {
  const cacheRead =
    model.cacheReadCostPerMillion === null ? fallback?.cacheRead : model.cacheReadCostPerMillion / 1_000_000
  const cacheCreation =
    model.cacheWriteCostPerMillion === null ? fallback?.cacheCreation : model.cacheWriteCostPerMillion / 1_000_000
  if (cacheRead === undefined || cacheCreation === undefined) return null
  return {
    input: model.inputCostPerMillion / 1_000_000,
    output: model.outputCostPerMillion / 1_000_000,
    cacheRead,
    cacheCreation
  }
}

function dynamicLongContextRates(
  model: DynamicCodexPricingModel,
  tier: {
    input: number
    output: number
    cacheRead: number | null
    cacheWrite: number | null
  },
  fallback?: PricingRates
): PricingRates | null {
  const cacheRead =
    tier.cacheRead === null
      ? model.cacheReadCostPerMillion === null
        ? fallback?.cacheRead
        : model.cacheReadCostPerMillion / 1_000_000
      : tier.cacheRead / 1_000_000
  const cacheCreation =
    tier.cacheWrite === null
      ? model.cacheWriteCostPerMillion === null
        ? fallback?.cacheCreation
        : model.cacheWriteCostPerMillion / 1_000_000
      : tier.cacheWrite / 1_000_000
  if (cacheRead === undefined || cacheCreation === undefined) return null
  return {
    input: tier.input / 1_000_000,
    output: tier.output / 1_000_000,
    cacheRead,
    cacheCreation
  }
}

function readDynamicContextTier(pricing: Readonly<Record<string, unknown>>) {
  const parsedExplicit = readDynamicContextTiers(pricing)
  if (parsedExplicit[0] && !hasChangingLaterContextTier(parsedExplicit)) return parsedExplicit[0]
  if (parsedExplicit[0]) return null
  if (!isRecord(pricing.context_over_200k)) return null
  return parseDynamicContextTier({ ...pricing.context_over_200k, tier: { type: 'context', size: 200_000 } })
}

function hasChangingDynamicContextTiers(pricing: Readonly<Record<string, unknown>>) {
  const tiers = readDynamicContextTiers(pricing)
  return tiers.length > 0 && hasChangingLaterContextTier(tiers)
}

function readDynamicContextTiers(pricing: Readonly<Record<string, unknown>>) {
  const values: Array<Record<string, unknown>> = []
  if (Array.isArray(pricing.tiers)) {
    for (const value of pricing.tiers) {
      if (isRecord(value)) values.push(value)
    }
  }
  return values
    .map((value) => {
      const tier = isRecord(value.tier) ? value.tier : null
      const threshold = tier?.type === 'context' ? tier.size : null
      if (!isSafePositiveInteger(threshold)) return null
      const input = finiteNonNegative(value.input)
      const output = finiteNonNegative(value.output)
      if (input === null || output === null) return null
      return {
        threshold,
        input,
        output,
        cacheRead: nullableFiniteNonNegative(value.cache_read),
        cacheWrite: nullableFiniteNonNegative(value.cache_write)
      }
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((left, right) => left.threshold - right.threshold)
}

function hasChangingLaterContextTier(
  tiers: ReadonlyArray<{
    input: number
    output: number
    cacheRead: number | null
    cacheWrite: number | null
  }>
) {
  const first = tiers[0]
  if (!first) return false
  return tiers
    .slice(1)
    .some(
      (tier) =>
        tier.input !== first.input ||
        tier.output !== first.output ||
        tier.cacheRead !== first.cacheRead ||
        tier.cacheWrite !== first.cacheWrite
    )
}

function parseDynamicContextTier(value: Record<string, unknown>) {
  const tier = isRecord(value.tier) ? value.tier : null
  const threshold = tier?.type === 'context' ? tier.size : null
  if (!isSafePositiveInteger(threshold)) return null
  const input = finiteNonNegative(value.input)
  const output = finiteNonNegative(value.output)
  if (input === null || output === null) return null
  return {
    threshold,
    input,
    output,
    cacheRead: nullableFiniteNonNegative(value.cache_read),
    cacheWrite: nullableFiniteNonNegative(value.cache_write)
  }
}

function readDynamicMultiplier(pricing: Readonly<Record<string, unknown>>) {
  for (const key of ['fastMultiplier', 'fast_multiplier']) {
    const value = finitePositive(pricing[key])
    if (value !== null) return value
  }
  return null
}

function readDynamicPriorityMultiplier(pricing: Readonly<Record<string, unknown>>) {
  for (const key of ['priorityMultiplier', 'priority_multiplier']) {
    const value = finitePositive(pricing[key])
    if (value !== null) return value
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNonNegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function nullableFiniteNonNegative(value: unknown) {
  if (value === null || value === undefined) return null
  return finiteNonNegative(value)
}

function finitePositive(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
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
  return currentCodexContextPricingIndexes().canonicalModelByAlias.get(normalized) ?? normalized
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

    if (!normalizedModel || !modelKey || !currentCodexContextPricingIndexes().ruleByModel.has(normalizedModel)) {
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
    const rule = currentCodexContextPricingIndexes().ruleByModel.get(normalizedModel)
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
    readString(record, ['session_id', 'sessionId', 'thread_id', 'threadId', 'id']) ||
    readString(readRecord(record.payload), ['session_id', 'sessionId', 'thread_id', 'threadId', 'id']) ||
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
  // `resolveCodexRawUsage` owns the legacy/additive decision and the matching total, so this
  // path and the hook parser cannot drift apart on how a raw Codex row is read.
  const resolved = resolveCodexRawUsage({
    inputTokens: reportedInputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    explicitTotalTokens: hasUsableExplicitTotal ? explicitTotal : undefined
  })
  const cacheReadIsIncludedInInput = resolved.cacheReadIncludedInInput
  const inputTokens = cacheReadIsIncludedInInput ? reportedInputTokens : reportedInputTokens + cacheReadTokens
  const uncachedInputTokens = cacheReadIsIncludedInInput
    ? subtractNonNegative(reportedInputTokens, cacheReadTokens)
    : reportedInputTokens
  const totalTokens = resolved.totalTokens
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
  if (value === 'fast') return 'fast'
  if (value === 'priority') return 'priority'
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
