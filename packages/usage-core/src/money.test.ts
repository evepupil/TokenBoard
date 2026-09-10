import { describe, expect, test } from 'vitest'
import { roundUsd } from './money'

describe('USD rounding', () => {
  test.each([
    [0, 0],
    [1.23456, 1.2346],
    [0.000049, 0],
    [0.00005, 0.0001]
  ])('rounds %s to %s at four decimal places', (value, expected) => {
    expect(roundUsd(value)).toBe(expected)
  })
})
