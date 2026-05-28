export function codexDisplayDateDailyInput() {
  return {
    daily: [
      {
        date: 'Apr 28, 2026',
        inputTokens: 63578474,
        cachedInputTokens: 58842240,
        outputTokens: 250965,
        totalTokens: 63829439,
        costUSD: 18.860285,
        models: {
          'gpt-5.4': {
            inputTokens: 6663074,
            cachedInputTokens: 4871680,
            outputTokens: 45372,
            totalTokens: 6708446
          },
          'gpt-5.5': {
            inputTokens: 56915400,
            cachedInputTokens: 53970560,
            outputTokens: 205593,
            totalTokens: 57120993
          }
        }
      }
    ]
  }
}

export function multiModelSessionCountInput() {
  return {
    data: [
      {
        date: '2026-04-28',
        modelBreakdowns: [
          {
            modelName: 'claude-sonnet',
            inputTokens: 100,
            outputTokens: 10
          },
          {
            modelName: 'claude-opus',
            inputTokens: 200,
            outputTokens: 20
          }
        ]
      }
    ]
  }
}

export function multiModelSessionRows() {
  return {
    data: [
      {
        sessionId: 's1',
        lastActivity: '2026-04-28T10:00:00.000Z',
        modelBreakdowns: {
          'claude-sonnet': {
            inputTokens: 100,
            outputTokens: 10
          }
        }
      },
      {
        sessionId: 's2',
        lastActivity: '2026-04-28T11:00:00.000Z',
        modelBreakdowns: {
          'claude-opus': {
            inputTokens: 200,
            outputTokens: 20
          }
        }
      },
      {
        sessionId: 's3',
        lastActivity: '2026-04-28T12:00:00.000Z',
        modelBreakdowns: {
          'claude-sonnet': {
            inputTokens: 30,
            outputTokens: 3
          },
          'claude-opus': {
            inputTokens: 40,
            outputTokens: 4
          }
        }
      }
    ]
  }
}
