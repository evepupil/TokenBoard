import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { renameAtomic } from './rename-atomic'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCodexContextPricingRules,
  codexContextPricingRules,
  officialVendorProviderIds,
  selectUnambiguousDynamicPricingModels,
  type CodexContextPricingRule
} from './providers/codex-context-pricing'

export const modelPricingCacheSchemaVersion = 1
export const modelPricingCacheTtlMs = 24 * 60 * 60 * 1000
export const modelPricingPageSize = 1_000
export const modelPricingRequestTimeoutMs = 20_000
export const maxModelPricingResponseBytes = 16 * 1024 * 1024
export const modelPricingCacheFileName = 'model-pricing-cache.json'
export const dynamicCcusageConfigFileName = 'ccusage.dynamic.json'

const modelIdPattern = /^(?![.]{1,2}$).{1,512}$/u
const providerIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/
const controlCharacters = /[\p{Cc}\p{Cf}\p{Cs}]/u

export type CollectorPricingModel = {
  provider: string
  modelId: string
  inputCostPerMillion: number
  outputCostPerMillion: number
  cacheReadCostPerMillion: number | null
  cacheWriteCostPerMillion: number | null
  contextWindow: number
  maxInputTokens: number | null
  pricing: Record<string, unknown>
}

export type ModelPricingCatalogue = {
  models: CollectorPricingModel[]
  source: 'network' | 'cache' | 'static'
  endpointOrigin: string | null
  fetchedAt: string
  etag: string | null
}

export type PricingFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type DynamicCcusageConfigResult = {
  configPath?: string
  catalogue: ModelPricingCatalogue
  overrides: Record<string, CcusagePricingOverride>
  contextPricingRules: readonly CodexContextPricingRule[]
  coveredModelIds: ReadonlySet<string>
}

export type CcusagePricingOverride = {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheReadInputTokenCost?: number
  cacheCreationInputTokenCost?: number
  maxInputTokens?: number
  fastMultiplier?: number
  inputCostPerTokenAbove200kTokens?: number
  outputCostPerTokenAbove200kTokens?: number
  cacheReadInputTokenCostAbove200kTokens?: number
  cacheCreationInputTokenCostAbove200kTokens?: number
}

type JsonRecord = Record<string, unknown>

export async function loadModelPricingCatalogue(input: {
  endpoint?: string
  stateDir?: string
  hookMode?: boolean
  now?: Date
  fetcher?: PricingFetcher
  stderr?: (line: string) => void
}): Promise<ModelPricingCatalogue> {
  const now = input.now ?? new Date()
  const endpointOrigin = endpointOriginFromEndpoint(input.endpoint)
  const stateDir = input.stateDir?.trim() || defaultStateDir()
  const cachePath = modelPricingCachePath(stateDir)
  const cached = await readPricingCache(cachePath, endpointOrigin, input.stderr)

  if (cached && isCacheFresh(cached, now)) {
    input.stderr?.(`TokenBoard model pricing: using cached catalogue (${cached.models.length} models)`)
    return { ...cached, source: 'cache' }
  }

  if (input.hookMode) {
    if (cached) {
      input.stderr?.(
        `TokenBoard model pricing: hook mode is offline; using cached catalogue (${cached.models.length} models)`
      )
      return { ...cached, source: 'cache' }
    }
    input.stderr?.('TokenBoard model pricing: hook mode has no usable cache; using bundled static pricing')
    return staticModelPricingCatalogue()
  }

  if (!endpointOrigin) {
    // Distinguish "not set" from "set but unusable" (`not-a-url`, `ftp://…`): both end at the
    // same fallback, but an operator reading the log needs to know which one to fix.
    const problem = input.endpoint?.trim() ? 'is invalid' : 'is not configured'
    if (cached) {
      input.stderr?.(
        `TokenBoard model pricing: TOKENBOARD_ENDPOINT ${problem}; using last successful cache (${cached.models.length} models)`
      )
      return { ...cached, source: 'cache' }
    }
    input.stderr?.(`TokenBoard model pricing: TOKENBOARD_ENDPOINT ${problem}; using bundled static pricing`)
    return staticModelPricingCatalogue()
  }

  let fetched: ModelPricingCatalogue
  try {
    fetched = await fetchModelPricingCatalogue({
      endpointOrigin,
      cached,
      now,
      fetcher: input.fetcher
    })
  } catch (error) {
    const detail = errorMessage(error)
    if (cached) {
      input.stderr?.(
        `TokenBoard model pricing: refresh failed (${detail}); using last successful cache (${cached.models.length} models)`
      )
      return { ...cached, source: 'cache' }
    }
    input.stderr?.(`TokenBoard model pricing: refresh failed (${detail}); using bundled static pricing`)
    return staticModelPricingCatalogue()
  }

  try {
    await writePricingCache(cachePath, fetched)
  } catch (error) {
    input.stderr?.(
      `TokenBoard model pricing: cache write failed (${errorMessage(error)}); using fetched catalogue (${fetched.models.length} models)`
    )
  }
  input.stderr?.(`TokenBoard model pricing: refreshed catalogue (${fetched.models.length} models)`)
  return { ...fetched, source: 'network' }
}

// A `--source all` run collects claude-code and codex in one process, and each
// provider prepared its own catalogue. When the endpoint has no pricing route
// the fetch fails and nothing is written to the cache, so the second provider
// repeated the same doomed request: a run against a route-less server made two
// 404 round trips of ~0.8s each, every time.
//
// The memo covers exactly that case. A successful refresh (or a fresh on-disk
// cache) already makes the second call cheap, so it is not memoized and the
// cache file stays the single source of truth across runs. Keyed by endpoint
// origin: a run that touches two servers must ask each, and the hook path
// never reaches here at all.
const inFlightPricing = new Map<string, Promise<DynamicCcusageConfigResult>>()

// resetModelPricingMemo clears the per-process memo. Tests call it between
// cases; production code never needs to, because a collector process runs one
// command and exits.
export function resetModelPricingMemo() {
  inFlightPricing.clear()
}

export async function prepareDynamicCcusageConfig(input: {
  endpoint?: string
  stateDir?: string
  hookMode?: boolean
  explicitConfigPath?: string
  now?: Date
  fetcher?: PricingFetcher
  stderr?: (line: string) => void
}): Promise<DynamicCcusageConfigResult> {
  // The memo is keyed by everything that can change the answer. Wall clock and
  // the fetcher deliberately are not: within one collector process there is one
  // run, and sharing its one attempt is the point.
  const memoKey = JSON.stringify([
    endpointOriginFromEndpoint(input.endpoint) ?? '',
    input.stateDir?.trim() || defaultStateDir(),
    input.hookMode === true,
    input.explicitConfigPath?.trim() ?? ''
  ])
  const memoized = inFlightPricing.get(memoKey)
  if (memoized) return memoized
  const prepared = loadDynamicCcusageConfig(input)
  inFlightPricing.set(memoKey, prepared)
  try {
    return await prepared
  } catch (error) {
    // A throw is not a result to reuse: the next provider must be free to try
    // again rather than inherit a failure that may have been transient.
    inFlightPricing.delete(memoKey)
    throw error
  }
}

async function loadDynamicCcusageConfig(input: {
  endpoint?: string
  stateDir?: string
  hookMode?: boolean
  explicitConfigPath?: string
  now?: Date
  fetcher?: PricingFetcher
  stderr?: (line: string) => void
}): Promise<DynamicCcusageConfigResult> {
  const catalogue = await loadModelPricingCatalogue(input)
  const staticConfig = await readBundledCcusageConfig()
  const explicitConfig = await readOptionalJsonConfig(input.explicitConfigPath, input.stderr)
  const overrides =
    catalogue.source === 'static' ? readPricingOverrides(staticConfig) : createCcusagePricingOverrides(catalogue.models)
  const merged = mergeCcusageConfig(
    staticConfig,
    overrides,
    explicitConfig,
    nonRepresentableContextPricingModelIds(catalogue.models, overrides)
  )
  const explicitPricingOverrides = readPricingOverrides(explicitConfig ?? {})
  const contextPricingRules = buildCodexContextPricingRules(
    catalogue.models,
    codexContextPricingRules,
    input.stderr,
    new Set(Object.keys(explicitPricingOverrides))
  )
  const coveredModelIds = new Set<string>([
    ...Object.keys(readPricingOverrides(staticConfig)),
    ...Object.keys(readPricingOverrides(explicitConfig ?? {})),
    ...(catalogue.source === 'static' ? [] : Object.keys(overrides))
  ])

  // Static fallback already is the bundled file. Avoid creating a second copy
  // in the state directory when no server/cache catalogue was available.
  if (catalogue.source === 'static' && !explicitConfig) {
    return {
      configPath: bundledCcusageConfigPath(),
      catalogue,
      overrides,
      contextPricingRules,
      coveredModelIds
    }
  }

  const stateDir = input.stateDir?.trim() || defaultStateDir()
  const configPath = dynamicCcusageConfigPath(stateDir)
  try {
    await writeJsonAtomically(configPath, merged, 0o600)
    input.stderr?.(`TokenBoard model pricing: prepared ccusage config at ${configPath}`)
    return { configPath, catalogue, overrides, contextPricingRules, coveredModelIds }
  } catch (error) {
    const fallbackPath = input.explicitConfigPath?.trim() || bundledCcusageConfigPath()
    const fallbackContextPricingRules = buildCodexContextPricingRules(
      [],
      codexContextPricingRules,
      input.stderr,
      new Set(Object.keys(explicitPricingOverrides))
    )
    input.stderr?.(
      `TokenBoard model pricing: dynamic ccusage config write failed (${errorMessage(error)}); using ${
        input.explicitConfigPath?.trim() ? 'explicit' : 'bundled'
      } config ${fallbackPath}`
    )
    return {
      configPath: fallbackPath,
      catalogue,
      overrides,
      contextPricingRules: fallbackContextPricingRules,
      coveredModelIds: new Set([
        ...Object.keys(readPricingOverrides(staticConfig)),
        ...Object.keys(readPricingOverrides(explicitConfig ?? {}))
      ])
    }
  }
}

export function modelPricingCachePath(stateDir: string) {
  return join(stateDir, modelPricingCacheFileName)
}

export function dynamicCcusageConfigPath(stateDir: string) {
  return join(stateDir, dynamicCcusageConfigFileName)
}

export function endpointOriginFromEndpoint(endpoint: string | undefined) {
  if (!endpoint?.trim()) return null
  try {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return url.origin
  } catch {
    return null
  }
}

export function modelPricingUrl(endpointOrigin: string, cursor?: string) {
  // Keep collector traffic on the stable versioned compatibility alias.
  const url = new URL('/api/v1/model-pricing', `${endpointOrigin}/`)
  url.searchParams.set('limit', String(modelPricingPageSize))
  if (cursor) url.searchParams.set('cursor', cursor)
  return url.toString()
}

export function createCcusagePricingOverrides(
  models: readonly CollectorPricingModel[],
  fallbackConfig?: JsonRecord
): Record<string, CcusagePricingOverride> {
  const dynamicOverrides: Record<string, CcusagePricingOverride> = {}
  for (const model of selectUnambiguousDynamicPricingModels(models)) {
    const override = toCcusagePricingOverride(model)
    if (override) dynamicOverrides[model.modelId] = override
  }
  for (const [modelId, override] of officialAnchorOverrides(models, dynamicOverrides)) {
    dynamicOverrides[modelId] = override
  }
  return mergePricingOverrides(
    fallbackConfig ? readPricingOverrides(fallbackConfig) : {},
    dynamicOverrides,
    {},
    nonRepresentableContextPricingModelIds(models, dynamicOverrides)
  )
}

// ccusage matches an override key to the model name it sees in a session by folding provider
// prefixes and variant suffixes, so a key like `xiaomi/mimo-v2.6-flash-uncensored` can price a
// plain `mimo-v2.6-flash` day. When the base id is unresolved (its reseller rows disagree) that
// folding key is the only one left and it wins — one machine billed 3.6x the official rate for
// mimo-v2.6-flash this way. An exact key beats a folding one, so the official vendor row is
// emitted as the base id's own key and restores the right rate.
//
// Only an official row is used. Falling back to a reseller row would re-introduce exactly the
// ambiguity the unresolved id was dropped for, and turning that into an explicit anchor would
// launder an arbitrary reseller price into an authoritative one.
function officialAnchorOverrides(
  models: readonly CollectorPricingModel[],
  emitted: Readonly<Record<string, CcusagePricingOverride>>
): Array<[string, CcusagePricingOverride]> {
  const byBase = new Map<string, CollectorPricingModel[]>()
  for (const model of models) {
    const base = foldToBaseModelId(model.modelId)
    if (base === model.modelId.trim().toLowerCase()) continue
    const entries = byBase.get(base) ?? []
    entries.push(model)
    byBase.set(base, entries)
  }
  if (byBase.size === 0) return []

  const haveExact = new Set(Object.keys(emitted).map((key) => key.trim().toLowerCase()))
  const byId = new Map<string, CollectorPricingModel[]>()
  for (const model of models) {
    const id = model.modelId.trim().toLowerCase()
    if (!byBase.has(id) || haveExact.has(id)) continue
    const entries = byId.get(id) ?? []
    entries.push(model)
    byId.set(id, entries)
  }

  const anchors: Array<[string, CcusagePricingOverride]> = []
  for (const [, rows] of byId) {
    const official = rows.find(
      (row) => officialVendorProviderIds.has(row.provider.trim().toLowerCase()) && priceRowIsPositive(row)
    )
    if (!official) continue
    const override = toCcusagePricingOverride(official)
    if (override) anchors.push([rows[0]!.modelId, override])
  }
  return anchors
}

// The bases ccusage may fold a key onto: drop `:tag` segments, drop the provider prefix, then
// drop a fine-tune variant suffix. Kept deliberately narrow — only the folding case observed on
// real data — because over-folding would anchor ids ccusage never conflates.
const variantSuffixPattern = /-(?:uncensored|abliterated)$/

export function foldToBaseModelId(modelId: string): string {
  const withoutTags = modelId
    .trim()
    .toLowerCase()
    .replace(/:[^:/]*/g, '')
  const segments = withoutTags.split('/')
  return (segments[segments.length - 1] ?? withoutTags).replace(variantSuffixPattern, '')
}

function priceRowIsPositive(row: CollectorPricingModel) {
  return row.inputCostPerMillion > 0 || row.outputCostPerMillion > 0
}

export function toCcusagePricingOverride(model: CollectorPricingModel): CcusagePricingOverride | null {
  if (!isFiniteNonNegative(model.inputCostPerMillion) || !isFiniteNonNegative(model.outputCostPerMillion)) return null
  const override: CcusagePricingOverride = {
    inputCostPerToken: model.inputCostPerMillion / 1_000_000,
    outputCostPerToken: model.outputCostPerMillion / 1_000_000
  }
  if (model.cacheReadCostPerMillion !== null) {
    override.cacheReadInputTokenCost = model.cacheReadCostPerMillion / 1_000_000
  }
  if (model.cacheWriteCostPerMillion !== null) {
    override.cacheCreationInputTokenCost = model.cacheWriteCostPerMillion / 1_000_000
  }
  if (model.contextWindow > 0) override.maxInputTokens = model.contextWindow

  const contextTiers = readContextTiers(model.pricing)
  const contextTier = contextTiers[0]
  if (contextTier?.threshold === 200_000 && !hasChangingLaterContextTier(contextTiers)) {
    override.inputCostPerTokenAbove200kTokens = contextTier.input / 1_000_000
    override.outputCostPerTokenAbove200kTokens = contextTier.output / 1_000_000
    if (contextTier.cacheRead !== null) {
      override.cacheReadInputTokenCostAbove200kTokens = contextTier.cacheRead / 1_000_000
    }
    if (contextTier.cacheWrite !== null) {
      override.cacheCreationInputTokenCostAbove200kTokens = contextTier.cacheWrite / 1_000_000
    }
  }

  const multiplier = readMultiplier(model.pricing)
  if (multiplier !== null) override.fastMultiplier = multiplier
  return override
}

export function validateModelPricingResponse(payload: unknown): {
  models: CollectorPricingModel[]
  nextCursor: string | null
} {
  const root = asRecord(payload, 'pricing response')
  if (!Array.isArray(root.models)) throw new Error('Model pricing response is missing models')
  const models = root.models.map((value, index) => normalizeCatalogueModel(value, `models[${index}]`))
  const nextCursor = root.nextCursor ?? null
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0)) {
    throw new Error('Model pricing response returned an invalid nextCursor')
  }
  return { models, nextCursor }
}

export function normalizeCachedCatalogue(value: unknown, endpointOrigin: string | null): ModelPricingCatalogue {
  const root = asRecord(value, 'model pricing cache')
  if (root.schemaVersion !== modelPricingCacheSchemaVersion) throw new Error('Unsupported model pricing cache version')
  const cachedEndpointOrigin = requiredString(root.endpointOrigin, 'cache endpointOrigin')
  if (endpointOriginFromEndpoint(cachedEndpointOrigin) !== cachedEndpointOrigin) {
    throw new Error('Model pricing cache endpoint is invalid')
  }
  if (endpointOrigin !== null && cachedEndpointOrigin !== endpointOrigin) {
    throw new Error('Model pricing cache endpoint does not match')
  }
  const fetchedAt = requiredTimestamp(root.fetchedAt, 'cache fetchedAt')
  const etag = root.etag === null || root.etag === undefined ? null : requiredString(root.etag, 'cache etag')
  if (!Array.isArray(root.models)) throw new Error('Model pricing cache is missing models')
  const models = root.models.map((model, index) => normalizeCatalogueModel(model, `cache.models[${index}]`))
  if (models.length === 0) throw new Error('Model pricing cache did not contain any models')
  assertUniqueModels(models)
  return { models, source: 'cache', endpointOrigin: cachedEndpointOrigin, fetchedAt, etag }
}

function isCacheFresh(cache: ModelPricingCatalogue, now: Date) {
  const fetchedAt = Date.parse(cache.fetchedAt)
  return Number.isFinite(fetchedAt) && now.getTime() >= fetchedAt && now.getTime() - fetchedAt <= modelPricingCacheTtlMs
}

export async function fetchModelPricingCatalogue(input: {
  endpointOrigin: string
  cached: ModelPricingCatalogue | null
  now: Date
  fetcher?: PricingFetcher
}): Promise<ModelPricingCatalogue> {
  const fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis)
  const models: CollectorPricingModel[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let etag: string | null = input.cached?.etag ?? null
  const seenCursors = new Set<string>()
  for (let page = 0; page < 100; page += 1) {
    const headers = new Headers({ accept: 'application/json' })
    if (page === 0 && etag) headers.set('if-none-match', etag)
    const response = await fetchWithTimeout(fetcher, modelPricingUrl(input.endpointOrigin, cursor), {
      headers,
      redirect: 'manual'
    })
    if (response.status === 304) {
      if (!input.cached) throw new Error('Model pricing source returned 304 without a cache')
      return { ...input.cached, fetchedAt: input.now.toISOString(), etag: input.cached.etag }
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Model pricing source returned an unexpected redirect HTTP ${response.status}`)
    }
    if (!response.ok) throw new Error(`Model pricing source returned HTTP ${response.status}`)
    const body = await readResponseJson(response)
    const parsed = validateModelPricingResponse(body)
    if (page === 0) etag = response.headers.get('etag') ?? etag
    for (const model of parsed.models) {
      const key = `${model.provider}\u0000${model.modelId}`
      if (seen.has(key)) throw new Error(`Model pricing response returned duplicate model ${key}`)
      seen.add(key)
      models.push(model)
    }
    if (!parsed.nextCursor) {
      cursor = undefined
      break
    }
    if (seenCursors.has(parsed.nextCursor)) throw new Error('Model pricing response returned a cursor loop')
    seenCursors.add(parsed.nextCursor)
    cursor = parsed.nextCursor
  }
  if (cursor) throw new Error('Model pricing response exceeded the pagination limit')
  if (models.length === 0) throw new Error('Model pricing response did not contain any models')
  assertUniqueModels(models)
  return {
    models,
    source: 'network',
    endpointOrigin: input.endpointOrigin,
    fetchedAt: input.now.toISOString(),
    etag
  }
}

async function fetchWithTimeout(fetcher: PricingFetcher, input: RequestInfo | URL, init: RequestInit) {
  try {
    return await fetcher(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(modelPricingRequestTimeoutMs)
    })
  } catch (error) {
    if (isAbortError(error)) throw new Error('Model pricing request timed out')
    throw error
  }
}

async function readResponseJson(response: Response) {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsedLength = Number(contentLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0)
      throw new Error('Model pricing response has invalid length')
    if (parsedLength > maxModelPricingResponseBytes) throw new Error('Model pricing response is too large')
  }
  let bytes: Uint8Array
  try {
    if (!response.body) {
      bytes = new Uint8Array(await response.arrayBuffer())
    } else {
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        total += chunk.value.byteLength
        if (total > maxModelPricingResponseBytes) {
          await reader.cancel()
          throw new Error('Model pricing response is too large')
        }
        chunks.push(chunk.value)
      }
      bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw new Error('Model pricing request timed out')
    throw error
  }
  if (bytes.byteLength > maxModelPricingResponseBytes) throw new Error('Model pricing response is too large')
  let body: string
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Model pricing response is not valid UTF-8')
  }
  try {
    return JSON.parse(body) as unknown
  } catch (error) {
    throw new Error(`Model pricing response returned invalid JSON: ${errorMessage(error)}`)
  }
}

async function readPricingCache(path: string, endpointOrigin: string | null, stderr?: (line: string) => void) {
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, 'utf8')
    return normalizeCachedCatalogue(JSON.parse(raw), endpointOrigin)
  } catch (error) {
    stderr?.(`TokenBoard model pricing: ignoring invalid cache (${errorMessage(error)})`)
    return null
  }
}

async function writePricingCache(path: string, catalogue: ModelPricingCatalogue) {
  await writeJsonAtomically(path, {
    schemaVersion: modelPricingCacheSchemaVersion,
    endpointOrigin: catalogue.endpointOrigin,
    fetchedAt: catalogue.fetchedAt,
    etag: catalogue.etag,
    models: catalogue.models
  })
}

async function writeJsonAtomically(path: string, value: unknown, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  try {
    await writeFile(tempPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode })
    await renameAtomic(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

async function readBundledCcusageConfig(): Promise<JsonRecord> {
  const path = bundledCcusageConfigPath()
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  return asRecord(value, 'bundled ccusage config')
}

async function readOptionalJsonConfig(path: string | undefined, _stderr?: (line: string) => void) {
  if (!path?.trim()) return null
  // The standalone bin wrapper supplies the bundled file through
  // TOKENBOARD_CCUSAGE_CONFIG for offline compatibility. It is the static
  // baseline, not a user override, so dynamic catalogue prices must still
  // be allowed to replace its entries.
  if (resolve(path) === resolve(bundledCcusageConfigPath())) return null
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  return asRecord(value, 'explicit ccusage config')
}

function mergeCcusageConfig(
  bundled: JsonRecord,
  dynamicOverrides: Record<string, CcusagePricingOverride>,
  explicit: JsonRecord | null,
  nonRepresentableContextPricingModelIds: ReadonlySet<string> = new Set()
) {
  const bundledDefaults = asRecord(bundled.defaults, 'bundled defaults')
  const explicitDefaults = explicit ? asRecord(explicit.defaults ?? {}, 'explicit defaults') : {}
  const pricingOverrides = mergePricingOverrides(
    readPricingOverrides(bundled),
    dynamicOverrides,
    readPricingOverrides(explicit ?? {}),
    nonRepresentableContextPricingModelIds
  )
  return {
    ...bundled,
    ...(explicit ?? {}),
    defaults: {
      ...bundledDefaults,
      ...asRecord(explicitDefaults, 'explicit defaults'),
      pricingOverrides
    },
    codex: {
      ...asRecord(bundled.codex ?? {}, 'bundled codex'),
      ...asRecord(explicit?.codex ?? {}, 'explicit codex'),
      defaults: {
        ...asRecord(asRecord(bundled.codex ?? {}, 'bundled codex').defaults ?? {}, 'bundled codex defaults'),
        ...asRecord(asRecord(explicit?.codex ?? {}, 'explicit codex').defaults ?? {}, 'explicit codex defaults')
      }
    }
  }
}

function mergePricingOverrides(
  bundled: Record<string, unknown>,
  dynamic: Record<string, unknown>,
  explicit: Record<string, unknown>,
  nonRepresentableContextPricingModelIds: ReadonlySet<string> = new Set()
) {
  const result: Record<string, CcusagePricingOverride> = {}
  for (const [layerIndex, layer] of [bundled, dynamic, explicit].entries()) {
    for (const [modelId, value] of Object.entries(layer)) {
      const previous = result[modelId]
      if (isRecord(value)) {
        const base = { ...(previous ?? {}) }
        if (layerIndex === 1 && nonRepresentableContextPricingModelIds.has(modelId)) {
          for (const key of longContextOverrideKeys) delete base[key]
        }
        result[modelId] = {
          ...base,
          ...value
        } as CcusagePricingOverride
      } else {
        // Keep invalid user-provided values visible to ccusage validation rather
        // than silently dropping them during the precedence merge.
        result[modelId] = value as CcusagePricingOverride
      }
    }
  }
  return result
}

const longContextOverrideKeys = [
  'cacheCreationInputTokenCostAbove200kTokens',
  'cacheReadInputTokenCostAbove200kTokens',
  'inputCostPerTokenAbove200kTokens',
  'outputCostPerTokenAbove200kTokens'
] as const

function nonRepresentableContextPricingModelIds(
  models: readonly CollectorPricingModel[],
  overrides: Record<string, unknown>
) {
  return new Set(
    models
      .filter((model) => Object.prototype.hasOwnProperty.call(overrides, model.modelId))
      .filter((model) => {
        const tiers = readContextTiers(model.pricing)
        return tiers.length > 0 && (tiers[0]?.threshold !== 200_000 || hasChangingLaterContextTier(tiers))
      })
      .map((model) => model.modelId)
  )
}

function readPricingOverrides(config: JsonRecord) {
  const defaults = isRecord(config.defaults) ? config.defaults : null
  const value = defaults && isRecord(defaults.pricingOverrides) ? defaults.pricingOverrides : {}
  return value as Record<string, CcusagePricingOverride>
}

export function staticModelPricingCatalogue(): ModelPricingCatalogue {
  const staticPath = bundledCcusageConfigPath()
  let models: CollectorPricingModel[] = []
  try {
    const config = JSON.parse(readFileSync(staticPath, 'utf8')) as unknown
    const overrides = readPricingOverrides(isRecord(config) ? config : {})
    models = Object.entries(overrides).flatMap(([modelId, value]) => {
      const input = finiteNonNegative(value.inputCostPerToken)
      const output = finiteNonNegative(value.outputCostPerToken)
      if (input === null || output === null) return []
      const cacheRead = nullableFiniteNonNegative(value.cacheReadInputTokenCost)
      const cacheWrite = nullableFiniteNonNegative(value.cacheCreationInputTokenCost)
      const contextWindow = isSafeNonNegativeInteger(value.maxInputTokens) ? value.maxInputTokens : 0
      return [
        {
          provider: 'static',
          modelId,
          inputCostPerMillion: input * 1_000_000,
          outputCostPerMillion: output * 1_000_000,
          cacheReadCostPerMillion: cacheRead === null ? null : cacheRead * 1_000_000,
          cacheWriteCostPerMillion: cacheWrite === null ? null : cacheWrite * 1_000_000,
          contextWindow,
          maxInputTokens: contextWindow || null,
          pricing: value
        }
      ]
    })
  } catch {
    models = []
  }
  return {
    models,
    source: 'static',
    endpointOrigin: null,
    fetchedAt: new Date().toISOString(),
    etag: null
  }
}

function bundledCcusageConfigPath() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'ccusage.json')
}

function normalizeCatalogueModel(value: unknown, path: string): CollectorPricingModel {
  const row = asRecord(value, path)
  const provider = requiredString(row.provider, `${path}.provider`)
  if (!providerIdPattern.test(provider)) throw new Error(`Invalid model pricing provider: ${provider}`)
  const modelId = requiredString(row.modelId, `${path}.modelId`)
  if (!modelIdPattern.test(modelId) || controlCharacters.test(modelId)) {
    throw new Error(`Invalid model pricing model id: ${JSON.stringify(modelId)}`)
  }
  const inputCostPerMillion = requiredNonNegativeNumber(row.inputCostPerMillion, `${path}.inputCostPerMillion`)
  const outputCostPerMillion = requiredNonNegativeNumber(row.outputCostPerMillion, `${path}.outputCostPerMillion`)
  const cacheReadCostPerMillion = nullableNonNegativeNumber(
    row.cacheReadCostPerMillion,
    `${path}.cacheReadCostPerMillion`
  )
  const cacheWriteCostPerMillion = nullableNonNegativeNumber(
    row.cacheWriteCostPerMillion,
    `${path}.cacheWriteCostPerMillion`
  )
  const contextWindow = requiredNonNegativeInteger(row.contextWindow, `${path}.contextWindow`)
  const maxInputTokens = nullableNonNegativeInteger(row.maxInputTokens, `${path}.maxInputTokens`)
  let pricing: unknown = row.pricing
  if (pricing === undefined && typeof row.pricingJson === 'string') {
    try {
      pricing = JSON.parse(row.pricingJson) as unknown
    } catch {
      throw new Error(`Invalid model pricing pricingJson for ${provider}/${modelId}`)
    }
  }
  if (!isRecord(pricing)) throw new Error(`Missing model pricing object for ${provider}/${modelId}`)
  validateContextPricing(pricing, `${provider}/${modelId}`)
  return {
    provider,
    modelId,
    inputCostPerMillion,
    outputCostPerMillion,
    cacheReadCostPerMillion,
    cacheWriteCostPerMillion,
    contextWindow,
    maxInputTokens,
    pricing
  }
}

function assertUniqueModels(models: readonly CollectorPricingModel[]) {
  const seen = new Set<string>()
  for (const model of models) {
    const key = `${model.provider}\u0000${model.modelId}`
    if (seen.has(key)) throw new Error(`Duplicate model pricing row: ${key}`)
    seen.add(key)
  }
}

type ContextPricingTier = {
  threshold: number
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
}

function readContextTiers(pricing: Record<string, unknown>): ContextPricingTier[] {
  const candidates: Array<Record<string, unknown>> = []
  if (Array.isArray(pricing.tiers)) {
    for (const value of pricing.tiers) if (isRecord(value)) candidates.push(value)
  }
  const parsedExplicit = candidates
    .map((value) => {
      const tier = isRecord(value.tier) ? value.tier : null
      const type = tier?.type
      const threshold = tier?.size
      if (type !== 'context' || !isSafePositiveInteger(threshold)) return null
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
  if (parsedExplicit.length > 0) return parsedExplicit
  if (!isRecord(pricing.context_over_200k)) return []
  const fallback = parseContextTier({ ...pricing.context_over_200k, tier: { type: 'context', size: 200_000 } })
  return fallback ? [fallback] : []
}

function hasChangingLaterContextTier(tiers: readonly ContextPricingTier[]) {
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

function parseContextTier(value: Record<string, unknown>) {
  const tier = isRecord(value.tier) ? value.tier : null
  const type = tier?.type
  const threshold = tier?.size
  if (type !== 'context' || !isSafePositiveInteger(threshold)) return null
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

function validateContextPricing(pricing: Record<string, unknown>, modelLabel: string) {
  if (pricing.tiers !== undefined) {
    if (!Array.isArray(pricing.tiers)) throw new Error(`Invalid context pricing tiers for ${modelLabel}`)
    for (const [index, value] of pricing.tiers.entries()) {
      if (!isRecord(value)) throw new Error(`Invalid context pricing tier ${modelLabel}[${index}]`)
      const tier = value.tier
      if (tier === undefined) continue
      if (!isRecord(tier)) throw new Error(`Invalid context pricing tier ${modelLabel}[${index}]`)
      if (tier.type !== 'context') continue
      if (!isSafePositiveInteger(tier.size)) {
        throw new Error(`Invalid context pricing threshold for ${modelLabel}[${index}]`)
      }
      for (const key of ['input', 'output']) {
        if (!isFiniteNonNegative(value[key])) {
          throw new Error(`Invalid context pricing ${key} for ${modelLabel}[${index}]`)
        }
      }
      for (const key of ['cache_read', 'cache_write']) {
        if (value[key] !== undefined && value[key] !== null && !isFiniteNonNegative(value[key])) {
          throw new Error(`Invalid context pricing ${key} for ${modelLabel}[${index}]`)
        }
      }
    }
  }
  if (pricing.context_over_200k !== undefined) {
    if (!isRecord(pricing.context_over_200k)) throw new Error(`Invalid context_over_200k pricing for ${modelLabel}`)
    for (const key of ['input', 'output']) {
      if (!isFiniteNonNegative(pricing.context_over_200k[key])) {
        throw new Error(`Invalid context_over_200k ${key} pricing for ${modelLabel}`)
      }
    }
    for (const key of ['cache_read', 'cache_write']) {
      const value = pricing.context_over_200k[key]
      if (value !== undefined && value !== null && !isFiniteNonNegative(value)) {
        throw new Error(`Invalid context_over_200k ${key} pricing for ${modelLabel}`)
      }
    }
  }
  for (const key of ['fastMultiplier', 'fast_multiplier', 'priorityMultiplier', 'priority_multiplier']) {
    const value = pricing[key]
    if (value !== undefined && value !== null && !finitePositive(value)) {
      throw new Error(`Invalid ${key} pricing for ${modelLabel}`)
    }
  }
}

function readMultiplier(pricing: Record<string, unknown>) {
  for (const key of ['fastMultiplier', 'fast_multiplier']) {
    const value = finitePositive(pricing[key])
    if (value !== null) return value
  }
  return null
}

function defaultStateDir() {
  return (
    process.env.TOKENBOARD_STATE_DIR?.trim() ||
    process.env.TOKENBOARD_CONFIG_DIR?.trim() ||
    join(homedir(), '.tokenboard')
  )
}

function asRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`Model pricing ${path} must be an object`)
  return value
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, path: string) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Model pricing ${path} must be a string`)
  return value
}

function requiredTimestamp(value: unknown, path: string) {
  const result = requiredString(value, path)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Model pricing ${path} must be an ISO timestamp`)
  return result
}

function requiredNonNegativeNumber(value: unknown, path: string) {
  const result = finiteNonNegative(value)
  if (result === null) throw new Error(`Model pricing ${path} must be a finite non-negative number`)
  return result
}

function nullableNonNegativeNumber(value: unknown, path: string) {
  if (value === null || value === undefined) return null
  return requiredNonNegativeNumber(value, path)
}

function nullableNonNegativeInteger(value: unknown, path: string) {
  if (value === null || value === undefined) return null
  if (!isSafeNonNegativeInteger(value)) throw new Error(`Model pricing ${path} must be a non-negative integer`)
  return value
}

function requiredNonNegativeInteger(value: unknown, path: string) {
  if (!isSafeNonNegativeInteger(value)) throw new Error(`Model pricing ${path} must be a non-negative integer`)
  return value
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

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0
}

function isFiniteNonNegative(value: unknown): value is number {
  return finiteNonNegative(value) !== null
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error)
}
