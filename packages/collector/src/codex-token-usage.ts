export type CodexTokenUsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  explicitTotalTokens?: number
}

// Codex has emitted totals that either include cached input in input_tokens or
// report cached input as an additional field. Keep explicit totals when they
// are sufficient, but never let an inconsistent total violate the snapshot
// contract or discard tokens that are present in the component fields.
export function normalizeCodexTotalTokens(input: CodexTokenUsageTotals) {
  const additiveTotal = input.inputTokens + input.outputTokens + input.cacheCreationTokens + input.cacheReadTokens

  if (input.explicitTotalTokens === undefined || input.explicitTotalTokens <= 0) {
    return additiveTotal
  }

  // When cached input is reported separately (larger than input_tokens), all
  // component fields must be included to avoid dropping those tokens. In the
  // other representation input_tokens already contains cached input, and a
  // positive explicit total is authoritative when it is at least the base
  // input/output total. Older malformed rows with a lower explicit total are
  // still raised to the minimum that preserves the separately reported cache
  // creation tokens.
  if (input.cacheReadTokens > input.inputTokens) {
    return Math.max(input.explicitTotalTokens, additiveTotal)
  }

  const baseTotal = input.inputTokens + input.outputTokens
  if (input.explicitTotalTokens >= baseTotal) return input.explicitTotalTokens
  return Math.max(input.explicitTotalTokens, baseTotal + input.cacheCreationTokens)
}
