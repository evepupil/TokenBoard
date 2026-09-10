import type { UsageSource } from '@tokenboard/usage-core'

type MetadataScope =
  | 'root'
  | 'root-message'
  | 'root-payload'
  | 'root-payload-metadata'
  | 'root-payload-info'
  | 'claude-usage'
  | 'codex-usage'
  | 'other'

type JsonContainer = {
  canClose: boolean
  kind: 'array' | 'object'
  scope: MetadataScope
  phase: 'colon' | 'comma' | 'key' | 'scalar' | 'value'
  currentKey?: string
  scalar?: string
}

type JsonString = {
  capture: boolean
  container?: JsonContainer
  escapeRemaining: number
  key?: string
  raw: number[]
  role: 'key' | 'value'
  truncated: boolean
  utf8ContinuationCount: number
  utf8FirstContinuationMax?: number
  utf8FirstContinuationMin?: number
}

export type SessionJsonlMetadataScanner = {
  additionalRelevantKey: boolean
  additionalRelevantKeys: ReadonlySet<string>
  claudeUsageObject: boolean
  codexTokenMetricKey: boolean
  codexUsageObject: boolean
  invalid: boolean
  rootFinished: boolean
  rootType?: string
  turnContextModel?: string
  turnContextModelIsPrimary: boolean
  stack: JsonContainer[]
  string?: JsonString
}

export type SessionJsonlMetadataRecord = {
  type: 'turn_context'
  payload: {
    model: string
  }
}

const maxCapturedJsonStringBytes = 256
const maxJsonNesting = 128
const tokenMetricKeys = new Set([
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cacheCreationInputTokens',
  'cacheCreationTokens',
  'cacheReadInputTokens',
  'cacheReadTokens',
  'cached_input_tokens',
  'cachedInputTokens',
  'input_tokens',
  'inputTokens',
  'output_tokens',
  'outputTokens',
  'total_tokens',
  'totalTokens'
])

export function createSessionJsonlMetadataScanner(
  input: {
    additionalRelevantKeys?: readonly string[]
  } = {}
): SessionJsonlMetadataScanner {
  return {
    additionalRelevantKey: false,
    additionalRelevantKeys: new Set(input.additionalRelevantKeys ?? []),
    claudeUsageObject: false,
    codexTokenMetricKey: false,
    codexUsageObject: false,
    invalid: false,
    rootFinished: false,
    turnContextModelIsPrimary: false,
    stack: []
  }
}

export function scanSessionJsonlMetadata(
  segments: readonly Buffer[],
  scanner: SessionJsonlMetadataScanner,
  source?: UsageSource
) {
  for (const segment of segments) {
    for (const byte of segment) {
      scanJsonByte(byte, scanner)
      if (scanner.invalid || hasRelevantSessionJsonlMetadata(scanner, source)) return
    }
  }
}

export function hasRelevantSessionJsonlMetadata(scanner: SessionJsonlMetadataScanner, source?: UsageSource) {
  if (scanner.additionalRelevantKey) return true
  const claudeRelevant = scanner.claudeUsageObject
  const codexRelevant = scanner.codexUsageObject || scanner.codexTokenMetricKey
  if (source === 'claude-code') return claudeRelevant
  if (source === 'codex') return codexRelevant
  return claudeRelevant || codexRelevant
}

export function readSessionJsonlRecordType(scanner: SessionJsonlMetadataScanner) {
  return scanner.rootType
}

// Oversized turn_context rows are never buffered or parsed as a whole. This
// bounded projection retains only the model needed by following token rows.
export function readSessionJsonlMetadataRecord(
  scanner: SessionJsonlMetadataScanner
): SessionJsonlMetadataRecord | null {
  if (scanner.invalid || !scanner.rootFinished || scanner.rootType !== 'turn_context' || !scanner.turnContextModel)
    return null
  return {
    type: 'turn_context',
    payload: { model: scanner.turnContextModel }
  }
}

function scanJsonByte(byte: number, scanner: SessionJsonlMetadataScanner) {
  if (scanner.invalid || scanner.rootFinished) {
    if (!isJsonWhitespace(byte)) scanner.invalid = true
    return
  }
  if (scanner.string) {
    scanJsonStringByte(byte, scanner)
    return
  }
  if (isJsonWhitespace(byte)) return

  const container = scanner.stack.at(-1)
  if (!container) {
    if (byte === 0x7b) {
      pushContainer(scanner, newObjectContainer('root'))
      return
    }
    scanner.invalid = true
    return
  }
  if (container.kind === 'object') {
    scanObjectByte(byte, scanner, container)
    return
  }
  scanArrayByte(byte, scanner, container)
}

function scanObjectByte(byte: number, scanner: SessionJsonlMetadataScanner, container: JsonContainer) {
  if (container.phase === 'key') {
    if (byte === 0x7d) {
      if (!container.canClose) {
        scanner.invalid = true
        return
      }
      closeContainer(scanner, 'object')
      return
    }
    if (byte === 0x22) {
      scanner.string = newJsonString('key', container)
      return
    }
    scanner.invalid = true
    return
  }
  if (container.phase === 'colon') {
    if (byte === 0x3a) {
      container.phase = 'value'
      return
    }
    scanner.invalid = true
    return
  }
  if (container.phase === 'value') {
    startJsonValue(byte, scanner, container)
    return
  }
  if (container.phase === 'scalar') {
    finishScalarByte(byte, scanner, container, 'object')
    return
  }
  if (byte === 0x2c) {
    container.phase = 'key'
    container.canClose = false
    return
  }
  if (byte === 0x7d) {
    closeContainer(scanner, 'object')
    return
  }
  scanner.invalid = true
}

function scanArrayByte(byte: number, scanner: SessionJsonlMetadataScanner, container: JsonContainer) {
  if (container.phase === 'value') {
    if (byte === 0x5d) {
      if (!container.canClose) {
        scanner.invalid = true
        return
      }
      closeContainer(scanner, 'array')
      return
    }
    startJsonValue(byte, scanner, container)
    return
  }
  if (container.phase === 'scalar') {
    finishScalarByte(byte, scanner, container, 'array')
    return
  }
  if (byte === 0x2c) {
    container.phase = 'value'
    container.canClose = false
    return
  }
  if (byte === 0x5d) {
    closeContainer(scanner, 'array')
    return
  }
  scanner.invalid = true
}

function startJsonValue(byte: number, scanner: SessionJsonlMetadataScanner, container: JsonContainer) {
  if (byte === 0x7b) {
    const scope = childScope(container, 'object')
    recordUsageObject(scanner, scope)
    pushContainer(scanner, newObjectContainer(scope))
    return
  }
  if (byte === 0x5b) {
    pushContainer(scanner, newArrayContainer(childScope(container, 'array')))
    return
  }
  if (byte === 0x22) {
    scanner.string = newJsonString('value', container)
    return
  }
  if (isJsonScalarStart(byte)) {
    container.phase = 'scalar'
    container.scalar = String.fromCharCode(byte)
    return
  }
  scanner.invalid = true
}

function finishScalarByte(
  byte: number,
  scanner: SessionJsonlMetadataScanner,
  container: JsonContainer,
  kind: JsonContainer['kind']
) {
  if (isJsonWhitespace(byte)) {
    finishScalar(container, scanner)
    return
  }
  if (byte === 0x2c) {
    finishScalar(container, scanner)
    finishContainerValue(container)
    container.phase = kind === 'object' ? 'key' : 'value'
    container.canClose = false
    return
  }
  const closingByte = kind === 'object' ? 0x7d : 0x5d
  if (byte === closingByte) {
    finishScalar(container, scanner)
    closeContainer(scanner, kind)
    return
  }
  if ((container.scalar?.length ?? 0) >= maxJsonScalarBytes) {
    scanner.invalid = true
    return
  }
  container.scalar = `${container.scalar ?? ''}${String.fromCharCode(byte)}`
}

function scanJsonStringByte(byte: number, scanner: SessionJsonlMetadataScanner) {
  const string = scanner.string
  if (!string) return
  if (string.utf8ContinuationCount > 0) {
    if (
      !isUtf8ContinuationByte(byte) ||
      (string.utf8FirstContinuationMin !== undefined && byte < string.utf8FirstContinuationMin) ||
      (string.utf8FirstContinuationMax !== undefined && byte > string.utf8FirstContinuationMax)
    ) {
      scanner.invalid = true
      return
    }
    captureJsonStringByte(byte, string)
    string.utf8ContinuationCount -= 1
    string.utf8FirstContinuationMin = undefined
    string.utf8FirstContinuationMax = undefined
    return
  }
  if (string.escapeRemaining > 0) {
    if (!isHexDigit(byte)) {
      scanner.invalid = true
      return
    }
    captureJsonStringByte(byte, string)
    string.escapeRemaining -= 1
    return
  }
  if (string.escapeRemaining === -1) {
    if (byte === 0x75) {
      captureJsonStringByte(byte, string)
      string.escapeRemaining = 4
      return
    }
    if (!isSimpleJsonEscape(byte)) {
      scanner.invalid = true
      return
    }
    captureJsonStringByte(byte, string)
    string.escapeRemaining = 0
    return
  }
  if (byte === 0x5c) {
    captureJsonStringByte(byte, string)
    string.escapeRemaining = -1
    return
  }
  if (byte !== 0x22) {
    if (byte < 0x20) {
      scanner.invalid = true
      return
    }
    if (byte >= 0x80) {
      if (!startUtf8Sequence(byte, string)) {
        scanner.invalid = true
        return
      }
    }
    captureJsonStringByte(byte, string)
    return
  }

  scanner.string = undefined
  const value = readCapturedJsonString(string)
  if (string.role === 'key') {
    if (!string.container) {
      scanner.invalid = true
      return
    }
    if (value === undefined) {
      if (!string.truncated) scanner.invalid = true
      string.container.currentKey = undefined
      string.container.phase = 'colon'
      return
    }
    string.container.currentKey = value
    string.container.phase = 'colon'
    if (string.container.scope === 'root' && value === 'type') scanner.rootType = undefined
    if (tokenMetricKeys.has(value)) scanner.codexTokenMetricKey = true
    if (scanner.additionalRelevantKeys.has(value)) scanner.additionalRelevantKey = true
    return
  }
  if (string.container) {
    recordJsonStringValue(scanner, string.container.scope, string.key, value)
    finishContainerValue(string.container)
  }
}

function closeContainer(scanner: SessionJsonlMetadataScanner, kind: JsonContainer['kind']) {
  const container = scanner.stack.at(-1)
  if (!container || container.kind !== kind) {
    scanner.invalid = true
    return
  }
  scanner.stack.pop()
  const parent = scanner.stack.at(-1)
  if (parent) {
    finishContainerValue(parent)
  } else {
    scanner.rootFinished = true
  }
}

export function finishSessionJsonlMetadataScan(scanner: SessionJsonlMetadataScanner) {
  if (scanner.invalid) return false
  if (scanner.string || scanner.stack.length > 0 || !scanner.rootFinished) return false
  return true
}

function finishContainerValue(container: JsonContainer) {
  container.canClose = true
  container.currentKey = undefined
  container.scalar = undefined
  container.phase = 'comma'
}

function finishScalar(container: JsonContainer, scanner: SessionJsonlMetadataScanner) {
  const value = container.scalar
  if (!value || !isValidJsonScalar(value)) {
    scanner.invalid = true
    return
  }
  container.scalar = undefined
  container.phase = 'comma'
}

function newObjectContainer(scope: MetadataScope): JsonContainer {
  return { canClose: true, kind: 'object', scope, phase: 'key' }
}

function newArrayContainer(scope: MetadataScope): JsonContainer {
  return { canClose: true, kind: 'array', scope, phase: 'value' }
}

function pushContainer(scanner: SessionJsonlMetadataScanner, container: JsonContainer) {
  if (scanner.stack.length >= maxJsonNesting) {
    scanner.invalid = true
    return
  }
  scanner.stack.push(container)
}

function newJsonString(role: JsonString['role'], container?: JsonContainer): JsonString {
  const key = role === 'value' && container?.kind === 'object' ? container.currentKey : undefined
  return {
    capture: role === 'key' || shouldCaptureValue(container?.scope, key),
    container,
    escapeRemaining: 0,
    key,
    raw: [],
    role,
    truncated: false,
    utf8ContinuationCount: 0
  }
}

function shouldCaptureValue(scope: MetadataScope | undefined, key: string | undefined) {
  return (
    (key === 'type' && scope === 'root') ||
    (scope !== undefined && isTurnContextModelScope(scope) && isTurnContextModelKey(key))
  )
}

function childScope(container: JsonContainer, kind: JsonContainer['kind']): MetadataScope {
  if (container.scope === 'claude-usage' || container.scope === 'codex-usage') {
    return container.scope
  }
  if (kind !== 'object') return 'other'
  if (container.scope === 'root' && container.currentKey === 'message') return 'root-message'
  if (container.scope === 'root' && container.currentKey === 'payload') return 'root-payload'
  if (container.scope === 'root' && container.currentKey === 'usage') return 'claude-usage'
  if (container.scope === 'root-message' && container.currentKey === 'usage') return 'claude-usage'
  if (container.scope === 'root-payload' && container.currentKey === 'info') return 'root-payload-info'
  if (container.scope === 'root-payload' && container.currentKey === 'metadata') return 'root-payload-metadata'
  if (container.scope === 'root-payload' && container.currentKey === 'usage') return 'codex-usage'
  if (container.scope === 'root-payload-info' && container.currentKey === 'last_token_usage') return 'codex-usage'
  return 'other'
}

function recordUsageObject(scanner: SessionJsonlMetadataScanner, scope: MetadataScope) {
  if (scope === 'claude-usage') scanner.claudeUsageObject = true
  if (scope === 'codex-usage') scanner.codexUsageObject = true
}

function recordJsonStringValue(
  scanner: SessionJsonlMetadataScanner,
  scope: MetadataScope,
  key: string | undefined,
  value: string | undefined
) {
  if (value === undefined) return
  if (key === 'type' && scope === 'root') {
    scanner.rootType = value
    return
  }
  if (isTurnContextModelScope(scope) && isTurnContextModelKey(key)) {
    const isPrimary = scope === 'root-payload' && key === 'model'
    if (isPrimary || (!scanner.turnContextModelIsPrimary && scanner.turnContextModel === undefined)) {
      scanner.turnContextModel = value
      scanner.turnContextModelIsPrimary = isPrimary
    }
  }
}

function isTurnContextModelScope(scope: MetadataScope) {
  return scope === 'root-payload' || scope === 'root-payload-info' || scope === 'root-payload-metadata'
}

function isTurnContextModelKey(key: string | undefined) {
  return key === 'model' || key === 'model_name' || key === 'modelName'
}

function captureJsonStringByte(byte: number, string: JsonString) {
  if (!string.capture || string.truncated) return
  if (string.raw.length >= maxCapturedJsonStringBytes) {
    string.truncated = true
    string.raw = []
    return
  }
  string.raw.push(byte)
}

function readCapturedJsonString(string: JsonString) {
  if (!string.capture || string.truncated) return undefined
  try {
    const value = JSON.parse(`"${Buffer.from(string.raw).toString('utf8')}"`)
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function isJsonScalarStart(byte: number) {
  return byte === 0x2d || (byte >= 0x30 && byte <= 0x39) || byte === 0x66 || byte === 0x6e || byte === 0x74
}

function isValidJsonScalar(value: string) {
  if (value === 'true' || value === 'false' || value === 'null') return true
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
}

function isSimpleJsonEscape(byte: number) {
  return (
    byte === 0x22 ||
    byte === 0x2f ||
    byte === 0x5c ||
    byte === 0x62 ||
    byte === 0x66 ||
    byte === 0x6e ||
    byte === 0x72 ||
    byte === 0x74
  )
}

function isHexDigit(byte: number) {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66)
}

function startUtf8Sequence(byte: number, string: JsonString) {
  if (byte >= 0xc2 && byte <= 0xdf) {
    string.utf8ContinuationCount = 1
    return true
  }
  if (byte === 0xe0) {
    string.utf8ContinuationCount = 2
    string.utf8FirstContinuationMin = 0xa0
    return true
  }
  if ((byte >= 0xe1 && byte <= 0xec) || (byte >= 0xee && byte <= 0xef)) {
    string.utf8ContinuationCount = 2
    return true
  }
  if (byte === 0xed) {
    string.utf8ContinuationCount = 2
    string.utf8FirstContinuationMax = 0x9f
    return true
  }
  if (byte === 0xf0) {
    string.utf8ContinuationCount = 3
    string.utf8FirstContinuationMin = 0x90
    return true
  }
  if (byte >= 0xf1 && byte <= 0xf3) {
    string.utf8ContinuationCount = 3
    return true
  }
  if (byte === 0xf4) {
    string.utf8ContinuationCount = 3
    string.utf8FirstContinuationMax = 0x8f
    return true
  }
  return false
}

function isUtf8ContinuationByte(byte: number) {
  return byte >= 0x80 && byte <= 0xbf
}

function isJsonWhitespace(byte: number) {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20
}

const maxJsonScalarBytes = 128
