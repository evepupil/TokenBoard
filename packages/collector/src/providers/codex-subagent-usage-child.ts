import { assertValidIsoCalendarDate } from '../iso-calendar-date'
import {
  normalizeDate,
  readCacheCreationTokens,
  readCacheReadTokens,
  readJsonlRecords,
  readNumber,
  readRecord,
  readString,
  readTotalTokens,
  type UnknownRecord
} from './codex-subagent-usage-json'

const dateFormatterByTimezone = new Map<string, Intl.DateTimeFormat>()
const formattedUsageDateCache = new Map<string, string>()
const maxFormattedUsageDateCacheEntries = 4_096

export const maxCodexChildSessionBytes = 4 * 1024 * 1024 * 1024
export const maxCodexChildSessionLineBytes = 1024 * 1024
export const maxDiscardedCodexChildSessionLineBytes = 64 * 1024 * 1024
export const maxCodexChildUsageEvents = 65_536
export const maxMergedCodexChildUsageEvents = 65_536
export const codexChildSessionReadLimits = {
  maxBytes: maxCodexChildSessionBytes,
  maxLineBytes: maxCodexChildSessionLineBytes,
  maxDiscardedLineBytes: maxDiscardedCodexChildSessionLineBytes,
  relevantMetadataKeys: ['total_token_usage', 'last_token_usage', 'subagent'],
  discardableLineTypes: ['compacted', 'event_msg', 'response_item', 'turn_context'],
  label: 'Codex child session'
} as const

type TotalUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
}

export type DatedUsage = TotalUsage & {
  usageDate: string
}

export type ChildUsageEvent = DatedUsage & {
  eventKey: string
}

export async function readChildLastUsageByDate(
  filePath: string,
  timestamp: string,
  timezone: string,
  stderr?: (line: string) => void
) {
  const merger = new ChildUsageEventMerger(maxCodexChildUsageEvents)
  for await (const event of readChildUsageEventsFromFile(filePath, timestamp, timezone, stderr)) {
    merger.addOne(event)
  }
  return merger.toUsageByDate()
}

export async function readChildLastUsageEvents(
  filePath: string,
  timestamp: string,
  timezone: string,
  stderr?: (line: string) => void
) {
  const events: ChildUsageEvent[] = []
  const seenEventKeys = new Set<string>()
  for await (const event of readChildUsageEventsFromFile(filePath, timestamp, timezone, stderr)) {
    const eventKey = event.eventKey
    if (seenEventKeys.has(eventKey)) continue
    if (seenEventKeys.size >= maxCodexChildUsageEvents) {
      throw new Error(`Codex child session exceeds the ${maxCodexChildUsageEvents} unique usage-event limit`)
    }
    seenEventKeys.add(eventKey)
    events.push(event)
  }
  return events
}

async function* readChildUsageEventsFromFile(
  filePath: string,
  timestamp: string,
  timezone: string,
  stderr?: (line: string) => void
) {
  let missingLastUsageRecords = 0
  try {
    for await (const record of readJsonlRecords(filePath, stderr, codexChildSessionReadLimits)) {
      const result = readChildUsageEvent(record, timestamp, timezone, filePath)
      if (result.missingLastUsage) missingLastUsageRecords += 1
      if (result.event) yield result.event
    }
  } finally {
    if (missingLastUsageRecords > 0) {
      stderr?.(
        `Skipped ${missingLastUsageRecords} Codex child usage record${missingLastUsageRecords === 1 ? '' : 's'} with total_token_usage but missing last_token_usage`
      )
    }
  }
}

function readChildUsageEvent(
  record: UnknownRecord,
  timestamp: string,
  timezone: string,
  filePath: string
): { event: ChildUsageEvent | null; missingLastUsage: boolean } {
  const recordTimestamp = readString(record, ['timestamp'])
  if (!recordTimestamp || recordTimestamp < timestamp) return { event: null, missingLastUsage: false }
  const cumulative = readTotalUsage(record)
  const usage = readLastUsage(record)
  if (!cumulative) return { event: null, missingLastUsage: false }
  if (!usage) return { event: null, missingLastUsage: true }
  return {
    event: {
      eventKey: childUsageEventKey(filePath, recordTimestamp, cumulative),
      usageDate: formatCodexUsageDate(recordTimestamp, timezone),
      ...usage
    },
    missingLastUsage: false
  }
}

export function mergeChildUsageEventsByDate(eventLists: readonly ChildUsageEvent[][]) {
  const merger = new ChildUsageEventMerger()
  for (const events of eventLists) merger.add(events)
  return merger.toUsageByDate()
}

export class ChildUsageEventMerger {
  private readonly byDate = new Map<string, DatedUsage>()
  private readonly seenEventKeys = new Set<string>()

  constructor(private readonly maxUniqueEvents = maxMergedCodexChildUsageEvents) {}

  add(events: readonly ChildUsageEvent[]) {
    for (const event of events) this.addOne(event)
  }

  addOne(event: ChildUsageEvent) {
    if (this.seenEventKeys.has(event.eventKey)) return
    if (this.seenEventKeys.size >= this.maxUniqueEvents) {
      throw new Error(`Codex child usage correction exceeds the ${this.maxUniqueEvents} unique usage-event limit`)
    }
    this.seenEventKeys.add(event.eventKey)
    addDatedUsage(this.byDate, event.usageDate, event)
  }

  toUsageByDate() {
    return [...this.byDate.values()].sort((left, right) => left.usageDate.localeCompare(right.usageDate))
  }
}

export function sumDatedUsage(usages: DatedUsage[]) {
  return usages.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheCreationTokens: total.cacheCreationTokens + usage.cacheCreationTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      totalTokens: total.totalTokens + usage.totalTokens
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
  )
}

function addDatedUsage(byDate: Map<string, DatedUsage>, usageDate: string, usage: TotalUsage) {
  const current = byDate.get(usageDate) ?? {
    usageDate,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0
  }
  current.inputTokens += usage.inputTokens
  current.outputTokens += usage.outputTokens
  current.cacheCreationTokens += usage.cacheCreationTokens
  current.cacheReadTokens += usage.cacheReadTokens
  current.totalTokens += usage.totalTokens
  byDate.set(usageDate, current)
}

function readTotalUsage(record: UnknownRecord): TotalUsage | null {
  const payload = readRecord(record.payload)
  const info = readRecord(payload?.info)
  const usage = readRecord(info?.total_token_usage)
  if (!usage) return null
  return {
    inputTokens: readNumber(usage, ['input_tokens', 'inputTokens']),
    outputTokens: readNumber(usage, ['output_tokens', 'outputTokens']),
    cacheCreationTokens: readCacheCreationTokens(usage),
    cacheReadTokens: readCacheReadTokens(usage),
    totalTokens: readTotalTokens(usage)
  }
}

function readLastUsage(record: UnknownRecord): TotalUsage | null {
  const payload = readRecord(record.payload)
  const info = readRecord(payload?.info)
  const usage = readRecord(info?.last_token_usage)
  if (!usage) return null
  return {
    inputTokens: readNumber(usage, ['input_tokens', 'inputTokens']),
    outputTokens: readNumber(usage, ['output_tokens', 'outputTokens']),
    cacheCreationTokens: readCacheCreationTokens(usage),
    cacheReadTokens: readCacheReadTokens(usage),
    totalTokens: readTotalTokens(usage)
  }
}

function childUsageEventKey(filePath: string, timestamp: string, usage: TotalUsage) {
  return `${stableChildSessionIdentity(filePath)}|${timestamp}|${totalUsageKey(usage)}`
}

function stableChildSessionIdentity(filePath: string) {
  const normalized = filePath.replaceAll('\\', '/')
  const match = /\/(sessions|archived_sessions)\/(.+)$/.exec(normalized)
  if (match) return `${match[1]}/${match[2]}`
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function totalUsageKey(usage: TotalUsage) {
  return `${usage.inputTokens}/${usage.cacheCreationTokens}/${usage.cacheReadTokens}/${usage.outputTokens}/${usage.totalTokens}`
}

export function formatCodexUsageDate(value: string, timezone: string) {
  assertValidIsoCalendarDate(value, 'Invalid Codex date')
  const cacheKey = `${timezone}\u0000${value}`
  const cached = formattedUsageDateCache.get(cacheKey)
  if (cached) return cached

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return cacheFormattedUsageDate(cacheKey, normalizeDate(value))
  }
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = dateFormatter(timezone).formatToParts(new Date(parsed))
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Invalid timezone for Codex subagent usage date: ${timezone}`)
    }
    throw error
  }
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  )
  return cacheFormattedUsageDate(cacheKey, `${values.year}-${values.month}-${values.day}`)
}

function cacheFormattedUsageDate(cacheKey: string, usageDate: string) {
  if (formattedUsageDateCache.size >= maxFormattedUsageDateCacheEntries) {
    const oldestKey = formattedUsageDateCache.keys().next().value
    if (oldestKey !== undefined) formattedUsageDateCache.delete(oldestKey)
  }
  formattedUsageDateCache.set(cacheKey, usageDate)
  return usageDate
}

function dateFormatter(timezone: string) {
  const existing = dateFormatterByTimezone.get(timezone)
  if (existing) return existing
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  dateFormatterByTimezone.set(timezone, formatter)
  return formatter
}
