import { modelPricingProviderPattern } from './validation'

export const defaultModelPricingSourceUrl = 'https://models.dev/api.json'
export const maxModelPricingSourceBytes = 8 * 1024 * 1024
export const maxModelPricingEntries = 10_000
export const maxModelPricingValueDepth = 32
export const maxModelPricingValueNodes = 2_048

type JsonRecord = Record<string, unknown>

type ProviderDefinition = {
  id: string
  officialDocsUrl: string
}

export type NormalizedModelPricing = {
  provider: string
  modelId: string
  displayName: string
  inputCostPerMillion: number
  outputCostPerMillion: number
  cacheReadCostPerMillion: number | null
  cacheWriteCostPerMillion: number | null
  contextWindow: number
  maxInputTokens: number | null
  maxOutputTokens: number | null
  releaseDate: string | null
  sourceUpdatedAt: string | null
  officialDocsUrl: string
  pricingJson: string
  isDeprecated: boolean
}

export type ModelPricingSourceSnapshot = {
  sourceUrl: string
  fetchedAt: string
  latestSourceUpdatedAt: string | null
  models: NormalizedModelPricing[]
}

export type PricingFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function fetchModelPricingSource(
  input: {
    sourceUrl?: string
    now?: Date
    fetcher?: PricingFetcher
  } = {}
): Promise<ModelPricingSourceSnapshot> {
  const sourceUrl = validateSourceUrl(input.sourceUrl ?? defaultModelPricingSourceUrl)
  const fetchedAt = (input.now ?? new Date()).toISOString()
  const fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis)
  let response: Response
  try {
    response = await fetcher(sourceUrl, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000)
    })
  } catch (error) {
    if (isAbortError(error)) throw new Error('Model pricing source request timed out')
    throw error
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Model pricing source returned an unexpected redirect HTTP ${response.status}`)
  }
  if (!response.ok) {
    throw new Error(`Model pricing source returned HTTP ${response.status}`)
  }

  let body: string
  try {
    body = await readBoundedBody(response)
  } catch (error) {
    if (isAbortError(error)) throw new Error('Model pricing source request timed out')
    throw error
  }
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch (error) {
    throw new Error(`Model pricing source returned invalid JSON: ${errorMessage(error)}`)
  }

  return normalizeModelsDevPayload(payload, { sourceUrl, fetchedAt })
}

export function normalizeModelsDevPayload(
  payload: unknown,
  input: { sourceUrl?: string; fetchedAt?: string } = {}
): ModelPricingSourceSnapshot {
  const sourceUrl = validateSourceUrl(input.sourceUrl ?? defaultModelPricingSourceUrl)
  const fetchedAt = input.fetchedAt ?? new Date().toISOString()
  assertIsoTimestamp(fetchedAt, 'fetchedAt')
  const root = asRecord(payload, 'root')
  const models: NormalizedModelPricing[] = []

  for (const [providerId, value] of Object.entries(root)) {
    const definition = normalizeProviderDefinition(providerId, value)
    const provider = asRecord(value, `provider ${providerId}`)
    const providerModels = asRecord(provider.models, `provider ${providerId}.models`)
    for (const [modelKey, value] of Object.entries(providerModels)) {
      const model = asRecord(value, `model ${definition.id}/${modelKey}`)
      const normalized = normalizeModel(definition, modelKey, model)
      if (!normalized) continue
      models.push(normalized)
    }
  }

  if (models.length === 0) {
    throw new Error('Model pricing source did not contain any models with numeric input and output prices')
  }
  if (models.length > maxModelPricingEntries) {
    throw new Error(
      `Model pricing source returned ${models.length} models; refusing more than ${maxModelPricingEntries}`
    )
  }

  const latestSourceUpdatedAt = latestDate(models.map((model) => model.sourceUpdatedAt))
  return {
    sourceUrl,
    fetchedAt,
    latestSourceUpdatedAt,
    models: models.sort(
      (left, right) => left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId)
    )
  }
}

function normalizeProviderDefinition(providerId: string, value: unknown): ProviderDefinition {
  if (!modelPricingProviderPattern.test(providerId)) {
    throw new Error(`Model pricing source returned an invalid provider id: ${providerId}`)
  }
  const provider = asRecord(value, `provider ${providerId}`)
  if (typeof provider.doc !== 'string' || provider.doc.trim().length === 0) {
    throw new Error(`Model pricing source is missing official docs URL for provider ${providerId}`)
  }
  return {
    id: providerId,
    officialDocsUrl: validateOfficialDocsUrl(providerId, provider.doc)
  }
}

function normalizeModel(
  definition: ProviderDefinition,
  modelKey: string,
  model: JsonRecord
): NormalizedModelPricing | null {
  if (modelKey.length === 0 || modelKey.length > 512 || hasUnsafeModelTextCharacters(modelKey)) {
    throw new Error(`Model pricing source returned an invalid model id: ${definition.id}/${JSON.stringify(modelKey)}`)
  }
  if (typeof model.id === 'string' && model.id !== modelKey) {
    throw new Error(`Model pricing source model id mismatch: ${definition.id}/${modelKey}`)
  }

  if (model.cost === undefined || model.cost === null) return null
  const cost = asRecord(model.cost, `model ${definition.id}/${modelKey}.cost`)
  const inputCost = readOptionalNonNegativeNumber(cost.input, `${definition.id}/${modelKey}.cost.input`)
  const outputCost = readOptionalNonNegativeNumber(cost.output, `${definition.id}/${modelKey}.cost.output`)
  if (inputCost === null || outputCost === null) return null
  const limit =
    model.limit === undefined || model.limit === null
      ? {}
      : asRecord(model.limit, `model ${definition.id}/${modelKey}.limit`)
  // D1 keeps this field non-null for compatibility; zero means the upstream
  // does not publish a context limit (it is never treated as billable usage).
  const contextWindow = readOptionalNonNegativeInteger(limit.context, `${definition.id}/${modelKey}.limit.context`) ?? 0
  const maxInputTokens = readOptionalNonNegativeInteger(limit.input, `${definition.id}/${modelKey}.limit.input`)
  const maxOutputTokens = readOptionalNonNegativeInteger(limit.output, `${definition.id}/${modelKey}.limit.output`)
  const displayName = readDisplayName(model.name, modelKey)
  const sourceUpdatedAt = readOptionalDate(model.last_updated, `${definition.id}/${modelKey}.last_updated`)
  const releaseDate = readOptionalDate(model.release_date, `${definition.id}/${modelKey}.release_date`)
  const pricing = normalizePricingObject(cost, `${definition.id}/${modelKey}.cost`)
  const officialDocsUrl = definition.officialDocsUrl

  return {
    provider: definition.id,
    modelId: modelKey,
    displayName,
    inputCostPerMillion: inputCost,
    outputCostPerMillion: outputCost,
    cacheReadCostPerMillion: readOptionalNonNegativeNumber(
      cost.cache_read,
      `${definition.id}/${modelKey}.cost.cache_read`
    ),
    cacheWriteCostPerMillion: readOptionalNonNegativeNumber(
      cost.cache_write,
      `${definition.id}/${modelKey}.cost.cache_write`
    ),
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    releaseDate,
    sourceUpdatedAt,
    officialDocsUrl,
    pricingJson: JSON.stringify(pricing),
    isDeprecated: model.status === 'deprecated'
  }
}

function hasUnsafeModelTextCharacters(value: string) {
  // Reject control, format, and surrogate code points. This covers zero-width
  // characters and bidirectional overrides that can hide or reorder an ID.
  return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
}

function normalizePricingObject(value: JsonRecord, path: string): JsonRecord {
  const result: JsonRecord = {}
  const budget = { nodes: 0 }
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      throw new Error(`Model pricing source returned an invalid price field: ${path}.${key}`)
    }
    result[key] = normalizePricingValue(entry, `${path}.${key}`, budget, 1)
  }
  const serialized = JSON.stringify(result)
  if (serialized.length > 8192) {
    throw new Error(`Model pricing source price object is too large: ${path}`)
  }
  return result
}

function normalizePricingValue(value: unknown, path: string, budget: { nodes: number }, depth: number): unknown {
  if (depth > maxModelPricingValueDepth) {
    throw new Error(`Model pricing source price object is too deeply nested: ${path}`)
  }
  budget.nodes += 1
  if (budget.nodes > maxModelPricingValueNodes) {
    throw new Error(`Model pricing source price object has too many values: ${path}`)
  }
  if (typeof value === 'number') return readNonNegativeNumber(value, path)
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value))
    return value.map((entry, index) => normalizePricingValue(entry, `${path}[${index}]`, budget, depth + 1))
  if (isRecord(value)) {
    const result: JsonRecord = {}
    for (const [key, entry] of Object.entries(value)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
        throw new Error(`Model pricing source returned an invalid nested price field: ${path}.${key}`)
      }
      result[key] = normalizePricingValue(entry, `${path}.${key}`, budget, depth + 1)
    }
    return result
  }
  throw new Error(`Model pricing source returned an unsupported price value: ${path}`)
}

function validateSourceUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Model pricing source URL must be a valid URL')
  }
  if (
    hasExplicitDefaultHttpsPort(value) ||
    url.protocol !== 'https:' ||
    url.hostname !== 'models.dev' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/api.json' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Model pricing source URL must be https://models.dev/api.json')
  }
  return url.toString()
}

function hasExplicitDefaultHttpsPort(value: string) {
  return /^https:\/\/(?:[^/?#@]+@)?models\.dev:0*443(?:[/?#]|$)/i.test(value)
}

function validateOfficialDocsUrl(providerId: string, value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error(`Model pricing source returned an invalid official docs URL for ${providerId}`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Model pricing source returned an invalid official docs URL for ${providerId}`)
  }
  const hostname = url.hostname.toLowerCase()
  const unbracketedHostname = hostname.replace(/^\[|\]$/g, '')
  const hostnameForValidation = unbracketedHostname.replace(/\.+$/, '')
  const parsedIpv6 = parseIpv6(hostnameForValidation)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    hostnameForValidation === 'localhost' ||
    hostnameForValidation.includes('%') ||
    hostnameForValidation === '::' ||
    hostnameForValidation === '::1' ||
    /^127(?:\.|$)/.test(hostnameForValidation) ||
    isPrivateIpv4(hostnameForValidation) ||
    isUnsafeIpv6(parsedIpv6) ||
    hostnameForValidation.endsWith('.local')
  ) {
    throw new Error(`Model pricing source returned an unsafe official docs URL for ${providerId}`)
  }
  return url.toString()
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [first, second] = parts
  return (
    first === 0 ||
    first === 127 ||
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254) ||
    (first === 100 && second >= 64 && second <= 127)
  )
}

function parseIpv6(value: string): number[] | null {
  if (!value.includes(':') || value.includes('%')) return null
  let address = value.toLowerCase()
  if (address.includes('.')) {
    const separator = address.lastIndexOf(':')
    if (separator < 0) return null
    const ipv4 = address.slice(separator + 1)
    const parts = ipv4.split('.').map((part) => Number(part))
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
    const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0)
    const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)
    address = `${address.slice(0, separator + 1)}${high.toString(16)}:${low.toString(16)}`
  }

  const sections = address.split('::')
  if (sections.length > 2) return null
  const left = sections[0] ? sections[0].split(':') : []
  const right = sections.length === 2 && sections[1] ? sections[1].split(':') : []
  const parseSection = (section: string) => {
    if (!/^[0-9a-f]{1,4}$/.test(section)) return null
    return Number.parseInt(section, 16)
  }
  const leftValues = left.map(parseSection)
  const rightValues = right.map(parseSection)
  if (leftValues.some((part) => part === null) || rightValues.some((part) => part === null)) return null
  const missing = 8 - left.length - right.length
  if (sections.length === 2 && missing <= 0) return null
  const values = [
    ...(leftValues as number[]),
    ...(sections.length === 2 ? Array.from({ length: missing }, () => 0) : []),
    ...(rightValues as number[])
  ]
  return values.length === 8 ? values : null
}

function isUnsafeIpv6(segments: number[] | null) {
  if (!segments) return false
  const first = segments[0] ?? 0
  const isUnspecified = segments.every((segment) => segment === 0)
  const isLoopback = segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1
  const isUniqueLocal = (first & 0xfe00) === 0xfc00
  const isLinkLocal = (first & 0xffc0) === 0xfe80
  const embeddedIpv4 = ipv4FromUnsafeIpv6(segments)
  return (
    isUnspecified ||
    isLoopback ||
    isUniqueLocal ||
    isLinkLocal ||
    (embeddedIpv4 !== null && isPrivateIpv4(embeddedIpv4))
  )
}

function ipv4FromUnsafeIpv6(segments: number[]) {
  if (isIpv4MappedOrCompatible(segments)) return ipv4FromIpv6(segments)
  if (segments[0] === 0x2002) {
    const second = segments[1] ?? 0
    const third = segments[2] ?? 0
    return `${second >> 8}.${second & 0xff}.${third >> 8}.${third & 0xff}`
  }
  return null
}

function isIpv4MappedOrCompatible(segments: number[]) {
  const prefixLength = segments[5] === 0xffff ? 5 : 6
  return segments.slice(0, prefixLength).every((segment) => segment === 0)
}

function ipv4FromIpv6(segments: number[]) {
  const high = segments[6] ?? 0
  const low = segments[7] ?? 0
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

function asRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`Model pricing source is missing object: ${path}`)
  return value
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readDisplayName(value: unknown, fallback: string) {
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    throw new Error(`Model pricing source returned an invalid model name: ${fallback}`)
  }
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 200 || hasUnsafeModelTextCharacters(normalized)) {
    throw new Error(`Model pricing source returned an invalid model name: ${fallback}`)
  }
  return normalized
}

function readNonNegativeNumber(value: unknown, path: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Model pricing source returned an invalid number: ${path}`)
  }
  return value
}

function readOptionalNonNegativeNumber(value: unknown, path: string) {
  if (value === undefined || value === null) return null
  return readNonNegativeNumber(value, path)
}

function readOptionalNonNegativeInteger(value: unknown, path: string) {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Model pricing source returned an invalid integer: ${path}`)
  }
  return value as number
}

function readOptionalDate(value: unknown, path: string) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !isValidSourceDate(value) || Number.isNaN(sourceDateSortValue(value))) {
    throw new Error(`Model pricing source returned an invalid date: ${path}`)
  }
  return value
}

function assertIsoTimestamp(value: string, path: string) {
  if (!isValidCalendarDate(value) || Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${path} timestamp`)
}

function isValidCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false

  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function isValidSourceDate(value: string) {
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split('-').map(Number)
    return year >= 1 && month >= 1 && month <= 12
  }
  return isValidCalendarDate(value)
}

function latestDate(values: Array<string | null>) {
  const valid = values.filter((value): value is string => Boolean(value))
  if (valid.length === 0) return null
  return [...valid].sort((left, right) => sourceDateSortValue(right) - sourceDateSortValue(left))[0] ?? null
}

function sourceDateSortValue(value: string) {
  if (/^\d{4}-\d{2}$/.test(value)) return Date.parse(`${value}-01T00:00:00.000Z`)
  return Date.parse(value)
}

async function readBoundedBody(response: Response) {
  if (!response.body) {
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null) {
      const declaredLength = Number(contentLength)
      if (Number.isFinite(declaredLength) && declaredLength > maxModelPricingSourceBytes) {
        throw new Error(`Model pricing source response exceeds ${maxModelPricingSourceBytes} bytes`)
      }
    }
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxModelPricingSourceBytes) {
      throw new Error(`Model pricing source response exceeds ${maxModelPricingSourceBytes} bytes`)
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxModelPricingSourceBytes) {
        const sizeError = new Error(`Model pricing source response exceeds ${maxModelPricingSourceBytes} bytes`)
        try {
          await reader.cancel('response too large')
        } catch (error) {
          ;(sizeError as Error & { cause?: unknown }).cause = error
        }
        throw sizeError
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(output)
  } catch (error) {
    throw new Error(`Model pricing source returned invalid UTF-8: ${errorMessage(error)}`, { cause: error })
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? error.name : undefined
  return name === 'AbortError' || name === 'TimeoutError'
}
