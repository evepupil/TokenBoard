import { usageSnapshotSchema, type UsageSnapshot, type UsageSource } from '@tokenboard/usage-core'
import { assertValidDateFilter, isAllDateFilter } from '../iso-calendar-date'
import { formatDate } from './session-jsonl-parser-utils'

const maxModelNameLength = 160
export const unknownModel = 'unknown'

/** One model call's usage, already normalized to TokenBoard's disjoint counts. */
export type UsageEvent = {
  occurredAt: Date
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
  sessionId: string
}

type AggregateRow = {
  usageDate: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
  sessions: Set<string>
}

/**
 * Folds usage events into one snapshot per (local date, model).
 *
 * Sources that cannot report a cost pass `costAvailable: false`, which pins
 * `costUsd` to 0 so the schema's cost-unavailable rule holds and no reporting
 * surface presents a guessed figure as real.
 */
export class SessionUsageAggregate {
  private readonly rows = new Map<string, AggregateRow>()

  constructor(
    private readonly options: {
      source: UsageSource
      timezone: string
      collectedAt: string
      costAvailable: boolean
    }
  ) {}

  add(event: UsageEvent) {
    const billable = event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens
    if (billable === 0) return

    const usageDate = formatDate(event.occurredAt, this.options.timezone)
    const model = boundedModel(event.model)
    const key = `${usageDate}\0${model}`
    const current = this.rows.get(key)
    if (!current) {
      this.rows.set(key, {
        usageDate,
        model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        cacheReadTokens: event.cacheReadTokens,
        costUsd: this.options.costAvailable ? event.costUsd : 0,
        sessions: new Set(event.sessionId ? [event.sessionId] : [])
      })
      return
    }
    current.inputTokens += event.inputTokens
    current.outputTokens += event.outputTokens
    current.cacheCreationTokens += event.cacheCreationTokens
    current.cacheReadTokens += event.cacheReadTokens
    if (this.options.costAvailable) current.costUsd += event.costUsd
    if (event.sessionId) current.sessions.add(event.sessionId)
  }

  snapshots(): UsageSnapshot[] {
    return [...this.rows.values()]
      .sort((left, right) => left.usageDate.localeCompare(right.usageDate) || left.model.localeCompare(right.model))
      .map((row) =>
        usageSnapshotSchema.parse({
          source: this.options.source,
          usageDate: row.usageDate,
          timezone: this.options.timezone,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheCreationTokens: row.cacheCreationTokens,
          cacheReadTokens: row.cacheReadTokens,
          totalTokens: row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
          costUsd: this.options.costAvailable ? row.costUsd : 0,
          sessionCount: row.sessions.size,
          collectedAt: this.options.collectedAt
        })
      )
  }
}

/** Non-negative integer count, tolerating string-encoded numbers. */
export function readTokenCount(value: unknown) {
  const parsed = readFiniteNumber(value)
  if (parsed === null || parsed <= 0) return 0
  return Math.trunc(parsed)
}

export function readFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Epoch seconds or milliseconds, or an ISO timestamp, as a Date.
 *
 * Values below the threshold are read as seconds: a millisecond timestamp for
 * any plausible date is far larger, so the two cannot be confused.
 */
export function readEventTimestamp(value: unknown): Date | null {
  const secondsThreshold = 100_000_000_000
  const numeric = readFiniteNumber(value)
  if (numeric !== null) {
    if (numeric <= 0) return null
    const date = new Date(numeric < secondsThreshold ? numeric * 1000 : numeric)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

/** Model ids come from provider responses, so they are bounded before upload. */
export function boundedModel(value: unknown) {
  if (typeof value !== 'string') return unknownModel
  const model = value.trim()
  if (!model) return unknownModel
  return model.length > maxModelNameLength ? model.slice(0, maxModelNameLength) : model
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function readRecordAt(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Resolve `--since` to a local date string, or `''` for full history. */
export function readSinceDate(since: string | undefined, label: string) {
  const value = since ?? process.env.TOKENBOARD_SINCE ?? process.env.TOKENBOARD_DEFAULT_SINCE ?? ''
  if (!value) return ''
  const normalized = assertValidDateFilter(value, `${label} since value`, true)
  if (isAllDateFilter(normalized)) return ''
  const compact = normalized.replaceAll('-', '')
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}
