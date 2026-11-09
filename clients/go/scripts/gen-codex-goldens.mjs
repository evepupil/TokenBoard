#!/usr/bin/env node
/**
 * gen-codex-goldens.mjs — mint the Codex adapter's row-level goldens from a
 * real ccusage 20.0.33 binary.
 *
 * The goldens are the end-to-end anchor for clients/go/internal/collect/
 * adapters/codex. The fixture tree is committed at testdata/codex-fixture/
 * (regenerable with testdata/build-codex-fixture.mjs): this script READS it —
 * it never rebuilds the tree, so a corrupted tree cannot silently mint new
 * goldens — and freezes the reports a real ccusage 20.0.33 binary produces
 * over it. goldens_test.go recomputes the fixtureSha256 below from the same
 * committed tree and compares the adapter's output against these reports.
 *
 * Every report the adapter serves the provider is covered:
 *
 *   codex daily --json --offline --single-thread -z UTC -s <since> -u <until>
 *   codex session --json --offline --single-thread -z UTC -s <since> -u <until>
 *   ... both again with --mode calculate
 *   ... and an unbounded daily without a window
 *
 * Four details are load-bearing:
 *
 *   1. NO `--config`. This corpus mints ADAPTER parity goldens and the Go test
 *      bills from the embedded corpus with no overrides. A config would apply
 *      defaults.pricingOverrides on the ccusage side only. The discovery
 *      checks below exist because without --config ccusage silently loads
 *      ~/.claude/ccusage.json or ./.ccusage/ccusage.json.
 *   2. `--offline` is REQUIRED: without it ccusage fetches the day's live prices
 *      and the goldens drift daily. Codex runs offline in production already.
 *   3. The child runs with HOME / XDG_CONFIG_HOME / CLAUDE_CONFIG_DIR pointing at
 *      an empty scratch directory, so neither the user's Codex config nor a
 *      user-level ccusage config can change the report.
 *   4. The window ends before "today": a live session directory is not part of
 *      this corpus.
 *
 * Usage:
 *   node clients/go/scripts/gen-codex-goldens.mjs
 *   node clients/go/scripts/gen-codex-goldens.mjs --check   # drift gate, no write
 *   CCUSAGE_BIN=/path/to/ccusage node clients/go/scripts/gen-codex-goldens.mjs
 *
 * Output: clients/go/internal/collect/adapters/codex/goldens/codex-reports.json
 *
 * The script is byte-stable: two consecutive runs produce identical files.
 * `--check` re-mints in memory, compares against the committed file and exits
 * non-zero on drift; scripts/check-deps.sh runs it so a ccusage output change
 * cannot leave the adapter goldens stale in CI.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scrubbedEnv } from './child-env.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..', '..', '..')
const adapterDir = join(repoRoot, 'clients', 'go', 'internal', 'collect', 'adapters', 'codex')
const fixtureDir = join(adapterDir, 'testdata', 'codex-fixture')
const goldensDir = join(adapterDir, 'goldens')
const goldensPath = join(goldensDir, 'codex-reports.json')

const ccusageBin = process.env.CCUSAGE_BIN || join(homedir(), '.tokenboard', 'bin', 'ccusage')

const checkOnly = process.argv.includes('--check')
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--check')
if (unknownArgs.length > 0) {
  fail(`unknown arguments: ${unknownArgs.join(' ')} (only --check is accepted)`)
}

/** The binary this corpus was frozen against (the adapter headers' commit). */
const expectedVersion = '20.0.33'
/** The window every windowed report passes; it covers every fixture date (2026-05-18..05-28). */
const since = '20260518'
const until = '20260528'
const timezone = 'UTC'

function fail(message) {
  console.error(`gen-codex-goldens: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. Version pin.
// ---------------------------------------------------------------------------
let versionOutput
try {
  versionOutput = execFileSync(ccusageBin, ['--version'], { encoding: 'utf8' }).trim()
} catch (error) {
  console.error(`gen-codex-goldens: cannot run ${ccusageBin}: ${error.message}`)
  console.error('  Pass the binary through CCUSAGE_BIN, or install ccusage ' + expectedVersion + '.')
  process.exit(1)
}
if (versionOutput !== `ccusage ${expectedVersion}`) {
  fail(
    `version drift — the goldens are frozen against "ccusage ${expectedVersion}", ` +
      `${ccusageBin} reports "${versionOutput}".`
  )
}

// ---------------------------------------------------------------------------
// 2. Clean environment.
// ---------------------------------------------------------------------------
const aliasValue = process.env.CCUSAGE_MODEL_ALIASES
if (aliasValue !== undefined && aliasValue !== '') {
  fail(
    `CCUSAGE_MODEL_ALIASES is set to ${JSON.stringify(aliasValue)}; the goldens must be ` +
      'minted with an empty alias table so model names match the fixture verbatim.'
  )
}
const forbiddenConfigs = [
  join(homedir(), '.claude', 'ccusage.json'),
  join(homedir(), '.config', 'claude', 'ccusage.json'),
  join(repoRoot, '.ccusage', 'ccusage.json'),
  // The child runs in an empty cwd below; this names the file that would matter
  // if someone ran ccusage by hand from the repository root.
  join(process.cwd(), '.ccusage', 'ccusage.json')
]
for (const path of new Set(forbiddenConfigs)) {
  if (existsSync(path)) {
    fail(
      `${path} exists; ccusage would apply it and the goldens would not match a ` +
        'no-override Collect. Move it aside and rerun.'
    )
  }
}

// The child runs in an empty directory so no cwd-relative config is discovered,
// with HOME-like variables pointed at another empty directory so neither the
// user's ~/.codex/config.toml (service tier) nor a user-level ccusage config
// can reach it.
const scratch = mkdtempSync(join(tmpdir(), 'tb-codex-goldens-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
const childCwd = join(scratch, 'cwd')
const childHome = join(scratch, 'home')
mkdirSync(childCwd)
mkdirSync(childHome)

// ---------------------------------------------------------------------------
// 3. The committed fixture tree.
//
// It is read, not rebuilt: building it here would let a corrupted tree mint new
// goldens without anyone noticing. testdata/build-codex-fixture.mjs regenerates
// it for review.
// ---------------------------------------------------------------------------
if (!existsSync(join(fixtureDir, 'sessions')) || !existsSync(join(fixtureDir, 'archived_sessions'))) {
  fail(`fixture tree ${fixtureDir} is missing sessions/ or archived_sessions/.`)
}

/** Every file under dir, as paths relative to dir with "/" separators, sorted. */
function relativeFiles(dir, base = dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...relativeFiles(path, base))
    } else if (entry.isFile()) {
      files.push(relative(base, path).split(sep).join('/'))
    } else {
      fail(`${path} is neither a regular file nor a directory.`)
    }
  }
  return files.sort()
}

// ---------------------------------------------------------------------------
// 4. The reports.
// ---------------------------------------------------------------------------
function reportArgs(report, extra) {
  return ['codex', report, '--json', '--offline', '--single-thread', '-z', timezone, '-s', since, '-u', until, ...extra]
}

const commands = [
  { mode: 'auto', argv: reportArgs('daily', ['--mode', 'auto']) },
  { mode: 'calculate', argv: reportArgs('daily', ['--mode', 'calculate']) },
  { mode: 'session', argv: reportArgs('session', []) },
  { mode: 'unbounded', argv: ['codex', 'daily', '--json', '--offline', '--single-thread', '-z', timezone] }
]

function run(argv, label) {
  let stdout
  try {
    stdout = execFileSync(ccusageBin, argv, {
      cwd: childCwd,
      // Third-party binary: never let it read the collector credentials.
      env: {
        ...scrubbedEnv(),
        CODEX_HOME: fixtureDir,
        HOME: childHome,
        USERPROFILE: childHome,
        XDG_CONFIG_HOME: join(childHome, '.config'),
        CLAUDE_CONFIG_DIR: childHome,
        CCUSAGE_MODEL_ALIASES: ''
      },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })
  } catch (error) {
    console.error(`gen-codex-goldens: ccusage (${label}) failed: ${error.message}`)
    if (error.stderr) console.error(error.stderr.toString())
    process.exit(1)
  }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    fail(`ccusage (${label}) did not print parseable JSON: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    fail(`ccusage (${label}) printed ${JSON.stringify(parsed)}, want a JSON object.`)
  }
  return parsed
}

const reports = {}
for (const command of commands) {
  reports[command.mode] = run(command.argv, command.mode)
}

// Every windowed report must carry rows: an empty report is the symptom of a
// fixture line ccusage could not read, not something to freeze.
for (const command of commands) {
  const rows = command.mode === 'session' ? reports[command.mode].sessions : reports[command.mode].daily
  if (!Array.isArray(rows)) {
    fail(`ccusage (${command.mode}) printed no rows array.`)
  }
  if (rows.length === 0) {
    fail(`ccusage (${command.mode}) printed an EMPTY rows array; refusing to mint empty goldens.`)
  }
}
const fixtureDates = new Set()
for (const relativePath of relativeFiles(fixtureDir)) {
  if (relativePath.endsWith('.zst')) continue // compressed: the plain frames are checked above
  const content = readFileSync(join(fixtureDir, relativePath), 'utf8')
  for (const match of content.matchAll(/"timestamp":"(\d{4}-\d{2}-\d{2})/g)) {
    fixtureDates.add(match[1])
  }
}
const missing = [...fixtureDates]
  .filter(
    (date) => date >= '2026-05-18' && date <= '2026-05-28' && !reports.auto.daily.some((row) => row.date === date)
  )
  .sort()
if (missing.length > 0) {
  fail(`ccusage (auto) produced no row for these fixture dates: ${missing.join(', ')}.`)
}
// `auto` has no stored costUSD for any model, so auto and calculate must agree;
// if they diverge a fixture row grew a reported cost and the corpus changed.
if (JSON.stringify(reports.auto) !== JSON.stringify(reports.calculate)) {
  fail('--mode auto and --mode calculate disagree; the fixture lost its no-reported-cost property.')
}

// ---------------------------------------------------------------------------
// 5. Fixture tree hash (same algorithm as gen-claude-goldens.mjs):
//    for each file, feed sha256: path 0x00 decimal-byte-length 0x00 content 0x00
// ---------------------------------------------------------------------------
function fixtureTreeHash(root) {
  const hash = createHash('sha256')
  for (const relativePath of relativeFiles(root)) {
    const bytes = readFileSync(join(root, relativePath))
    hash.update(relativePath, 'utf8')
    hash.update('\u0000')
    hash.update(String(bytes.length), 'utf8')
    hash.update('\u0000')
    hash.update(bytes)
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

const fixtureSha256 = fixtureTreeHash(fixtureDir)

// ---------------------------------------------------------------------------
// 6. Write the goldens.
// ---------------------------------------------------------------------------
const document = {
  ccusageVersion: expectedVersion,
  commands: commands.map((command) => ({
    mode: command.mode,
    argv: ['ccusage', ...command.argv],
    env: { CODEX_HOME: '<fixture-tree>', CCUSAGE_MODEL_ALIASES: '' }
  })),
  fixtureSha256,
  reports
}

mkdirSync(goldensDir, { recursive: true })
const serialized = JSON.stringify(document, null, 2) + '\n'

if (checkOnly) {
  if (!existsSync(goldensPath)) {
    fail(`missing golden ${goldensPath}; run without --check to mint it.`)
  }
  const committed = readFileSync(goldensPath, 'utf8')
  if (committed !== serialized) {
    let committedDocument = null
    try {
      committedDocument = JSON.parse(committed)
    } catch {
      fail(`committed golden ${goldensPath} is not valid JSON; re-mint it.`)
    }
    // Name the first drifted section so the failure is actionable without a
    // full diff of two pretty-printed documents.
    const sections = ['ccusageVersion', 'commands', 'fixtureSha256', 'reports']
    const drifted = sections.filter(
      (section) => JSON.stringify(committedDocument[section]) !== JSON.stringify(document[section])
    )
    fail(
      `committed golden ${relative(repoRoot, goldensPath)} drifted from what ${ccusageBin} produces ` +
        `(${drifted.length > 0 ? drifted.join(', ') : 'formatting'}); review the change, then re-mint ` +
        'without --check.'
    )
  }
  console.log(
    `gen-codex-goldens: --check: ccusage ${expectedVersion} still produces the committed goldens ` +
      `(fixtureSha256 ${fixtureSha256}).`
  )
  process.exit(0)
}

writeFileSync(goldensPath, serialized)

console.log(`gen-codex-goldens: ccusage ${expectedVersion}`)
console.log(`gen-codex-goldens: fixtureSha256 ${fixtureSha256}`)
for (const command of commands) {
  const report = reports[command.mode]
  const rows = command.mode === 'session' ? report.sessions : report.daily
  console.log(
    `gen-codex-goldens: ${command.mode}: ${rows.length} rows, costUSD ${report.totals.costUSD}` +
      (report.totals.unpricedModels ? `, unpriced ${report.totals.unpricedModels.join(', ')}` : '')
  )
}
console.log(`gen-codex-goldens: wrote ${relative(repoRoot, goldensPath)}`)
