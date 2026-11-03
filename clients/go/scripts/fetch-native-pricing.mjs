#!/usr/bin/env node
// Regenerates the frozen pricing corpus embedded by internal/nativepricing.
//
// The corpus is ccusage v20.0.33's (commit 1308c416) embedded set. ccusage
// builds four of its assets by copying them out of its own crate, and builds
// the fifth (the LiteLLM snapshot) at compile time from the revision its
// flake.lock pins: `build.rs` filters it through `is_embedded_model`, renames
// each pricing field to a short key and drops entries without both an input
// and an output rate. This script redoes exactly that, and pins the sha256 of
// both the raw download and the vendored artifact so a silent upstream or
// procedural drift fails instead of changing prices.
//
// Usage:
//   node clients/go/scripts/fetch-native-pricing.mjs                # download the pinned rev
//   node clients/go/scripts/fetch-native-pricing.mjs --from P       # use a local copy instead
//   node clients/go/scripts/fetch-native-pricing.mjs --ccusage-repo R --copy-ccusage-assets
//                                                                   # refresh the ccusage assets too
//
// --print writes the candidate artifact to stdout instead of data/, which is
// what a digest mismatch asks for when a pin has to be re-recorded on purpose.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// LiteLLM revision pinned by ccusage v20.0.33's flake.lock (nodes.litellm).
export const LITELLM_REV = '6e0f0f7adb3083fb6681e636c947e3d6b8f53b26'
export const LITELLM_URL = `https://raw.githubusercontent.com/BerriAI/litellm/${LITELLM_REV}/model_prices_and_context_window.json`
// sha256 of the raw model_prices_and_context_window.json at that revision.
export const LITELLM_SHA256 = 'c718a7b2f7a8d1009cb3bcf65c3c060cd453845f21dc0b96e822aa3e949c4d54'
// Top-level keys in the raw snapshot.
export const LITELLM_RAW_COUNT = 4116
// sha256 and entry count of data/litellm.json, i.e. after the filter + compaction.
export const LITELLM_EMBEDDED_SHA256 = '26ed028a888c8fdea37917dfd85ec17875e86c4002586f0c2239a1fc2dc7b4d8'
export const LITELLM_EMBEDDED_COUNT = 534

export const CCUSAGE_VERSION = '20.0.33'
export const CCUSAGE_COMMIT = '1308c416a7da73b63463f953a51b5ae29fb784a4'

const LITELLM_FIELD_MAP = [
  ['input_cost_per_token', 'i'],
  ['output_cost_per_token', 'o'],
  ['cache_creation_input_token_cost', 'cc'],
  ['cache_read_input_token_cost', 'cr'],
  ['input_cost_per_token_above_200k_tokens', 'ia'],
  ['output_cost_per_token_above_200k_tokens', 'oa'],
  ['cache_creation_input_token_cost_above_200k_tokens', 'cca'],
  ['cache_read_input_token_cost_above_200k_tokens', 'cra'],
  ['max_input_tokens', 'ctx']
]

// build.rs `is_embedded_model`, in the same order.
const EMBEDDED_PREFIXES = [
  'claude-',
  'anthropic.',
  'anthropic/',
  'us.anthropic.',
  'eu.anthropic.',
  'global.anthropic.',
  'jp.anthropic.',
  'au.anthropic.',
  'gpt-',
  'openai/',
  'azure/',
  'zai/',
  'openrouter/openai/'
]

export const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'internal', 'nativepricing', 'data')

// The four assets ccusage copies from its own crate into the build, keyed by
// their vendored name in data/.
export const CCUSAGE_ASSETS = {
  'fast-multipliers.json': {
    upstreamName: 'fast-multiplier-overrides.json',
    source: 'rust/crates/ccusage-core/src/fast-multiplier-overrides.json',
    sha256: 'f055ffafcf93bc164a0fe071bb462d17c5d888ddf2314ce876cba12fd1f67c42'
  },
  'flex-multipliers.json': {
    upstreamName: 'flex-multiplier-overrides.json',
    source: 'rust/crates/ccusage-core/src/flex-multiplier-overrides.json',
    sha256: '6d144c1f2fbc982d19822fd0f860d5b515c9baf58a78180095a32598553ccbf1'
  },
  'models-dev-catalog-rules.json': {
    upstreamName: 'models-dev-catalog-rules.json',
    source: 'rust/crates/ccusage-core/src/models-dev-catalog-rules.json',
    sha256: '467e09d89caf77f6fa2870ce4f33f4f194224a9d20e1459ea2229783fea074d8'
  },
  'models-dev-pricing.json': {
    upstreamName: 'models-dev-pricing.json',
    source: 'rust/crates/ccusage-core/src/models-dev-pricing.json',
    sha256: '672efd68ea4e65f30050b1722c1bc7e78bcfb818ba6af5b9f333010092c1b2f0'
  }
}

export function isEmbeddedModel(model) {
  return (
    model === 'o3' ||
    model.startsWith('o3-') ||
    model === 'o4-mini' ||
    model.startsWith('o4-mini-') ||
    EMBEDDED_PREFIXES.some((prefix) => model.startsWith(prefix))
  )
}

export function verifySnapshot(bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`)
  }
  return actual
}

// build.rs `compact_pricing_json` minus the compaction step: the entries whose
// key passes `is_embedded_model`.
export function filterLitellmSnapshot(snapshot) {
  const filtered = {}
  for (const [model, pricing] of Object.entries(snapshot)) {
    if (!isEmbeddedModel(model)) continue
    if (pricing === null || typeof pricing !== 'object' || Array.isArray(pricing)) continue
    filtered[model] = pricing
  }
  return filtered
}

// build.rs `compact_pricing_json`: short keys preserve insertion order (the
// order below), nulls are skipped, `provider_specific_entry.{fast,flex}` are
// hoisted, and an entry survives only with both `i` and `o`.
export function compactLitellmSnapshot(snapshot) {
  const compact = {}
  for (const [model, pricing] of Object.entries(snapshot)) {
    if (pricing === null || typeof pricing !== 'object' || Array.isArray(pricing)) continue
    const fields = {}
    for (const [source, target] of LITELLM_FIELD_MAP) {
      const value = pricing[source]
      if (value === undefined || value === null) continue
      fields[target] = value
    }
    const entry = pricing.provider_specific_entry
    for (const tier of ['fast', 'flex']) {
      const value = entry !== null && typeof entry === 'object' ? entry[tier] : undefined
      if (value === undefined || value === null) continue
      fields[tier] = value
    }
    if ('i' in fields && 'o' in fields) compact[model] = fields
  }
  return compact
}

// Recursively key-sorted JSON. The artifact is a committed binary-ish asset
// that Prettier must not reflow (see .prettierignore), so its byte layout is
// this function's; sorting makes it independent of upstream key order.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function renderLitellmJson(compact) {
  return `${canonicalJson(compact)}\n`
}

export function writeIfChanged(path, bytes) {
  const next = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
  try {
    if (readFileSync(path).equals(next)) return false
  } catch {
    // Missing file: write it below.
  }
  const temporary = `${path}.tmp`
  writeFileSync(temporary, next)
  renameSync(temporary, path)
  return true
}

async function download(url, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`download ${url} failed: ${lastError?.message ?? lastError}`)
}

function parseArgs(argv) {
  const options = { from: undefined, ccusageRepo: undefined, ccusageAssets: false, print: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${argument} needs a value`)
      index += 1
      return next
    }
    if (argument === '--from') options.from = value()
    else if (argument === '--ccusage-repo') options.ccusageRepo = value()
    else if (argument === '--copy-ccusage-assets') options.ccusageAssets = true
    else if (argument === '--print') options.print = true
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

async function main(argv) {
  const options = parseArgs(argv)
  // Under --print the artifact owns stdout, so every log line goes to stderr.
  const log = options.print ? console.error : console.log
  const raw = options.from ? readFileSync(options.from) : await download(LITELLM_URL)
  const rawDigest = createHash('sha256').update(raw).digest('hex')
  const snapshot = JSON.parse(raw.toString('utf8'))
  const compact = compactLitellmSnapshot(filterLitellmSnapshot(snapshot))
  const artifact = renderLitellmJson(compact)
  const embeddedDigest = createHash('sha256').update(artifact).digest('hex')
  const embeddedCount = Object.keys(compact).length

  log(`litellm rev        ${LITELLM_REV}`)
  log(`raw source         ${options.from ? options.from : LITELLM_URL}`)
  log(`raw sha256         ${rawDigest}`)
  log(`raw entries        ${Object.keys(snapshot).length}`)
  log(`artifact sha256    ${embeddedDigest}`)
  log(`artifact entries   ${embeddedCount}`)

  const drift = []
  const check = (label, actual, expected) => {
    if (actual !== expected) drift.push(`${label}: expected ${expected}, got ${actual}`)
  }
  check('LITELLM_SHA256', rawDigest, LITELLM_SHA256)
  check('LITELLM_EMBEDDED_SHA256', embeddedDigest, LITELLM_EMBEDDED_SHA256)
  check('LITELLM_EMBEDDED_COUNT', embeddedCount, LITELLM_EMBEDDED_COUNT)

  if (options.ccusageRepo) {
    for (const [name, asset] of Object.entries(CCUSAGE_ASSETS)) {
      const digest = createHash('sha256')
        .update(readFileSync(join(options.ccusageRepo, asset.source)))
        .digest('hex')
      check(`CCUSAGE_ASSETS[${name}]`, digest, asset.sha256)
    }
  }

  if (options.print) {
    process.stdout.write(artifact)
  } else if (drift.length > 0) {
    // Writing past a digest mismatch would replace a pinned corpus with
    // whatever the network happened to serve. Print the candidate with
    // `--print`, review the diff, and re-record the constants on purpose.
    for (const line of drift) console.error(`mismatch ${line}`)
    console.error('refusing to write data/litellm.json; re-run with --print to inspect the candidate')
    process.exitCode = 1
    return
  } else {
    mkdirSync(dataDir, { recursive: true })
    const changed = writeIfChanged(join(dataDir, 'litellm.json'), artifact)
    log(`wrote              data/litellm.json${changed ? '' : ' (unchanged)'}`)
  }

  if (options.ccusageAssets) {
    if (!options.ccusageRepo) throw new Error('--copy-ccusage-assets needs --ccusage-repo')
    for (const [name, asset] of Object.entries(CCUSAGE_ASSETS)) {
      const bytes = readFileSync(join(options.ccusageRepo, asset.source))
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== asset.sha256) {
        throw new Error(`${name} differs from the recorded pin (${digest}); record the new pin on purpose first`)
      }
      const changed = writeIfChanged(join(dataDir, name), bytes)
      log(`copied             data/${name}${changed ? '' : ' (unchanged)'}`)
    }
  }

  if (drift.length > 0) {
    for (const line of drift) console.error(`mismatch ${line}`)
    console.error('the corpus does not match its pins')
    process.exitCode = 1
  }
}

// isMainModule compares canonical paths so the guard works through symlinks
// (plain import.meta.url === pathToFileURL(process.argv[1]).href exits 0 silently).
function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === fileURLToPath(importMetaUrl)
  } catch {
    return false
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
