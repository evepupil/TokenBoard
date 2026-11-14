import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { readSessionLinesBounded, scanSessionFiles } from './bounded-session-scan'
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

const source = 'grok-build'
const label = 'Grok Build'
const usageFileName = 'updates.jsonl'
const usageMethod = '_x.ai/session/update'
const turnCompleted = 'turn_completed'

export type CollectGrokBuildUsageOptions = {
  timezone?: string
  collectedAt?: string
  since?: string
  grokHome?: string
  stderr?: (line: string) => void
}

/**
 * Collect Grok Build (Grok CLI) usage from its session update logs.
 *
 * Grok reports no cost of its own, so `costUsd` stays 0 and every reporting
 * surface labels the cost as unavailable rather than showing a derived figure
 * as real.
 */
export async function collectGrokBuildUsage(options: CollectGrokBuildUsageOptions = {}): Promise<UsageSnapshot[]> {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const sinceDate = readSinceDate(options.since, label)
  const aggregate = new SessionUsageAggregate({
    source,
    timezone,
    collectedAt,
    costAvailable: false
  })

  let scannedFiles = 0
  for (const root of sessionRoots(options.grokHome)) {
    for await (const file of scanSessionFiles(root, {
      matches: (name) => name === usageFileName,
      onSkipped: (path, reason) => options.stderr?.(`Skipping ${label} session path (${reason}): ${path}`)
    })) {
      scannedFiles += 1
      for await (const event of readUsageEvents(file.path, options.stderr)) {
        if (sinceDate && formatDate(event.occurredAt, timezone) < sinceDate) continue
        aggregate.add(event)
      }
    }
  }

  // Signals "nothing to collect here" so an all-source run skips this source
  // instead of reporting it as collected with zero usage.
  if (scannedFiles === 0) {
    throw new Error(`No ${label} sessions found: ${sessionRoots(options.grokHome).join(', ')}`)
  }
  return aggregate.snapshots()
}

/**
 * Yield one usage event per completed turn.
 *
 * A `turn_completed` event carries that turn's own totals, already summed
 * across the inference loops inside it, and the next turn starts from zero.
 * They are therefore recorded at face value: differencing against the previous
 * event would treat per-turn totals as a running counter and lose most usage.
 * Only events whose `sessionUpdate` is exactly `turn_completed` carry usage:
 * every usage-bearing event observed from real Grok logs across many sessions
 * was `turn_completed`, and a mid-turn snapshot alongside the turn's final
 * event would double-count it. An update with a different kind, a non-string
 * kind, or no kind at all is skipped rather than guessed at.
 */
async function* readUsageEvents(filePath: string, stderr?: (line: string) => void): AsyncGenerator<UsageEvent> {
  const sessionId = basename(dirname(filePath))
  for await (const line of readSessionLinesBounded(filePath, {
    onSkippedLine: (bytes) => stderr?.(`Skipping an oversized line (${bytes} bytes) in Grok Build session ${filePath}`)
  })) {
    const record = parseJsonLine(line)
    if (!record || record.method !== usageMethod) continue

    const update = readRecordAt(readRecordAt(record.params)?.update)
    if (!update) continue
    if (update.sessionUpdate !== turnCompleted) continue

    const usage = readRecordAt(update.usage)
    if (!usage) continue
    const occurredAt = readEventTimestamp(record.timestamp)
    if (!occurredAt) continue

    const perModel = readRecordAt(usage.modelUsage)
    if (perModel && Object.keys(perModel).length > 0) {
      // Sorted so repeated scans aggregate in a deterministic order.
      let yielded = false
      for (const model of Object.keys(perModel).sort()) {
        const counters = readRecordAt(perModel[model])
        if (!counters) {
          // A corrupt entry is skipped rather than guessed at, but silently: the turn's
          // top-level totals do not stand in for it (a present breakdown is authoritative),
          // so the tokens it carried would vanish with no trace. Report it instead.
          stderr?.(`Skipping unreadable ${label} modelUsage entry (${model}) in ${filePath}`)
          continue
        }
        const event = toUsageEvent(counters, { occurredAt, sessionId, model })
        // A readable but token-less entry (all counters zero) must not count as the turn's
        // output: marking it yielded would skip the top-level totals below and lose whatever
        // they held, the same way an empty breakdown did before.
        if (!hasBillableTokens(event)) continue
        yielded = true
        yield event
      }
      // A present-but-empty or entirely unreadable breakdown would otherwise drop the turn on
      // the floor; fall through to the top-level totals.
      if (yielded) continue
    }
    // Without a usable per-model breakdown the turn's top-level totals still count; the model is
    // unknown and is labeled as such rather than guessed.
    yield toUsageEvent(usage, { occurredAt, sessionId, model: unknownModel })
  }
}

// Mirrors the aggregate's own billable test (`SessionUsageAggregate.add`), so an event this
// provider emits is exactly one the aggregate will keep.
function hasBillableTokens(event: UsageEvent) {
  return event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens > 0
}

/**
 * Grok's `inputTokens` includes `cachedReadTokens`, unlike TokenBoard's
 * snapshot where the two are disjoint and `totalTokens` is their sum. The
 * cached share is therefore subtracted back out of input.
 *
 * `reasoningTokens` is already part of `outputTokens` and is not added again.
 */
function toUsageEvent(
  counters: Record<string, unknown>,
  context: { occurredAt: Date; sessionId: string; model: string }
): UsageEvent {
  const reportedInput = readTokenCount(counters.inputTokens)
  const cacheReadTokens = Math.min(readTokenCount(counters.cachedReadTokens), reportedInput)
  return {
    occurredAt: context.occurredAt,
    model: context.model,
    inputTokens: reportedInput - cacheReadTokens,
    outputTokens: readTokenCount(counters.outputTokens),
    cacheCreationTokens: 0,
    cacheReadTokens,
    costUsd: 0,
    sessionId: context.sessionId
  }
}

function sessionRoots(grokHome?: string) {
  const home = grokHome ?? process.env.TOKENBOARD_GROK_HOME ?? process.env.GROK_HOME ?? join(homedir(), '.grok')
  return [join(home, 'sessions'), join(home, 'archived_sessions')]
}
