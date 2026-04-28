import type { UsageSnapshot } from './schema'

export function withTotalTokens(snapshot: Omit<UsageSnapshot, 'totalTokens'>): UsageSnapshot {
  return {
    ...snapshot,
    totalTokens:
      snapshot.inputTokens +
      snapshot.outputTokens +
      snapshot.cacheCreationTokens +
      snapshot.cacheReadTokens
  }
}

