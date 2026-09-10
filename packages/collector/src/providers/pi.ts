import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { readSessionLines, scanSessionFiles } from './bounded-session-scan'
import { formatDate } from './session-jsonl-parser-utils'
import {
  parseJsonLine,
  readEventTimestamp,
  readFiniteNumber,
  readRecordAt,
  readSinceDate,
  readTokenCount,
  SessionUsageAggregate,
  unknownModel,
  type UsageEvent
} from './session-usage-aggregate'

const source = 'pi'
const label = 'Pi'

export type CollectPiUsageOptions = {
  timezone?: string
  collectedAt?: string
  since?: string
  agentDir?: string
  stderr?: (line: string) => void
}

/**
 * Collect Pi coding-agent usage from its session JSONL logs.
 *
 * Pi records normalized token counts and a cost breakdown per model call, so
 * both are read straight from the log.
 */
export async function collectPiUsage(options: CollectPiUsageOptions = {}): Promise<UsageSnapshot[]> {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const sinceDate = readSinceDate(options.since, label)
  const aggregate = new SessionUsageAggregate({
    source,
    timezone,
    collectedAt,
    costAvailable: true
  })

  const root = sessionsRoot(options.agentDir)
  // Forked Pi sessions copy shared history into separate files. Keep one
  // identity set for the whole scan so an entry is counted once even when it
  // appears in more than one fork.
  const seenEntryIds = new Set<string>()
  let scannedFiles = 0
  for await (const file of scanSessionFiles(root, {
    matches: (name) => name.endsWith('.jsonl'),
    onSkipped: (path, reason) => options.stderr?.(`Skipping ${label} session path (${reason}): ${path}`)
  })) {
    scannedFiles += 1
    for await (const event of readUsageEvents(file.path, seenEntryIds)) {
      if (sinceDate && formatDate(event.occurredAt, timezone) < sinceDate) continue
      aggregate.add(event)
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
 * Yield one usage event per usage-carrying entry.
 *
 * Usage rides on assistant messages, on tool results that did nested model
 * work, and on the compaction and branch-summary entries Pi writes when it
 * condenses or forks history. All four are real model calls and all four count.
 *
 * A session file is a tree keyed by `id`/`parentId`, and a fork copies shared
 * history into the new file, so an entry id is only counted once per scan.
 */
async function* readUsageEvents(filePath: string, seenEntryIds: Set<string>): AsyncGenerator<UsageEvent> {
  const sessionId = basename(filePath).replace(/\.jsonl$/, '')
  let sessionTimestamp: Date | null = null

  for await (const line of readSessionLines(filePath)) {
    const entry = parseJsonLine(line)
    if (!entry) continue

    const entryType = entry.type
    if (entryType === 'session') {
      sessionTimestamp ??= readEventTimestamp(entry.timestamp)
      continue
    }

    const carrier = readUsageCarrier(entry, entryType)
    if (!carrier) continue

    const entryId = typeof entry.id === 'string' ? entry.id : ''
    if (entryId) {
      if (seenEntryIds.has(entryId)) continue
      seenEntryIds.add(entryId)
    }

    const occurredAt =
      readEventTimestamp(entry.timestamp) ?? readEventTimestamp(carrier.message?.timestamp) ?? sessionTimestamp
    if (!occurredAt) continue

    const usage = carrier.usage
    const inputTokens = readTokenCount(usage.input)
    const outputTokens = readTokenCount(usage.output)
    const cacheReadTokens = readTokenCount(usage.cacheRead)
    // Pi splits cache writes by TTL: `cacheWrite` is the default tier and
    // `cacheWrite1h` the extended one. Both are cache creation, so dropping the
    // second would silently under-report usage on providers that offer it.
    const cacheCreationTokens = readTokenCount(usage.cacheWrite) + readTokenCount(usage.cacheWrite1h)

    yield {
      occurredAt,
      model: readModel(carrier.message),
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      costUsd: readCostUsd(usage.cost),
      sessionId
    }
  }
}

function readUsageCarrier(entry: Record<string, unknown>, entryType: unknown) {
  if (entryType === 'message') {
    const message = readRecordAt(entry.message)
    const role = message?.role
    if (role !== 'assistant' && role !== 'toolResult') return null
    const usage = readRecordAt(message?.usage)
    return usage ? { usage, message } : null
  }
  if (entryType === 'compaction' || entryType === 'branch_summary') {
    const usage = readRecordAt(entry.usage)
    return usage ? { usage, message: null } : null
  }
  return null
}

/**
 * Pi reports a per-bucket cost plus a total. The total is preferred, falling
 * back to the sum of the buckets when only those are present.
 */
function readCostUsd(value: unknown) {
  const cost = readRecordAt(value)
  if (!cost) return 0
  const total = readFiniteNumber(cost.total)
  if (total !== null && total > 0) return total
  const buckets = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']
    .map((key) => readFiniteNumber(cost[key]) ?? 0)
    .filter((amount) => amount > 0)
  return buckets.reduce((sum, amount) => sum + amount, 0)
}

/**
 * Prefer the model that actually answered over the one that was requested: a
 * gateway may serve a different model than the session asked for.
 */
function readModel(message: Record<string, unknown> | null) {
  if (!message) return unknownModel
  for (const key of ['responseModel', 'model', 'modelId']) {
    const value = message[key]
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed) return trimmed
  }
  return unknownModel
}

function sessionsRoot(agentDir?: string) {
  const explicitSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  if (!agentDir && explicitSessionDir) return explicitSessionDir
  const home =
    agentDir ??
    process.env.TOKENBOARD_PI_AGENT_DIR ??
    process.env.PI_CODING_AGENT_DIR ??
    join(homedir(), '.pi', 'agent')
  return join(home, 'sessions')
}
