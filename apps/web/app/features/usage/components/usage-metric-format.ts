import { formatUsd } from '../../../lib/money'

const compactThreshold = 1_000_000

const compactUnits = [
  { value: 1_000_000_000_000_000, suffix: 'P' },
  { value: 1_000_000_000_000, suffix: 'T' },
  { value: 1_000_000_000, suffix: 'B' },
  { value: 1_000_000, suffix: 'M' }
] as const
const smallestCompactUnit = compactUnits[compactUnits.length - 1]
const compactMaximumUnitValue = 1_000
const compactFractionDigits = 2
const compactRoundingFactor = 10 ** compactFractionDigits

export type UsageMetricValue = {
  value: string
  exactValue: string
  detail?: string
}

export function formatUsageMetricInteger(value: number): UsageMetricValue {
  const exactValue = formatInteger(value)
  if (Math.abs(value) < compactThreshold) return { value: exactValue, exactValue }

  return {
    value: compactNumber(value),
    exactValue,
    detail: chineseMagnitude(value)
  }
}

export function formatUsageMetricUsd(value: number): UsageMetricValue {
  const exactValue = formatUsd(value)
  if (Math.abs(value) < compactThreshold) return { value: exactValue, exactValue }

  return {
    value: compactUsd(value),
    exactValue,
    detail: `${chineseMagnitude(value)} USD`
  }
}

function compactUsd(value: number) {
  return value < 0
    ? `-$${compactNumber(Math.abs(value))}`
    : `$${compactNumber(value)}`
}

function compactNumber(value: number) {
  const absValue = Math.abs(value)
  const unit = compactUnitForRoundedValue(absValue)
  const prefix = value < 0 ? '-' : ''
  return `${prefix}${formatDecimal(absValue / unit.value)}${unit.suffix}`
}

function compactUnitForRoundedValue(absValue: number) {
  let unitIndex = compactUnits.findIndex((item) => absValue >= item.value)
  if (unitIndex < 0) unitIndex = compactUnits.length - 1

  while (
    unitIndex > 0 &&
    roundCompactValue(absValue / compactUnits[unitIndex].value) >= compactMaximumUnitValue
  ) {
    unitIndex -= 1
  }

  return compactUnits[unitIndex] ?? smallestCompactUnit
}

function roundCompactValue(value: number) {
  return Math.round(value * compactRoundingFactor) / compactRoundingFactor
}

function chineseMagnitude(value: number) {
  const absValue = Math.abs(value)
  const prefix = value < 0 ? '-' : ''
  if (absValue >= 10_000_000_000_000_000) return `${prefix}${formatChineseDecimal(absValue / 10_000_000_000_000_000)}京`
  if (absValue >= 1_000_000_000_000) return `${prefix}${formatChineseDecimal(absValue / 1_000_000_000_000)}万亿`
  if (absValue >= 100_000_000) return `${prefix}${formatChineseDecimal(absValue / 100_000_000)}亿`
  if (absValue >= 10_000) return `${prefix}${formatChineseDecimal(absValue / 10_000)}万`
  return formatInteger(value)
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatDecimal(value: number) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  }).format(value)
}

function formatChineseDecimal(value: number) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
    useGrouping: false
  }).format(value)
}
