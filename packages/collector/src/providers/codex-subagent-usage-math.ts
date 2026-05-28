export type Metric = {
  usageDate: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  costUsd: number
}

export function addMetric(adjustments: Map<string, Metric>, metric: Metric) {
  const key = snapshotKey(metric)
  const current = adjustments.get(key)
  if (!current) {
    adjustments.set(key, { ...metric })
    return
  }
  current.inputTokens += metric.inputTokens
  current.outputTokens += metric.outputTokens
  current.cacheCreationTokens += metric.cacheCreationTokens
  current.cacheReadTokens += metric.cacheReadTokens
  current.totalTokens += metric.totalTokens
  current.costUsd += metric.costUsd
}

export function subtractMetric(left: Metric, right: Metric): Metric {
  const key = `${left.usageDate}/${left.model}`
  return {
    usageDate: left.usageDate,
    model: left.model,
    inputTokens: subtractNonNegative(left.inputTokens, right.inputTokens, key),
    outputTokens: subtractNonNegative(left.outputTokens, right.outputTokens, key),
    cacheCreationTokens: subtractNonNegative(left.cacheCreationTokens, right.cacheCreationTokens, key),
    cacheReadTokens: subtractNonNegative(left.cacheReadTokens, right.cacheReadTokens, key),
    totalTokens: subtractNonNegative(left.totalTokens, right.totalTokens, key),
    costUsd: subtractNonNegative(left.costUsd, right.costUsd, key)
  }
}

export function sumMetrics(metrics: Metric[]): Metric {
  if (metrics.length === 0) throw new Error('Codex subagent session row has no model metrics')
  const first = metrics[0]
  return metrics.reduce((total, metric) => ({
    usageDate: first.usageDate,
    model: first.model,
    inputTokens: total.inputTokens + metric.inputTokens,
    outputTokens: total.outputTokens + metric.outputTokens,
    cacheCreationTokens: total.cacheCreationTokens + metric.cacheCreationTokens,
    cacheReadTokens: total.cacheReadTokens + metric.cacheReadTokens,
    totalTokens: total.totalTokens + metric.totalTokens,
    costUsd: total.costUsd + metric.costUsd
  }), { ...first, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUsd: 0 })
}

export function distributeMetric(total: Metric, originals: Metric[]) {
  const weights = originals.map((metric) => metric.totalTokens)
  const inputTokens = splitInteger(total.inputTokens, weights)
  const outputTokens = splitInteger(total.outputTokens, weights)
  const cacheCreationTokens = splitInteger(total.cacheCreationTokens, weights)
  const cacheReadTokens = splitInteger(total.cacheReadTokens, weights)
  const totalTokens = splitInteger(total.totalTokens, weights)
  const weightSum = sumWeights(weights)
  return originals.map((original, index) => ({
    ...original,
    inputTokens: inputTokens[index],
    outputTokens: outputTokens[index],
    cacheCreationTokens: cacheCreationTokens[index],
    cacheReadTokens: cacheReadTokens[index],
    totalTokens: totalTokens[index],
    costUsd: prorateCost(total.costUsd, original.totalTokens, weightSum)
  }))
}

export function prorateCost(costUsd: number, correctedTokens: number, originalTokens: number) {
  return originalTokens > 0 ? costUsd * (correctedTokens / originalTokens) : 0
}

export function subtractNonNegative(left: number, right: number, label: string) {
  const value = left - right
  if (value < -0.000001) throw new Error(`Codex subagent usage correction exceeded ${label}`)
  return value > 0 ? value : 0
}

export function snapshotKey(input: { usageDate: string; model: string }) {
  return `${input.usageDate}\0${input.model}`
}

function splitInteger(total: number, weights: number[]) {
  if (weights.length === 0) return []
  const weightSum = sumWeights(weights)
  if (weightSum === 0) return splitEvenly(total, weights.length)
  let remaining = total
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return remaining
    const value = Math.floor(total * (weight / weightSum))
    remaining -= value
    return value
  })
}

function splitEvenly(total: number, count: number) {
  const base = Math.floor(total / count)
  const remainder = total - base * count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

function sumWeights(weights: number[]) {
  return weights.reduce((total, value) => total + value, 0)
}
