import { isAllDateFilter } from '../iso-calendar-date'
import { formatDate } from './session-jsonl-parser-utils'

export type AntigravityCollectionRange = {
  fullHistory: boolean
  historyScope: string
  sinceDate?: string
  includesTimestamp: (value: string) => boolean
  includesFileMtime: (mtimeMs: number) => boolean
}

export function resolveAntigravityCollectionRange(input: {
  since?: string
  timezone: string
  env?: NodeJS.ProcessEnv
}): AntigravityCollectionRange {
  const env = input.env ?? process.env
  const since = input.since ?? (env.TOKENBOARD_SINCE || env.TOKENBOARD_DEFAULT_SINCE || '')
  if (!since) {
    return {
      fullHistory: false,
      historyScope: 'all',
      includesTimestamp: () => true,
      includesFileMtime: () => true
    }
  }
  if (isAllDateFilter(since)) {
    return {
      fullHistory: true,
      historyScope: 'all',
      includesTimestamp: () => true,
      includesFileMtime: () => true
    }
  }

  const sinceDate = parseCompactDate(since)
  const includesDate = (value: Date) => formatDate(value, input.timezone) >= sinceDate
  return {
    fullHistory: false,
    historyScope: boundedHistoryScope(sinceDate, input.timezone),
    sinceDate,
    includesTimestamp: (value) => includesDate(new Date(value)),
    includesFileMtime: (mtimeMs) => mtimeMs === 0 || includesDate(new Date(mtimeMs))
  }
}

export function isReusableAntigravityHistoryScope(previous: string, current: string) {
  if (previous === current) return true
  const previousScope = parseBoundedHistoryScope(previous)
  const currentScope = parseBoundedHistoryScope(current)
  return (
    previousScope !== null &&
    currentScope !== null &&
    previousScope.timezone === currentScope.timezone &&
    previousScope.sinceDate <= currentScope.sinceDate
  )
}

function boundedHistoryScope(sinceDate: string, timezone: string) {
  return `${sinceDate}@${encodeURIComponent(timezone)}`
}

function parseBoundedHistoryScope(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2})@(.+)$/.exec(value)
  if (!match) return null
  try {
    return { sinceDate: match[1], timezone: decodeURIComponent(match[2]) }
  } catch {
    return null
  }
}

function parseCompactDate(value: string) {
  const trimmed = value.trim()
  if (!/^\d{8}$/.test(trimmed) && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`Invalid Antigravity since date: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`)
  }
  const compact = trimmed.replaceAll('-', '')
  const year = Number(compact.slice(0, 4))
  const month = Number(compact.slice(4, 6))
  const day = Number(compact.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid Antigravity since date: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`)
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}
