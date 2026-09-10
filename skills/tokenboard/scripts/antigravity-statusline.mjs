#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendBoundedStatuslineError, appendBoundedStatuslineEvent } from './antigravity-statusline-log.mjs'
import { startOriginalStatuslineCommand } from './antigravity-statusline-original.mjs'
import { errorMessage } from './error-message.mjs'

const defaultMaxInputBytes = 256 * 1024
const maxTokenValue = 1_000_000_000
const maxModelLength = 160
const maxUpstreamEventIdentifierLength = 4096
const schemaVersion = 'antigravity-statusline/v1'
const defaultMaxLogBytes = 8 * 1024 * 1024
const minMaxLogBytes = 1024
const maxMaxLogBytes = 64 * 1024 * 1024
const upstreamEventIdentifierFields = [
  'event_id',
  'eventId',
  'inference_request_id',
  'inferenceRequestId',
  'response_id',
  'responseId',
  'provider_assigned_message_id',
  'providerAssignedMessageId',
  'message_id',
  'messageId'
]

export async function runStatuslineCli(argv = process.argv.slice(2), env = process.env) {
  const options = readOptions(argv, env)
  let original = null
  try {
    original = startOriginalStatuslineCommand({
      originalCommandFile: options.originalCommandFile,
      selfPath: options.selfPath
    })
  } catch (error) {
    recordStatuslineError(options.errorPath, 'original', error, options.maxLogBytes)
  }

  let input
  try {
    input = await readStdin(options.maxInputBytes, original)
    if (input.captureError) throw input.captureError
    if (input.tooLarge) throw new Error('Antigravity statusline payload too large')
    const event = extractStatuslineEvent(input.raw, new Date().toISOString(), randomBytes(16).toString('hex'))
    if (event) {
      appendBoundedStatuslineEvent(options.logPath, event, options.maxLogBytes)
    }
  } catch (error) {
    recordStatuslineError(options.errorPath, 'capture', error, options.maxLogBytes)
  } finally {
    original?.finishInput()
  }

  if (original) {
    const result = await original.completion
    const originalError = result.error ?? input?.forwardError
    if (originalError) {
      recordStatuslineError(options.errorPath, 'original', originalError, options.maxLogBytes)
    }
    if (result.output) {
      process.stdout.write(result.output)
    }
  }
}

export function extractStatuslineEvent(raw, capturedAt, captureId) {
  const payload = parsePayload(raw)
  const contextWindow = readObject(payload.context_window)
  const usage = readObject(contextWindow.current_usage)
  const conversationId = readBoundedString(payload.conversation_id, 4096, 'conversation_id')
  const conversationHash = hashLegacyIdentifier(conversationId)
  const conversationHashAliases = hashIdentifier(conversationId)
  const statuslineEventHash = readStatuslineEventHash(payload)
  const model = readModel(payload.model)
  const inputTokens = readToken(usage.input_tokens, 'input_tokens')
  const outputTokens = readToken(usage.output_tokens, 'output_tokens')
  const cacheCreationTokens = readToken(usage.cache_creation_input_tokens, 'cache_creation_input_tokens') ?? 0
  const cacheReadTokens = readToken(usage.cache_read_input_tokens, 'cache_read_input_tokens') ?? 0

  if (!conversationHash || !model) return null
  if ([inputTokens, outputTokens].some((value) => value === null)) return null
  if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0) return null

  return {
    schemaVersion,
    capturedAt,
    ...(captureId ? { captureId } : {}),
    conversationHash,
    conversationHashAliases:
      conversationHashAliases && conversationHashAliases !== conversationHash ? [conversationHashAliases] : undefined,
    ...(statuslineEventHash ? { statuslineEventHash } : {}),
    model,
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens
    }
  }
}

export function readOptions(argv, env = process.env) {
  const flags = readFlags(argv)
  const stateDir = flags['state-dir'] || env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR
  if (!stateDir) {
    throw new Error('Missing --state-dir for Antigravity statusline handler')
  }
  const logPath =
    flags['log-path'] || env.TOKENBOARD_ANTIGRAVITY_STATUSLINE_LOG || `${stateDir}/antigravity-cli-statusline.jsonl`
  const errorPath = flags['error-path'] || `${stateDir}/antigravity-statusline-errors.log`
  const originalCommandFile = flags['original-command-file'] || `${stateDir}/antigravity_statusline_original.json`
  return {
    stateDir,
    logPath,
    errorPath,
    originalCommandFile,
    maxInputBytes: Number(Object.hasOwn(flags, 'max-input-bytes') ? flags['max-input-bytes'] : defaultMaxInputBytes),
    maxLogBytes: readMaxLogBytes(flags['max-log-bytes'] || env.TOKENBOARD_ANTIGRAVITY_STATUSLINE_MAX_BYTES),
    selfPath: resolve(fileURLToPath(import.meta.url))
  }
}

function parsePayload(raw) {
  let payload
  try {
    payload = JSON.parse(raw || '{}')
  } catch (error) {
    throw new Error('Malformed Antigravity statusline payload', { cause: error })
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid Antigravity statusline payload: expected object')
  }
  return payload
}

async function readStdin(maxBytes, original) {
  const captureError =
    !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > defaultMaxInputBytes
      ? new Error('Invalid Antigravity statusline input limit')
      : undefined
  const captured = captureError ? null : Buffer.alloc(maxBytes)
  let total = 0
  let tooLarge = false
  let forwardError
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (!captureError && !tooLarge) {
      total += chunk.length
      if (total > maxBytes) {
        tooLarge = true
        captured.fill(0)
      } else {
        chunk.copy(captured, total - chunk.length)
      }
    }
    if (original && !forwardError) {
      try {
        await original.writeInput(chunk)
      } catch (error) {
        forwardError = error
      }
    }
  }
  return {
    raw: tooLarge || !captured ? '' : captured.subarray(0, total).toString('utf8'),
    tooLarge,
    captureError,
    forwardError
  }
}

function readModel(value) {
  if (typeof value === 'string') return readBoundedString(value, maxModelLength, 'model')
  const model = readObject(value)
  return (
    readBoundedString(model.display_name, maxModelLength, 'model.display_name') ||
    readBoundedString(model.id, maxModelLength, 'model.id')
  )
}

function readStatuslineEventHash(payload) {
  for (const field of upstreamEventIdentifierFields) {
    const value = readOptionalBoundedString(payload[field], maxUpstreamEventIdentifierLength)
    if (value) return hashStatuslineEventIdentifier(field, value)
  }
  return null
}

function readToken(value, field) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 0 || value > maxTokenValue) {
    throw new Error(`Invalid Antigravity statusline payload: ${field} must be a bounded nonnegative integer`)
  }
  return value
}

function readBoundedString(value, maxLength, field) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > maxLength) {
    throw new Error(`Invalid Antigravity statusline payload: ${field} is too long`)
  }
  return trimmed
}

function readOptionalBoundedString(value, maxLength) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength ? trimmed : null
}

function readObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function hashIdentifier(value) {
  if (!value) return null
  return createHash('sha256').update(value).digest('hex')
}

function hashLegacyIdentifier(value) {
  if (!value) return null
  return createHash('sha256').update('tokenboard-antigravity-cli\0').update(value).digest('hex')
}

function hashStatuslineEventIdentifier(field, value) {
  return createHash('sha256')
    .update('tokenboard-antigravity-statusline-event\0')
    .update(field)
    .update('\0')
    .update(value)
    .digest('hex')
}

function readMaxLogBytes(value) {
  if (value === undefined || value === null || value === '') return defaultMaxLogBytes
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minMaxLogBytes || parsed > maxMaxLogBytes) {
    throw new Error('Invalid Antigravity statusline log byte limit')
  }
  return parsed
}

function recordStatuslineError(filePath, stage, error, maxBytes) {
  try {
    appendBoundedStatuslineError(
      filePath,
      {
        stage,
        message: errorMessage(error),
        capturedAt: new Date().toISOString()
      },
      maxBytes
    )
  } catch (_) {}
}

function readFlags(args) {
  const flags = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2)
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue
      continue
    }
    const next = args[index + 1]
    if (!next || next.startsWith('--')) {
      flags[rawKey] = 'true'
      continue
    }
    flags[rawKey] = next
    index += 1
  }
  return flags
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await runStatuslineCli()
}
