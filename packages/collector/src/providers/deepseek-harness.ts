import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { maxSessionFileBytes, readSessionLines, scanSessionFiles } from './bounded-session-scan'
import { formatDate } from './session-jsonl-parser-utils'
import {
  parseJsonLine,
  readEventTimestamp,
  readRecordAt,
  readSinceDate,
  readTokenCount,
  SessionUsageAggregate,
  unknownModel,
  type UsageEvent
} from './session-usage-aggregate'
import { decompressZstdFrame, isZstdBuffer, scanZstdFrames } from './zstd-frames'

const source = 'deepseek-harness'
const label = 'DeepSeek Harness'
const assistantMessageEvent = 'assistant/message'
const plainLogName = 'session.jsonl'
const compressedLogName = 'session.jsonl.zstd'

export type CollectDeepSeekHarnessUsageOptions = {
  timezone?: string
  collectedAt?: string
  since?: string
  dshHome?: string
  sessionRoot?: string
  stderr?: (line: string) => void
}

/**
 * Collect DeepSeek Harness (DSH) usage from its session event logs.
 *
 * DSH reports token counts but no cost, so `costUsd` stays 0 and every
 * reporting surface labels the cost as unavailable rather than showing a
 * derived figure as real.
 */
export async function collectDeepSeekHarnessUsage(
  options: CollectDeepSeekHarnessUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const sinceDate = readSinceDate(options.since, label)
  const aggregate = new SessionUsageAggregate({
    source,
    timezone,
    collectedAt,
    costAvailable: false
  })

  const root = sessionRoot(options)
  let scannedFiles = 0
  for await (const file of scanSessionFiles(root, {
    matches: (name) => name === plainLogName || name === compressedLogName,
    onSkipped: (path, reason) => options.stderr?.(`Skipping ${label} session path (${reason}): ${path}`)
  })) {
    scannedFiles += 1
    try {
      for await (const event of readUsageEvents(file.path)) {
        if (sinceDate && formatDate(event.occurredAt, timezone) < sinceDate) continue
        aggregate.add(event)
      }
    } catch (error) {
      // One unreadable log must not lose the usage held by every other session.
      options.stderr?.(`Skipping unreadable ${label} session log ${file.path}: ${errorText(error)}`)
    }
  }

  // Signals "nothing to collect here" so an all-source run skips this source
  // instead of reporting it as collected with zero usage.
  if (scannedFiles === 0) {
    throw new Error(`No ${label} sessions found: ${root}`)
  }
  return aggregate.snapshots()
}

/**
 * Yield one usage event per assistant message that reported token accounting.
 *
 * A DSH event log line is `{ type, seq, time, data }` with `time` in epoch
 * milliseconds. Usage travels on `assistant/message` events, whose `data`
 * also holds the assistant's reply and the provider's replay state; only the
 * token counts and the model identity are read.
 */
async function* readUsageEvents(filePath: string): AsyncGenerator<UsageEvent> {
  const sessionId = basename(dirname(filePath))
  for await (const line of readLogLines(filePath)) {
    const record = parseJsonLine(line)
    if (!record || record.type !== assistantMessageEvent) continue

    const data = readRecordAt(record.data)
    const usage = readRecordAt(data?.usage)
    if (!usage) continue
    const occurredAt = readEventTimestamp(record.time)
    if (!occurredAt) continue

    yield {
      occurredAt,
      model: readModel(data),
      inputTokens: readTokenCount(usage.inputTokens),
      // `reasoningTokens` is informational and already inside `outputTokens`.
      outputTokens: readTokenCount(usage.outputTokens),
      cacheCreationTokens: readTokenCount(usage.cacheWriteTokens),
      cacheReadTokens: readTokenCount(usage.cacheReadTokens),
      costUsd: 0,
      sessionId
    }
  }
}

/**
 * A DSH log is Zstandard-compressed by default, and its frames are appended in
 * batches, so the whole file has to be decoded before the lines are readable.
 * Plain logs stay streamed line by line.
 */
async function* readLogLines(filePath: string): AsyncGenerator<string> {
  if (!filePath.endsWith('.zstd')) {
    yield* readSessionLines(filePath)
    return
  }
  const fileStat = await stat(filePath)
  if (fileStat.size > maxSessionFileBytes) {
    throw new Error(`DeepSeek Harness compressed session log exceeds ${maxSessionFileBytes} bytes`)
  }
  const compressed = await readFile(filePath)
  if (compressed.length === 0) return
  if (compressed.length > maxSessionFileBytes) {
    throw new Error(`DeepSeek Harness compressed session log exceeds ${maxSessionFileBytes} bytes`)
  }
  if (!isZstdBuffer(compressed)) {
    throw new Error('not a Zstandard session log')
  }
  let decodedBytes = 0
  let pending = ''
  for (const frame of scanZstdFrames(compressed)) {
    let decoded: Buffer
    try {
      decoded = decompressZstdFrame(compressed, frame, { maxOutputLength: maxSessionFileBytes })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(`DeepSeek Harness decompressed session log exceeds ${maxSessionFileBytes} bytes`, {
          cause: error
        })
      }
      throw error
    }
    decodedBytes += decoded.length
    if (decodedBytes > maxSessionFileBytes) {
      throw new Error(`DeepSeek Harness decompressed session log exceeds ${maxSessionFileBytes} bytes`)
    }
    pending += decoded.toString('utf8')
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      yield pending.slice(0, newline)
      pending = pending.slice(newline + 1)
    }
  }
  if (pending) yield pending
}

/**
 * The model that produced the message lives on the assistant message's
 * `source`, which carries the provider route and provider model id.
 */
function readModel(data: Record<string, unknown> | null) {
  const message = readRecordAt(data?.message)
  const provenance = readRecordAt(message?.source)
  for (const candidate of [provenance?.model, message?.model, data?.model]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return unknownModel
}

function sessionRoot(options: CollectDeepSeekHarnessUsageOptions) {
  if (options.sessionRoot) return options.sessionRoot
  const explicitRoot = process.env.TOKENBOARD_DSH_SESSION_ROOT ?? process.env.DSH_SESSION_ROOT
  if (!options.dshHome && explicitRoot) return explicitRoot
  const home = options.dshHome ?? process.env.TOKENBOARD_DSH_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
