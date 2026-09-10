import { describe, expect, test } from 'vitest'
import { billableCostSql } from './usage-cost'

describe('usage cost SQL', () => {
  test('uses zero cost for every Antigravity source', () => {
    expect(billableCostSql({ sourceColumn: 'usage.source', costColumn: 'usage.cost_usd' })).toBe(
      "CASE WHEN usage.source IN ('antigravity-cli', 'antigravity', 'antigravity-ide', 'grok-build', 'deepseek-harness') THEN 0 ELSE usage.cost_usd END"
    )
  })

  test('rejects SQL identifier injection in configurable columns', () => {
    expect(() => billableCostSql({ sourceColumn: 'source) OR 1=1 --' })).toThrow('Invalid SQL identifier')
    expect(() => billableCostSql({ costColumn: 'cost_usd, secret_column' })).toThrow('Invalid SQL identifier')
  })
})
