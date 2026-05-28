import type { UsageSnapshot } from '@tokenboard/usage-core'

export const unchangedSnapshot: UsageSnapshot = {
  source: 'codex',
  usageDate: '2026-05-09',
  timezone: 'Asia/Shanghai',
  model: 'gpt-5',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 5,
  totalTokens: 17,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: '2026-05-09T10:00:00.000Z'
}

export const changedSnapshot: UsageSnapshot = {
  ...unchangedSnapshot,
  model: 'gpt-5.5',
  totalTokens: 20
}
