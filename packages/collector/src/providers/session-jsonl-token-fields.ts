import type { UsageSource } from '@tokenboard/usage-core'

type UnknownRecord = Record<string, unknown>

export function hasUnparsedTokenMetricField(source: UsageSource, record: UnknownRecord) {
  if (source === 'claude-code') {
    return hasClaudeUsageMetricField(record)
  }
  return hasTokenMetricField(record)
}

function hasClaudeUsageMetricField(record: UnknownRecord) {
  const message = readRecord(record.message) ?? record
  const usage = readRecord(message.usage ?? record.usage)
  return Boolean(usage && hasTokenMetricField(usage))
}

function hasTokenMetricField(value: unknown, depth = 0): boolean {
  if (depth > 5 || !value || typeof value !== 'object') {
    return false
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasTokenMetricField(item, depth + 1))
  }

  return Object.entries(value as UnknownRecord).some(([key, child]) =>
    isTokenMetricKey(key) || hasTokenMetricField(child, depth + 1)
  )
}

function isTokenMetricKey(key: string) {
  return [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheCreationTokens',
    'cacheReadTokens'
  ].includes(key)
}

function readRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}
