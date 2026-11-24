import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { maxSessionFileBytes, readSessionLinesBounded, scanSessionFiles } from './bounded-session-scan'
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
  // Events are folded one session directory at a time, because a session directory can hold both
  // physical encodings at once while a DSH compression change is unresolved. Files are grouped
  // by directory rather than folded in scan order: the scanner recurses into a subdirectory
  // mid-list when its name sorts between two sibling files, which would split one directory's
  // files across two folds and reset the dedup set between them (double-counting a sequence).
  // The map holds path strings only — never event records or content.
  const filesBySessionDir = new Map<string, string[]>()
  for await (const file of scanSessionFiles(root, {
    matches: (name) => name === plainLogName || name === compressedLogName,
    onSkipped: (path, reason) => options.stderr?.(`Skipping ${label} session path (${reason}): ${path}`)
  })) {
    const sessionDir = dirname(file.path)
    const group = filesBySessionDir.get(sessionDir)
    if (group) group.push(file.path)
    else filesBySessionDir.set(sessionDir, [file.path])
    scannedFiles += 1
  }

  for (const sessionFiles of filesBySessionDir.values()) {
    // The two encodings are two views of the same logical event log, so an event is identified
    // by its durable per-session sequence and counted once. The union is kept rather than one
    // file being preferred: a sequence present in only one file still counts, so neither a stale
    // view nor a newer one silently loses events. A usage event without a usable sequence cannot
    // be compared, so it is counted rather than dropped — the readable-data rule outweighs the
    // possibility of counting it twice.
    const seenSeqs = new Set<number>()
    for (const filePath of sessionFiles) {
      // A real read failure (corrupt frame, oversize log) fails the source, matching the Pi and
      // Grok Build providers; only a torn trailing frame from a session still being written is
      // tolerated inside the frame reader.
      for await (const parsed of readUsageEvents(filePath, options.stderr)) {
        if (parsed.seq !== undefined) {
          if (seenSeqs.has(parsed.seq)) continue
          seenSeqs.add(parsed.seq)
        }
        const event = parsed.event
        if (sinceDate && formatDate(event.occurredAt, timezone) < sinceDate) continue
        aggregate.add(event)
      }
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
 * milliseconds and `seq` the durable per-session event sequence (contiguous
 * from the fork-inherited prefix length). Usage travels on `assistant/message`
 * events, whose `data` also holds the assistant's reply and the provider's
 * replay state; only the token counts, the model identity and the sequence
 * number are read. `seq` is `undefined` when the envelope does not carry a
 * usable one, which callers treat as "cannot be deduplicated".
 */
async function* readUsageEvents(
  filePath: string,
  stderr?: (line: string) => void
): AsyncGenerator<{ event: UsageEvent; seq: number | undefined }> {
  const sessionId = basename(dirname(filePath))
  for await (const line of readLogLines(filePath, stderr)) {
    const record = parseJsonLine(line)
    if (!record || record.type !== assistantMessageEvent) continue

    const data = readRecordAt(record.data)
    const usage = readRecordAt(data?.usage)
    if (!usage) continue
    const occurredAt = readEventTimestamp(record.time)
    if (!occurredAt) continue

    yield {
      event: {
        occurredAt,
        model: readModel(data),
        inputTokens: readTokenCount(usage.inputTokens),
        // `reasoningTokens` is informational and already inside `outputTokens`.
        outputTokens: readTokenCount(usage.outputTokens),
        cacheCreationTokens: readTokenCount(usage.cacheWriteTokens),
        cacheReadTokens: readTokenCount(usage.cacheReadTokens),
        costUsd: 0,
        sessionId
      },
      seq: readEventSeq(record.seq)
    }
  }
}

/**
 * The durable event sequence, or `undefined` when the envelope lacks a usable
 * one. Only non-negative safe integers are accepted: a sequence that cannot be
 * compared exactly cannot deduplicate anything, and treating it as a key would
 * merge distinct events instead of skipping duplicates.
 */
function readEventSeq(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * A DSH log is Zstandard-compressed by default, and its frames are appended in
 * batches, so the whole file has to be decoded before the lines are readable.
 * Plain logs stay streamed line by line.
 */
async function* readLogLines(filePath: string, stderr?: (line: string) => void): AsyncGenerator<string> {
  if (!filePath.endsWith('.zstd')) {
    yield* readSessionLinesBounded(filePath, {
      onSkippedLine: (bytes) =>
        stderr?.(`Skipping an oversized line (${bytes} bytes) in DeepSeek Harness session ${filePath}`)
    })
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
  const decoder = new TextDecoder('utf-8')
  for (const frame of scanZstdFrames(compressed)) {
    let decoded: Buffer
    // Decompress each frame against what is *left* of the budget, not the whole of it. The
    // running total below still rejects the result either way, but passing the full limit to
    // every frame would let the peak reach twice the cap — the frames already decoded plus one
    // more at full size — before the total is ever checked.
    const remaining = maxSessionFileBytes - decodedBytes
    // `maxOutputLength` must be at least 1, and `remaining` reaches 0 when the decoded total
    // lands exactly on the cap with at least one frame still to read. Clamping to 1 keeps
    // that case decodable: an empty trailing frame passes the running-total check below, and
    // any frame with real content raises ERR_BUFFER_TOO_LARGE, which the catch classifies.
    // Passing 0 through instead would raise ERR_OUT_OF_RANGE and escape that classification.
    const frameBudget = Math.max(remaining, 1)
    try {
      decoded = decompressZstdFrame(compressed, frame, { maxOutputLength: frameBudget })
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
    // Keep decoder state across frames so a multibyte UTF-8 sequence split at
    // a frame boundary is not replaced before the next frame arrives.
    pending += decoder.decode(decoded, { stream: true })
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      yield pending.slice(0, newline)
      pending = pending.slice(newline + 1)
    }
  }
  pending += decoder.decode()
  let newline: number
  while ((newline = pending.indexOf('\n')) >= 0) {
    yield pending.slice(0, newline)
    pending = pending.slice(newline + 1)
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
