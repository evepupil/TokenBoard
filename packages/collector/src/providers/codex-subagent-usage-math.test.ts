import { describe, expect, test } from 'vitest'
import { distributeMetric, sumMetrics, type Metric } from './codex-subagent-usage-math'

const baseMetric: Metric = {
  usageDate: '2026-05-25',
  model: 'gpt-5.4',
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  costUsd: 0
}

describe('Codex subagent usage metric math', () => {
  test('keeps aggregate metric metadata stable when summing multiple models', () => {
    const summed = sumMetrics([
      { ...baseMetric, model: 'gpt-5.4', totalTokens: 10 },
      { ...baseMetric, model: 'gpt-5.5', totalTokens: 20 }
    ])

    expect(summed).toMatchObject({
      usageDate: '2026-05-25',
      model: 'gpt-5.4',
      totalTokens: 30
    })
  })

  test('splits integer fields evenly when distributing to models with zero usage', () => {
    const [first, second] = distributeMetric(
      {
        ...baseMetric,
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 7,
        totalTokens: 11
      },
      [
        { ...baseMetric, model: 'gpt-5.4' },
        { ...baseMetric, model: 'gpt-5.5' }
      ]
    )

    expect(first).toMatchObject({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 4, totalTokens: 6 })
    expect(second).toMatchObject({ inputTokens: 2, outputTokens: 1, cacheReadTokens: 3, totalTokens: 5 })
  })
})
