import { costUnavailableSources } from '@tokenboard/usage-core'

/** SQL literal list derived from the canonical usage-core source contract. */
export const costUnavailableSourcesSql = costUnavailableSources.map((source) => `'${source}'`).join(', ')

const sqlIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/

export function billableCostSql(input?: { sourceColumn?: string; costColumn?: string }) {
  const sourceColumn = input?.sourceColumn ?? 'source'
  const costColumn = input?.costColumn ?? 'cost_usd'
  assertSqlIdentifier('sourceColumn', sourceColumn)
  assertSqlIdentifier('costColumn', costColumn)
  return `CASE WHEN ${sourceColumn} IN (${costUnavailableSourcesSql}) THEN 0 ELSE ${costColumn} END`
}

function assertSqlIdentifier(name: string, value: string) {
  if (!sqlIdentifierPattern.test(value)) {
    throw new Error(`Invalid SQL identifier for ${name}`)
  }
}
