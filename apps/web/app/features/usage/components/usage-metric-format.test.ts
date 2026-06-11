import { describe, expect, test } from 'vitest'
import { formatUsageMetricInteger, formatUsageMetricUsd } from './usage-metric-format'

describe('usage metric format', () => {
  test('keeps smaller integers exact', () => {
    expect(formatUsageMetricInteger(999_999)).toEqual({
      value: '999,999',
      exactValue: '999,999'
    })
  })

  test('uses compact units with Chinese magnitude detail for large integers', () => {
    expect(formatUsageMetricInteger(1_234_567)).toEqual({
      value: '1.23M',
      exactValue: '1,234,567',
      detail: '123.46万'
    })
    expect(formatUsageMetricInteger(9_027_123_784_974)).toEqual({
      value: '9.03T',
      exactValue: '9,027,123,784,974',
      detail: '9.03万亿'
    })
    expect(formatUsageMetricInteger(12_007_199_254_740_992)).toEqual({
      value: '12.01P',
      exactValue: '12,007,199,254,740,992',
      detail: '1.2京'
    })
  })

  test('promotes compact units when rounding reaches the next unit boundary', () => {
    expect(formatUsageMetricInteger(999_999_999)).toMatchObject({
      value: '1B',
      exactValue: '999,999,999'
    })
    expect(formatUsageMetricInteger(999_999_999_999)).toMatchObject({
      value: '1T',
      exactValue: '999,999,999,999'
    })
    expect(formatUsageMetricInteger(999_999_999_999_999)).toMatchObject({
      value: '1P',
      exactValue: '999,999,999,999,999'
    })
  })

  test('uses compact units for large USD values while keeping exact currency text', () => {
    expect(formatUsageMetricUsd(133_333_332_222.46)).toEqual({
      value: '$133.33B',
      exactValue: '$133,333,332,222.46',
      detail: '1333.33亿 USD'
    })
    expect(formatUsageMetricUsd(999_999_999.99)).toMatchObject({
      value: '$1B',
      exactValue: '$999,999,999.99'
    })
  })

  test('keeps the minus sign before the currency symbol for negative USD values', () => {
    expect(formatUsageMetricUsd(-1_500_000)).toEqual({
      value: '-$1.5M',
      exactValue: '-$1,500,000.00',
      detail: '-150万 USD'
    })
  })

  test('keeps signs for negative compact values', () => {
    expect(formatUsageMetricInteger(-1_500_000)).toEqual({
      value: '-1.5M',
      exactValue: '-1,500,000',
      detail: '-150万'
    })
  })
})
