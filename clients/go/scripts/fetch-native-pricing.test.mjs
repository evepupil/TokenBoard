import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  LITELLM_REV,
  LITELLM_SHA256,
  LITELLM_RAW_COUNT,
  LITELLM_EMBEDDED_COUNT,
  LITELLM_EMBEDDED_SHA256,
  CCUSAGE_VERSION,
  CCUSAGE_COMMIT,
  CCUSAGE_ASSETS,
  dataDir,
  verifySnapshot,
  isEmbeddedModel,
  filterLitellmSnapshot,
  compactLitellmSnapshot,
  canonicalJson,
  renderLitellmJson
} from './fetch-native-pricing.mjs'

test('the pinned revision and both digests are recorded in full', () => {
  assert.equal(LITELLM_REV, '6e0f0f7adb3083fb6681e636c947e3d6b8f53b26')
  assert.match(LITELLM_SHA256, /^[0-9a-f]{64}$/) // 原始文件
  assert.match(LITELLM_EMBEDDED_SHA256, /^[0-9a-f]{64}$/) // 过滤压缩后的产物
  assert.ok(Number.isInteger(LITELLM_EMBEDDED_COUNT) && LITELLM_EMBEDDED_COUNT > 0)
  assert.ok(Number.isInteger(LITELLM_RAW_COUNT) && LITELLM_RAW_COUNT > LITELLM_EMBEDDED_COUNT)
})

test('verifySnapshot rejects bytes whose digest differs', () => {
  assert.throws(() => verifySnapshot(Buffer.from('nope'), '0'.repeat(64)), /sha256/i)
})

test('filterLitellmSnapshot keeps only the prefixes ccusage embeds', () => {
  const filtered = filterLitellmSnapshot({
    'claude-opus-4-6': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6 },
    'gemini-2.5-pro': { input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6 },
    'openai/gpt-5': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 }
  })
  assert.deepEqual(Object.keys(filtered).sort(), ['claude-opus-4-6', 'openai/gpt-5'])
})

test('compactLitellmSnapshot renames fields and hoists service tiers', () => {
  const out = compactLitellmSnapshot({
    'gpt-x': {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
      cache_read_input_token_cost: 1e-7,
      max_input_tokens: 200000,
      provider_specific_entry: { fast: 2, flex: 0.5 }
    }
  })
  assert.deepEqual(out['gpt-x'], { i: 1e-6, o: 2e-6, cr: 1e-7, ctx: 200000, fast: 2, flex: 0.5 })
})

test('the ccusage asset pins name v20.0.33 and its full commit', () => {
  assert.equal(CCUSAGE_VERSION, '20.0.33')
  assert.equal(CCUSAGE_COMMIT, '1308c416a7da73b63463f953a51b5ae29fb784a4')
  assert.deepEqual(Object.keys(CCUSAGE_ASSETS).sort(), [
    'fast-multipliers.json',
    'flex-multipliers.json',
    'models-dev-catalog-rules.json',
    'models-dev-pricing.json'
  ])
  for (const [name, asset] of Object.entries(CCUSAGE_ASSETS)) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, name)
    assert.equal(asset.source, `rust/crates/ccusage-core/src/${asset.upstreamName}`, name)
  }
})

test('verifySnapshot returns the digest when it matches', () => {
  const bytes = Buffer.from('{"ok":true}')
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert.equal(verifySnapshot(bytes, digest), digest)
})

test('isEmbeddedModel mirrors the build.rs prefix and exact rules', () => {
  for (const key of [
    'claude-x',
    'anthropic.claude-x',
    'anthropic/claude-x',
    'us.anthropic.claude-x',
    'eu.anthropic.claude-x',
    'global.anthropic.claude-x',
    'jp.anthropic.claude-x',
    'au.anthropic.claude-x',
    'gpt-5',
    'o3',
    'o3-mini',
    'o4-mini',
    'o4-mini-high',
    'openai/gpt-5',
    'azure/gpt-5',
    'zai/glm-5',
    'openrouter/openai/gpt-5'
  ]) {
    assert.ok(isEmbeddedModel(key), key)
  }
  for (const key of ['gemini-2.5-pro', 'o3x', 'o4', 'o4-min', 'GPT-5', 'x-claude-x', 'openrouter/anthropic/claude-x']) {
    assert.equal(isEmbeddedModel(key), false, key)
  }
})

test('compactLitellmSnapshot drops nulls and entries missing i or o', () => {
  const out = compactLitellmSnapshot({
    'gpt-full': {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
      cache_creation_input_token_cost: null,
      input_cost_per_token_above_200k_tokens: 2e-6,
      provider_specific_entry: { fast: null, flex: 0.25 }
    },
    'gpt-image': { input_cost_per_token: null, output_cost_per_token: 2e-6 },
    'gpt-input-only': { input_cost_per_token: 1e-6 },
    'not-an-object': 'x'
  })
  assert.deepEqual(Object.keys(out), ['gpt-full'])
  assert.deepEqual(out['gpt-full'], { i: 1e-6, o: 2e-6, ia: 2e-6, flex: 0.25 })
})

test('renderLitellmJson is canonical, newline terminated and stable on re-render', () => {
  const compact = { b: { i: 1, o: 2 }, a: { i: 3, o: 4, flex: 0.5 } }
  assert.equal(renderLitellmJson(compact), `${canonicalJson(compact)}\n`)
  assert.equal(renderLitellmJson(JSON.parse(renderLitellmJson(compact))), renderLitellmJson(compact))
})

test('dataDir resolves from this script, not the working directory', () => {
  assert.equal(dataDir, join(dirname(fileURLToPath(import.meta.url)), '..', 'internal', 'nativepricing', 'data'))
})

test('the vendored data directory matches the pinned digests', () => {
  const litellm = readFileSync(join(dataDir, 'litellm.json'))
  assert.equal(createHash('sha256').update(litellm).digest('hex'), LITELLM_EMBEDDED_SHA256)
  assert.equal(Object.keys(JSON.parse(litellm)).length, LITELLM_EMBEDDED_COUNT)
  for (const [name, asset] of Object.entries(CCUSAGE_ASSETS)) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(dataDir, name)))
        .digest('hex'),
      asset.sha256,
      name
    )
  }
})
