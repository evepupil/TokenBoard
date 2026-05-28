type UsageInput = {
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

export function sessionMeta(id: string, timestamp: string) {
  return {
    type: 'session_meta',
    timestamp,
    payload: {
      id,
      timestamp
    }
  }
}

export function subagentSessionMeta(id: string, parentThreadId: string, timestamp: string) {
  return {
    type: 'session_meta',
    timestamp,
    payload: {
      id,
      timestamp,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentThreadId
          }
        }
      }
    }
  }
}

export function totalUsageEvent(
  timestamp: string,
  usage: UsageInput,
  options: { lastUsage?: UsageInput | null } = {}
) {
  const info: Record<string, unknown> = {
    model: 'gpt-5',
    total_token_usage: tokenUsage(usage)
  }
  if (options.lastUsage !== null) {
    info.last_token_usage = tokenUsage(options.lastUsage ?? usage)
  }
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info
    }
  }
}

export function inheritedSessionResult() {
  return {
    sessions: [
      {
        sessionId: '2026/05/25/rollout-child-thread',
        lastActivity: '2026-05-25T01:10:00.000Z',
        totalTokens: 3170,
        costUSD: 3.17,
        models: {
          'gpt-5': {
            inputTokens: 1100,
            cachedInputTokens: 1950,
            outputTokens: 120,
            totalTokens: 3170,
            costUSD: 3.17
          }
        }
      }
    ]
  }
}

export function inheritedDailyResult() {
  return {
    daily: [
      {
        date: '2026-05-25',
        models: {
          'gpt-5': {
            inputTokens: 1100,
            cachedInputTokens: 1950,
            outputTokens: 120,
            totalTokens: 3170
          }
        },
        totalTokens: 3170,
        costUSD: 3.17
      }
    ]
  }
}

export function independentSubagentSessionResult() {
  return {
    sessions: [
      {
        sessionId: '2026/05/25/rollout-child-thread',
        lastActivity: '2026-05-25T01:10:00.000Z',
        totalTokens: 220,
        costUSD: 0.22,
        models: {
          'gpt-5': {
            inputTokens: 50,
            cachedInputTokens: 150,
            outputTokens: 20,
            totalTokens: 220,
            costUSD: 0.22
          }
        }
      }
    ]
  }
}

export function independentSubagentDailyResult() {
  return {
    daily: [
      {
        date: '2026-05-25',
        models: {
          'gpt-5': {
            inputTokens: 50,
            cachedInputTokens: 150,
            outputTokens: 20,
            totalTokens: 220
          }
        },
        totalTokens: 220,
        costUSD: 0.22
      }
    ]
  }
}

export function inheritedMultiModelSessionResult() {
  return {
    sessions: [
      {
        sessionId: '2026/05/25/rollout-child-thread',
        lastActivity: '2026-05-25T01:10:00.000Z',
        totalTokens: 3170,
        costUSD: 3.17,
        models: {
          'gpt-5.4': {
            inputTokens: 100,
            cachedInputTokens: 300,
            outputTokens: 20,
            totalTokens: 420,
            costUSD: 0
          },
          'gpt-5.5': {
            inputTokens: 1000,
            cachedInputTokens: 1650,
            outputTokens: 100,
            totalTokens: 2750,
            costUSD: 0
          }
        }
      }
    ]
  }
}

export function inheritedMultiModelDailyResult() {
  return {
    daily: [
      {
        date: '2026-05-25',
        models: {
          'gpt-5.4': {
            inputTokens: 100,
            cachedInputTokens: 300,
            outputTokens: 20,
            totalTokens: 420
          },
          'gpt-5.5': {
            inputTokens: 1000,
            cachedInputTokens: 1650,
            outputTokens: 100,
            totalTokens: 2750
          }
        },
        totalTokens: 3170,
        costUSD: 3.17
      }
    ]
  }
}

export function skewedMultiModelSessionResult() {
  return {
    sessions: [
      {
        sessionId: '2026/05/25/rollout-child-thread',
        lastActivity: '2026-05-25T01:10:00.000Z',
        totalTokens: 2112,
        costUSD: 2.112,
        models: {
          'gpt-5.4': {
            inputTokens: 10,
            cachedInputTokens: 1,
            outputTokens: 1,
            totalTokens: 12,
            costUSD: 0
          },
          'gpt-5.5': {
            inputTokens: 1000,
            cachedInputTokens: 1000,
            outputTokens: 100,
            totalTokens: 2100,
            costUSD: 0
          }
        }
      }
    ]
  }
}

export function skewedMultiModelDailyResult() {
  return {
    daily: [
      {
        date: '2026-05-25',
        models: {
          'gpt-5.4': {
            inputTokens: 10,
            cachedInputTokens: 1,
            outputTokens: 1,
            totalTokens: 12
          },
          'gpt-5.5': {
            inputTokens: 1000,
            cachedInputTokens: 1000,
            outputTokens: 100,
            totalTokens: 2100
          }
        },
        totalTokens: 2112,
        costUSD: 2.112
      }
    ]
  }
}

function tokenUsage(usage: UsageInput) {
  return {
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cacheReadTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens
  }
}
