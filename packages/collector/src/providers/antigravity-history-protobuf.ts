import { createHash } from 'node:crypto'
import type { AntigravityUsageEvent } from './antigravity-gui-parser'

type ProtoField =
  | { wireType: 0; value: bigint }
  | { wireType: 1; bytes: Uint8Array }
  | { wireType: 2; bytes: Uint8Array }
  | { wireType: 5; bytes: Uint8Array }

type ProtoMessage = Map<number, ProtoField[]>

type ParseBlobOptions = {
  cascadeId: string
  rowIndex: number
  fallbackCreatedAt?: string
}

type AntigravityRawUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  responseId: string
}

class MalformedProtobufError extends Error {}

const maxTokenValue = 1_000_000_000
const maxModelLength = 160
const placeholderModelPrefix = 'MODEL_PLACEHOLDER_'

export function parseAntigravityGeneratorMetadataBlob(
  blob: Uint8Array,
  options: ParseBlobOptions
): AntigravityUsageEvent | null {
  return parseAntigravityGeneratorMetadataBlobEvents(blob, options)[0] ?? null
}

export function parseAntigravityGeneratorMetadataBlobEvents(
  blob: Uint8Array,
  options: ParseBlobOptions
): AntigravityUsageEvent[] {
  const root = parseProtoMessage(blob)
  const chatModel = readMessage(root, 1)
  if (!chatModel) return []
  const usages = readUsages(chatModel)
  if (usages.length === 0) return []
  const createdAt = readCreatedAt(chatModel, options.fallbackCreatedAt)
  const { model, modelAliases } = readModel(chatModel)
  return usages.map((usage) => ({
    cascadeHash: hash(options.cascadeId),
    eventHash: historyEventHash({ root, usage, options, createdAt, model }),
    createdAt,
    model,
    ...(modelAliases.length > 0 ? { modelAliases } : {}),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: usage.cacheReadTokens
  }))
}

function historyEventHash(input: {
  root: ProtoMessage
  usage: AntigravityRawUsage
  options: ParseBlobOptions
  createdAt: string
  model: string
}) {
  return hash(
    JSON.stringify([
      input.options.cascadeId,
      input.options.rowIndex,
      readString(input.root, 4) ?? '',
      input.usage.responseId,
      input.createdAt,
      input.model,
      input.usage.inputTokens,
      input.usage.outputTokens,
      input.usage.cacheReadTokens
    ])
  )
}

function readUsages(chatModel: ProtoMessage) {
  const usages = [
    readUsage(readMessage(chatModel, 4)),
    readUsage(readOptionalNestedUsageMessage(chatModel, [17, 2]))
  ].filter((usage): usage is AntigravityRawUsage => Boolean(usage))
  return dedupeUsages(usages)
}

function readOptionalNestedUsageMessage(message: ProtoMessage, path: number[]) {
  try {
    // Only malformed optional wire data may be ignored; semantic validation errors must propagate.
    return readNestedMessage(message, path)
  } catch (error) {
    if (error instanceof MalformedProtobufError) return null
    throw error
  }
}

function dedupeUsages(usages: AntigravityRawUsage[]) {
  const result: AntigravityRawUsage[] = []
  for (const usage of usages) {
    if (result.some((existing) => sameUsage(existing, usage))) continue
    result.push(usage)
  }
  return result
}

function readUsage(message: ProtoMessage | null): AntigravityRawUsage | null {
  if (!message) return null
  const usage = {
    inputTokens: readOptionalToken(message, 2),
    outputTokens: readOptionalToken(message, 3),
    cacheReadTokens: readOptionalToken(message, 5),
    responseId: readString(message, 11) ?? ''
  }
  if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens === 0) return null
  return usage
}

function readCreatedAt(chatModel: ProtoMessage, fallback: string | undefined) {
  const timestamp = readTimestamp(chatModel)
  if (timestamp) {
    const seconds = readTimestampNumber(timestamp, 1)
    const nanos = readTimestampNumber(timestamp, 2)
    if (seconds === undefined) {
      throw new Error('Invalid Antigravity generator metadata blob: createdAt is invalid')
    }
    if (nanos !== undefined && nanos >= 1_000_000_000) {
      throw new Error('Invalid Antigravity generator metadata blob: createdAt is invalid')
    }
    const date = new Date(seconds * 1000 + Math.trunc((nanos ?? 0) / 1_000_000))
    if (!Number.isFinite(date.getTime())) {
      throw new Error('Invalid Antigravity generator metadata blob: createdAt is invalid')
    }
    return date.toISOString()
  }
  if (fallback && Number.isFinite(Date.parse(fallback))) return fallback
  throw new Error('Invalid Antigravity generator metadata blob: createdAt is required')
}

function readTimestamp(chatModel: ProtoMessage) {
  const startMetadata = readTimestampPathMessage(chatModel, 9)
  return startMetadata ? readTimestampPathMessage(startMetadata, 4) : null
}

function readTimestampPathMessage(message: ProtoMessage, field: number) {
  const fields = message.get(field)
  if (!fields) return null
  const value = fields.find((item): item is Extract<ProtoField, { wireType: 2 }> => item.wireType === 2)
  if (!value) {
    throw new Error('Invalid Antigravity generator metadata blob: createdAt is invalid')
  }
  return parseProtoMessage(value.bytes)
}

function readModel(chatModel: ProtoMessage) {
  const candidates = [readString(chatModel, 19), readString(chatModel, 21)].filter((value): value is string =>
    Boolean(value)
  )
  if (candidates.some((value) => value.length > maxModelLength)) {
    throw new Error('Invalid Antigravity generator metadata blob: model is invalid')
  }
  const model = candidates.find((value) => !value.startsWith(placeholderModelPrefix))
  const fallback = candidates[0]
  if (!model && !fallback) throw new Error('Invalid Antigravity generator metadata blob: model is required')
  const selected = model ?? fallback
  const modelAliases = [
    ...new Set(candidates.filter((value) => value !== selected && !value.startsWith(placeholderModelPrefix)))
  ]
  return { model: selected, modelAliases }
}

function sameUsage(left: AntigravityRawUsage, right: AntigravityRawUsage) {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.responseId === right.responseId
  )
}

function readOptionalToken(message: ProtoMessage, field: number) {
  const value = message.get(field)?.find((item): item is Extract<ProtoField, { wireType: 0 }> => item.wireType === 0)
  if (!value) return 0
  if (value.value > BigInt(maxTokenValue)) {
    throw new Error(`Invalid Antigravity generator metadata blob: token field ${field} is invalid`)
  }
  return Number(value.value)
}

function readTimestampNumber(message: ProtoMessage, field: number) {
  const fields = message.get(field)
  if (!fields) return undefined
  const value = fields.find((item): item is Extract<ProtoField, { wireType: 0 }> => item.wireType === 0)
  if (!value) {
    throw new Error('Invalid Antigravity generator metadata blob: createdAt is invalid')
  }
  if (value.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid Antigravity generator metadata blob: createdAt is invalid')
  }
  return Number(value.value)
}

function readNestedMessage(message: ProtoMessage, path: number[]) {
  return path.reduce<ProtoMessage | null>((current, field) => {
    if (!current) return null
    return readMessage(current, field)
  }, message)
}

function readMessage(message: ProtoMessage, field: number) {
  const bytes = message
    .get(field)
    ?.find((item): item is Extract<ProtoField, { wireType: 2 }> => item.wireType === 2)?.bytes
  if (!bytes) return null
  return parseProtoMessage(bytes)
}

function readString(message: ProtoMessage, field: number) {
  const bytes = message
    .get(field)
    ?.find((item): item is Extract<ProtoField, { wireType: 2 }> => item.wireType === 2)?.bytes
  if (!bytes || !isText(bytes)) return undefined
  return Buffer.from(bytes).toString('utf8')
}

function parseProtoMessage(input: Uint8Array): ProtoMessage {
  const buffer = Buffer.from(input)
  const fields: ProtoMessage = new Map()
  let offset = 0
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset)
    offset = tag.next
    const field = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 7n)
    offset = readField(buffer, offset, field, wireType, fields)
  }
  return fields
}

function readField(buffer: Buffer, offset: number, field: number, wireType: number, fields: ProtoMessage) {
  if (field <= 0) throw new MalformedProtobufError('Invalid protobuf field number')
  if (wireType === 0) {
    const value = readVarint(buffer, offset)
    pushField(fields, field, { wireType, value: value.value })
    return value.next
  }
  if (wireType === 1 || wireType === 5) {
    return readFixedField(buffer, offset, field, wireType, fields)
  }
  if (wireType !== 2) throw new MalformedProtobufError(`Unsupported protobuf wire type: ${wireType}`)
  const length = readVarint(buffer, offset)
  const start = length.next
  const end = start + Number(length.value)
  if (end > buffer.length) throw new MalformedProtobufError('Invalid protobuf length-delimited field')
  pushField(fields, field, { wireType, bytes: buffer.subarray(start, end) })
  return end
}

function readFixedField(buffer: Buffer, offset: number, field: number, wireType: 1 | 5, fields: ProtoMessage) {
  const width = wireType === 1 ? 8 : 4
  const end = offset + width
  if (end > buffer.length) throw new MalformedProtobufError('Invalid protobuf fixed-width field')
  pushField(fields, field, { wireType, bytes: buffer.subarray(offset, end) })
  return end
}

function readVarint(buffer: Buffer, offset: number) {
  let value = 0n
  let shift = 0n
  for (let index = offset; index < buffer.length; index += 1) {
    const byte = buffer[index]
    value |= BigInt(byte & 127) << shift
    if ((byte & 128) === 0) return { value, next: index + 1 }
    shift += 7n
    if (shift > 70n) throw new MalformedProtobufError('Invalid protobuf varint')
  }
  throw new MalformedProtobufError('Truncated protobuf varint')
}

function pushField(fields: ProtoMessage, field: number, value: ProtoField) {
  const values = fields.get(field) ?? []
  values.push(value)
  fields.set(field, values)
}

function isText(bytes: Uint8Array) {
  if (bytes.length === 0) return false
  const text = Buffer.from(bytes).toString('utf8')
  return !text.includes('\uFFFD') && /^[\t\n\r -~]+$/.test(text)
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
