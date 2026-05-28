import {
  normalizeDate,
  readCacheReadTokens,
  readJsonlRecords,
  readNumber,
  readRecord,
  readString,
  readTotalTokens,
  type UnknownRecord
} from './codex-subagent-usage-json'

type TotalUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  totalTokens: number
}

export type DatedUsage = TotalUsage & {
  usageDate: string
}

export async function readChildLastUsageByDate(
  filePath: string,
  timestamp: string,
  timezone: string,
  stderr?: (line: string) => void
) {
  const byDate = new Map<string, DatedUsage>()
  const seenTotals = new Set<string>()
  for await (const record of readJsonlRecords(filePath, stderr)) {
    const recordTimestamp = readString(record, ['timestamp'])
    if (!recordTimestamp || recordTimestamp < timestamp) continue
    const cumulative = readTotalUsage(record)
    const usage = readLastUsage(record)
    if (!cumulative || !usage) continue

    const key = totalUsageKey(cumulative)
    if (seenTotals.has(key)) continue
    seenTotals.add(key)
    addDatedUsage(byDate, formatUsageDate(recordTimestamp, timezone), usage)
  }
  return [...byDate.values()].sort((left, right) => left.usageDate.localeCompare(right.usageDate))
}

export function sumDatedUsage(usages: DatedUsage[]) {
  return usages.reduce((total, usage) => ({
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    totalTokens: total.totalTokens + usage.totalTokens
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 })
}

function addDatedUsage(byDate: Map<string, DatedUsage>, usageDate: string, usage: TotalUsage) {
  const current = byDate.get(usageDate) ?? { usageDate, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
  current.inputTokens += usage.inputTokens
  current.outputTokens += usage.outputTokens
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
    cacheReadTokens: readCacheReadTokens(usage),
    totalTokens: readTotalTokens(usage)
  }
}

function totalUsageKey(usage: TotalUsage) {
  return `${usage.inputTokens}/${usage.cacheReadTokens}/${usage.outputTokens}/${usage.totalTokens}`
}

function formatUsageDate(value: string, timezone: string) {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return normalizeDate(value)
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(parsed))
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Invalid timezone for Codex subagent usage date: ${timezone}`)
    }
    throw error
  }
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}
