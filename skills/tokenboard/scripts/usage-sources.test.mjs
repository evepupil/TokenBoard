import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ccusageToolSources, usageSources } from './usage-sources.mjs'

const schemaPath = fileURLToPath(new URL('../../../packages/usage-core/src/schema.ts', import.meta.url))

// The skill scripts cannot import @tokenboard/usage-core: they run from a git
// checkout before any build, often on a machine where the workspace was never
// installed. usage-sources.mjs is therefore a hand-kept mirror, and every
// consumer of it (the retry lock guard set, the dual-run source list) goes
// silently incomplete when the mirror lags. Parsing the declaration is what
// turns that into a red test — the failure mode this exists for is a source
// that collects fine but is never compared or mutually excluded.
function readDeclarationArray(source, name) {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`, 'm').exec(source)
  assert.ok(match, `usage-core must still declare a flat ${name} array`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
}

test('the skill source list matches usage-core', () => {
  const declared = readDeclarationArray(readFileSync(schemaPath, 'utf8'), 'usageSources')
  assert.deepEqual(
    usageSources,
    declared,
    'skills/tokenboard/scripts/usage-sources.mjs must mirror usageSources in declaration order'
  )
})

test('the skill ccusage tool list matches usage-core', () => {
  const declared = readDeclarationArray(readFileSync(schemaPath, 'utf8'), 'ccusageToolSources')
  assert.deepEqual(ccusageToolSources, declared)
})

test('the ccusage tool list is a subset of the source list', () => {
  const known = new Set(usageSources)
  for (const source of ccusageToolSources) {
    assert.ok(known.has(source), `${source} is listed as a ccusage tool but is not a source`)
  }
  assert.equal(new Set(usageSources).size, usageSources.length, 'usageSources contains a duplicate')
})
