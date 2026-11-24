import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

// node --experimental-strip-types cannot import a .ts file whose relative
// imports are extensionless, and a temp-dir copy loses node_modules (zod)
// resolution. Materialise the patched schema (extensionful imports) inside
// packages/usage-core where zod resolves, import it, then remove the copy.
// Every relative sibling import is patched, not just `./dates`: a second one
// (`./timezone`) was added and the blind spot only failed in CI.
const usageCoreSrc = new URL('../packages/usage-core/src/', import.meta.url)
const schemaSource = readFileSync(new URL('schema.ts', usageCoreSrc), 'utf8')
const patchedPath = new URL('.goldens-tmp-schema.ts', usageCoreSrc)
writeFileSync(patchedPath, schemaSource.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.ts'"))
let snapshotHashPayload, snapshotKey
try {
  ;({ snapshotHashPayload, snapshotKey } = await import(patchedPath.href))
} finally {
  unlinkSync(patchedPath)
}

// Golden cases: full snapshot, correction present, costUnavailable source,
// zero-valued fields, unicode model name, extreme-but-valid numbers.
const base = {
  source: 'codex',
  usageDate: '2026-05-09',
  timezone: 'Asia/Shanghai',
  model: 'gpt-5',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 5,
  totalTokens: 17,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: '2026-05-09T10:00:00.000Z'
}
const cases = [
  { name: 'base', snapshot: base },
  { name: 'with-correction', snapshot: { ...base, correction: 'codex-context-pricing' } },
  { name: 'cost-unavailable-grok', snapshot: { ...base, source: 'grok-build', costUsd: 0 } },
  {
    name: 'all-zero',
    snapshot: {
      ...base,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      sessionCount: 0
    }
  },
  { name: 'unicode-model', snapshot: { ...base, model: 'módel/中文-模型' } },
  { name: 'extreme-tokens', snapshot: { ...base, totalTokens: 1000000000000, inputTokens: 1000000000000 } },
  { name: 'fractional-cost', snapshot: { ...base, costUsd: 0.1 + 0.2 } },
  { name: 'tiny-cost-exp', snapshot: { ...base, costUsd: 1e-7 } },
  { name: 'tiny-cost-fixed', snapshot: { ...base, costUsd: 5e-7 } },
  { name: 'timezone-etc-gmt', snapshot: { ...base, timezone: 'Etc/GMT+5' } }
]
console.log(
  JSON.stringify(
    cases.map((c) => ({
      name: c.name,
      key: snapshotKey(c.snapshot),
      hashPayload: snapshotHashPayload(c.snapshot)
    })),
    null,
    2
  )
)
