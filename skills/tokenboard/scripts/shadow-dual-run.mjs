#!/usr/bin/env node
// Production dual run (spec §6.3): compare the installed TypeScript collector
// against the Go client over this machine's *real* usage data, once a day for
// a while, and keep a log a human can review before flipping `clientType`.
//
// This is not the CI gate. CI proves the two implementations agree on
// fixtures; this proves they agree on the machine that is about to switch.
// The Go side of every comparison is `tokenboard shadow`, which already scans
// both implementations over the same environment with isolated state
// directories and never uploads.
//
// The run is read-only with respect to the real install: nothing is
// scheduled, nothing is uploaded, and the real cursors are never touched.
// Installing a scheduler entry is an operator decision, so this script only
// does what one invocation can do and the operator decides how often to call
// it.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isMainModule } from './is-main.mjs'
import { printHelpIfRequested } from './cli-help.mjs'
import { configDir, readConfig } from './config.mjs'
import { errorMessage } from './error-message.mjs'
import { readSince } from './sync-options.mjs'
import { redactUrlCredentials } from './redact-credentials.mjs'
import { ccusageToolSources, usageSources } from './usage-sources.mjs'

// The sources `tokenboard shadow` can compare with data on a normal machine.
// The two Antigravity GUI sources need a language server and are outside the
// dual run for the same reason they are outside CI. Everything else is derived
// from the shared source set, so a source added there joins the comparison
// instead of being quietly left out — the tool family was omitted that way
// until the twelve tools were ported.
//
// Comparing a tool source is still worth the spawn when the tool is not
// installed: both sides report empty, and a wrong subcommand name would make
// ccusage exit 2, failing the Go source instead of looking like an uninstalled
// tool.
const dualRunExcludedSources = new Set(['antigravity', 'antigravity-ide'])
export const dualRunSources = usageSources.filter((source) => !dualRunExcludedSources.has(source))

// defaultDualRunSince is sync's own default window, so a dual run compares
// the dataset production collects rather than the collector's "everything"
// default. They differ: the collector only knows the --since flag and
// TOKENBOARD_SINCE, and treats both absent as full history.
export function defaultDualRunSince({ config = {}, env = {}, now = new Date() } = {}) {
  return readSince({ env, config, now })
}

// Sources whose collector shells out to ccusage. A comparison of these is only
// meaningful when both sides run the same ccusage binary, so the harness pins
// it the way CI does. The tool family belongs here too: without the pin the
// Go side could resolve (and download) a different copy than the one the
// TypeScript side reaches through node_modules.
const ccusageSources = new Set(['claude-code', 'codex', ...ccusageToolSources])

// `--until` is accepted only for the two sources with a date window. The tool
// family is ccusage-backed but takes no window on either side, so passing the
// flag there is a usage error rather than a silently ignored one.
const untilSources = new Set(['claude-code', 'codex'])

export const usage = `Usage: shadow-dual-run.mjs [--client PATH] [--since YYYYMMDD] [--until YYYY-MM-DD] [--hook] [--log PATH] [--source NAME]

Runs \`tokenboard shadow\` for every comparable source and appends one JSON
line per source to the dual-run log (default: the config directory's
logs/shadow-dual-run.jsonl).

--client   path to the Go client (default: the installed binary)
--since    the window both sides collect (default: the scheduled sync's
           lookback, so the comparison covers the days production sends)
--until    compare only days up to and including this date; pass yesterday
           to keep the actively-written current day out of the comparison
--hook     compare the incremental hook path (claude-code and codex only)
           instead of a full preview
--source   run one source instead of all of them
--log      append the results here instead of the default log
--summary  print the trend from the log instead of running a comparison
--limit N  with --summary, how many trailing records to read (default 50)

A source whose data falls entirely outside the window logs "empty" (both
sides agreed on zero snapshots), not "match" — an empty comparison is not
coverage. Rerun it with --since all to actually exercise that source.`

// readDualRunConfig reads what one invocation needs from the install: where
// the Go client is, where the checkout is, and how the collector is
// configured. Everything is optional so the harness can be pointed at a temp
// tree in tests.
export function readDualRunConfig({ env = process.env, config = {}, homeDir = homedir() } = {}) {
  const root = configDir()
  const binary = env.TOKENBOARD_SHADOW_CLIENT
    ? env.TOKENBOARD_SHADOW_CLIENT
    : join(root, 'bin', process.platform === 'win32' ? 'tokenboard.exe' : 'tokenboard')
  return {
    binary,
    collectorDir: config.collectorDir || env.TOKENBOARD_COLLECTOR_DIR || join(root, 'TokenBoard'),
    timezone: config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    // The ccusage copy a shipping install already has. Pinning it is what
    // makes a claude-code or codex comparison apples to apples: both sides
    // run this file rather than each resolving one their own way.
    ccusageBin: firstExisting([
      join(root, 'bin', process.platform === 'win32' ? 'ccusage.exe' : 'ccusage'),
      join(root, 'TokenBoard', 'packages', 'collector', 'node_modules', '.bin', 'ccusage')
    ]),
    logPath: dualRunLogPath({ env }),
    // The configured symlinked Codex roots, exactly as sync injects them: a
    // machine whose archived_sessions is a symlink refuses the scan without
    // this, and the dual run would report a codex failure on every run.
    codexSymlinkRoots: Array.isArray(config.codexSymlinkRoots) ? config.codexSymlinkRoots : undefined,
    homeDir
  }
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

// buildShadowInvocation assembles one `tokenboard shadow` call. The
// environment is the process environment with the collector contract filled
// in: the harness runs the same comparison the CI gate runs, over the real
// data instead of a fixture tree.
//
// `until` narrows the comparison to settled days. Only claude-code and codex
// accept it, so the other sources get an unbounded comparison — their files
// are not appended to mid-run the way an active Claude Code session's are.
//
// `hook` compares the incremental hook path instead of a full preview. That is
// the path production actually runs, so a dual run that only ever compares
// previews leaves the code that collects every scheduled event unverified.
// Only the two hook-installed sources have a hook path at all.
//
// `--hook` wins over `--until`: both clients reject --until in hook mode
// (the hook window comes from the changed cursor dates, not a flag), and
// silently passing the pair would fail every ccusage source. The trade is
// accepted — hook mode cannot exclude the actively-written current day, so
// same-day rows carry the known live-write race and same-instant cost deltas.
export function buildShadowInvocation({ config, source, since, until, hook = false, env = process.env }) {
  const supportsUntil = untilSources.has(source)
  const useHook = hook && untilSources.has(source)
  const passUntil = until && supportsUntil && !useHook
  const childEnv = {
    ...env,
    TOKENBOARD_COLLECTOR_DIR: config.collectorDir,
    TOKENBOARD_TIMEZONE: config.timezone
  }
  if (since) childEnv.TOKENBOARD_SINCE = since
  if (passUntil) childEnv.TOKENBOARD_UNTIL = until
  if (config.ccusageBin && ccusageSources.has(source)) {
    childEnv.TOKENBOARD_CCUSAGE_BIN = config.ccusageBin
  }
  if (config.codexSymlinkRoots?.length) {
    childEnv.TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON = JSON.stringify(config.codexSymlinkRoots)
  }
  // Hook mode comes from the flag, never from the environment: an inherited
  // TOKENBOARD_HOOK_MODE belongs to a notifier and would silently change which
  // code path the comparison measures.
  delete childEnv.TOKENBOARD_HOOK_MODE
  const args = ['shadow', '--source', source]
  if (passUntil) args.push('--until', until)
  if (useHook) args.push('--hook')
  return { command: config.binary, args, env: childEnv }
}

// classifyShadowRun turns one invocation's result into a log record. The exit
// code alone cannot say what happened: an unavailable source is reported on
// stderr and the source is simply absent from the comparison, while a real
// difference exits 1 with a JSON report. Returning "not-installed" instead of
// "diff" is what keeps a machine without Grok Build from logging a daily
// false alarm.
export function classifyShadowRun({ source, status, stdout, stderr }) {
  const report = parseReport(stdout)
  const record = {
    at: new Date().toISOString(),
    source,
    status: 'error',
    ...(report ? { snapshots: report.snapshots ?? 0 } : {})
  }
  // liveWrite rows are differences the Go client already attributed to the
  // source being written while the comparison ran. They are recorded so the
  // log still shows the day was not perfectly still, but they do not make the
  // run a diff: on a machine with an active session every daily comparison
  // would otherwise be red, and a permanently red gate gets ignored.
  if (report?.liveWrite?.length) {
    record.liveWrite = report.liveWrite.length
  }
  if (report && report.status === 'match') {
    // A match over zero snapshots is not evidence that the two
    // implementations agree — it is evidence that neither found anything to
    // compare. Logging it as `match` made an empty source look covered, which
    // is how a source whose data sits outside the configured window reads as
    // verified every single day. `summarizeDualRun` counts these separately so
    // the coverage claim cannot inflate itself.
    record.status = record.snapshots > 0 ? 'match' : 'empty'
    return record
  }
  if (report && report.status === 'diff') {
    record.status = 'diff'
    record.onlyInTs = report.onlyInTs?.length ?? 0
    record.onlyInGo = report.onlyInGo?.length ?? 0
    record.differing = report.differing?.length ?? 0
    // The keys themselves are what a reviewer needs to judge a difference:
    // a row on today's date is the live-write race, an older row is a real
    // drift. Keep them bounded so one bad day cannot fill the log.
    record.keys = [
      ...(report.onlyInTs ?? []),
      ...(report.onlyInGo ?? []),
      ...(report.differing ?? []).map((d) => d.key)
    ].slice(0, 20)
    return record
  }
  const message = String(stderr ?? '').trim()
  if (isUnavailable(stderr)) {
    record.status = 'not-installed'
    return record
  }
  record.status = 'error'
  record.exitCode = status
  // The message lands in the log and is echoed to the terminal by `--summary`. The Go client
  // redacts its own output, but this harness is the point where both clients' stderr converges,
  // and it must not depend on either side having done it — a provider error can echo
  // `tb_upload_…` or `https://user:token@host/…`.
  record.message = redactUrlCredentials(lastLine(message))
  // A run that could not take the collector lock was racing a sync on this
  // machine. The comparison is meaningless in that state — the async side may
  // be rewriting cursors while both scans read — and calling it a failure
  // would train the operator to ignore the log.
  if (/collector lock timed out|TokenBoard collector lock timed out/i.test(message)) {
    record.status = 'busy'
  }
  return record
}

// isUnavailable recognises the diagnostics both sides print for a source whose
// tool is not installed here. Those are skipped, not failures: a dual run on a
// machine without OpenCode should log "not installed", not "diff".
//
// A named `--source` run is fail-fast on both clients, so the absence of a
// store arrives as a raw error rather than the all-run's "Skipping
// unavailable ..." line. The message bodies are the same; matching on them
// covers both shapes.
export function isUnavailable(stderr) {
  const text = String(stderr ?? '')
  return (
    /Skipping unavailable \S+ source:/.test(text) ||
    /No Pi sessions found|No Grok Build sessions found|No DeepSeek Harness sessions found/.test(text) ||
    /Antigravity collection: source=\S+ status=unavailable/.test(text) ||
    /status=failed category=history-unavailable/.test(text) ||
    /OpenCode database not found|OpenCode SQLite reader unavailable/.test(text) ||
    /Antigravity SQLite reader unavailable/.test(text)
  )
}

function parseReport(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function lastLine(value) {
  const lines = String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? ''
}

// dualRunLogPath is the one place that knows where the comparison log lives.
// status.mjs reads the same path, so a moved log (`--log` / the env override)
// stays visible in the daily health check.
export function dualRunLogPath({ env = process.env, root = configDir() } = {}) {
  return env.TOKENBOARD_SHADOW_DUAL_RUN_LOG || join(root, 'logs', 'shadow-dual-run.jsonl')
}

// dualRunTrend condenses the day's records for a human reading the log
// tail: how many sources matched, differed, were absent, and failed.
//
// `empty` is its own bucket. It means both sides agreed on an empty set, which
// says nothing about whether the two implementations compute the same thing —
// a source whose newest data predates the collection window lands here every
// day. Folding it into `match` is what let a log full of matches look like
// coverage when most of those sources had never compared a single row.
export function summarizeDualRun(records) {
  const counts = { match: 0, empty: 0, diff: 0, 'not-installed': 0, busy: 0, error: 0 }
  for (const record of records) {
    if (record.status in counts) counts[record.status] += 1
  }
  return counts
}

// summarizeDualRunTrend is the window summary status.mjs reports: counts per
// outcome plus the span the window covers and when the last red state was.
// It carries no record contents — a record's message can hold a client's
// error text with local paths in it, which must not reach status output.
export function summarizeDualRunTrend(records) {
  if (records.length === 0) return undefined
  const counts = summarizeDualRun(records)
  const lastOf = (status) => records.filter((record) => record.status === status).at(-1)?.at
  const lastDiffAt = lastOf('diff')
  const lastErrorAt = lastOf('error')
  return {
    records: records.length,
    ...(records[0]?.at ? { firstAt: records[0].at } : {}),
    ...(records.at(-1)?.at ? { lastAt: records.at(-1).at } : {}),
    match: counts.match,
    empty: counts.empty,
    diff: counts.diff,
    notInstalled: counts['not-installed'],
    busy: counts.busy,
    error: counts.error,
    ...(lastDiffAt ? { lastDiffAt } : {}),
    ...(lastErrorAt ? { lastErrorAt } : {})
  }
}

// exitCodeForDualRun is the run's verdict: a difference or an error fails the
// run; a source that simply is not installed here, or one skipped because a
// synchronous sync held the lock, does not — neither says anything about
// whether the two implementations agree.
export function exitCodeForDualRun(records) {
  return records.some((record) => record.status === 'diff' || record.status === 'error') ? 1 : 0
}

function appendRecords(logPath, records) {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
  appendFileSync(logPath, records.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 })
}

// readRecentRecords returns the log's last `limit` records, newest last. It
// exists so `--summary` can report the trend without a second tool. Torn
// lines are dropped before the slice: a line lost to an interrupted append
// must not shrink the window the caller asked for.
export function readRecentRecords(logPath, limit = 50) {
  if (!existsSync(logPath)) return []
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
  const records = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      // A torn line from an interrupted append is not a record; skip it.
    }
  }
  return records.slice(-limit)
}

function parseRunArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
      continue
    }
    flags[key] = next
    index += 1
  }
  return flags
}

function run() {
  const argv = process.argv.slice(2)
  if (printHelpIfRequested(argv, usage)) return 0
  const flags = parseRunArgs(argv)
  const stored = readConfig()
  const config = readDualRunConfig({ config: stored })
  const logPath = typeof flags.log === 'string' ? flags.log : config.logPath

  // --summary reads the log instead of running: it answers "how has the last
  // while actually looked" without paying for a fresh comparison, and it is
  // what a cron entry or a human checking in should call rather than another
  // full run.
  if (flags.summary === true) {
    // `--limit` reaches readRecentRecords as `slice(-limit)`. A value that is
    // not a positive integer degrades silently there: NaN slices the whole
    // log, and a negative number takes from the wrong end. Both look like a
    // successful summary of a window the caller never asked for, so reject
    // them here instead of reporting a count nobody can trust.
    let limit = 50
    if (flags.limit !== undefined) {
      if (typeof flags.limit !== 'string' || !/^[1-9][0-9]*$/.test(flags.limit)) {
        console.error('--limit must be a positive integer')
        return 1
      }
      limit = Number(flags.limit)
    }
    const records = readRecentRecords(logPath, limit)
    if (records.length === 0) {
      console.log(`no records in ${logPath}`)
      return 0
    }
    const counts = summarizeDualRun(records)
    // The record count alone does not say what the window covers: 31 records
    // is a few days at four sources a day and half a year at one source a
    // week. Print the span so a reader can tell whether the trend is recent.
    const first = records[0]?.at
    const last = records.at(-1)?.at
    const span = first && last ? `${first} → ${last}` : 'unknown span'
    console.log(
      `last ${records.length} records (${span}): ${counts.match} match, ${counts.empty} empty, ` +
        `${counts.diff} diff, ${counts['not-installed']} not installed, ${counts.busy} busy, ${counts.error} error`
    )
    for (const record of records.filter((r) => r.status === 'diff' || r.status === 'error').slice(-10)) {
      console.log(`${record.at} ${record.source}: ${record.status}${record.message ? ` — ${record.message}` : ''}`)
    }
    return 0
  }

  if (flags.client) config.binary = String(flags.client)
  if (!existsSync(config.binary)) {
    console.error(`TokenBoard Go client is not installed: ${config.binary}`)
    console.error('Run install-collector.mjs --client binary or upgrade.mjs --to-binary first.')
    return 1
  }
  const sources = typeof flags.source === 'string' ? [flags.source] : dualRunSources
  const since =
    typeof flags.since === 'string' ? flags.since : defaultDualRunSince({ config: stored, env: process.env })
  const until = typeof flags.until === 'string' ? flags.until : undefined
  const hook = flags.hook === true

  // `--until` narrows a comparison to settled days, and only the ccusage-backed sources accept
  // it. Silently dropping it for the others would let an operator believe the window was
  // narrowed when the comparison actually ran unbounded — the harness would then report a diff
  // the caller thought it had excluded. A named source that cannot honor the flag is a usage
  // error, the same contract both clients enforce.
  if (until && !hook && typeof flags.source === 'string' && !untilSources.has(flags.source)) {
    console.error(
      `--until is only supported for ${[...untilSources].join(' and ')}; ${flags.source} has no date window`
    )
    return 1
  }

  const records = []
  if (until && !hook && typeof flags.source !== 'string') {
    const skipped = dualRunSources.filter((source) => !untilSources.has(source))
    console.log(
      `note: --until applies only to ${[...untilSources].join(' and ')}; it is ignored for ${skipped.join(', ')}`
    )
  }
  for (const source of sources) {
    const invocation = buildShadowInvocation({ config, source, since, until, hook })
    const result = spawnSync(invocation.command, invocation.args, {
      env: invocation.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    const record = classifyShadowRun({
      source,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr ?? errorMessage(result.error)
    })
    records.push(record)
    const detail =
      record.status === 'match' || record.status === 'empty' ? `${record.snapshots} snapshots` : (record.message ?? '')
    console.log(`${source}: ${record.status}${detail ? ` — ${detail}` : ''}`)
  }
  appendRecords(logPath, records)
  const counts = summarizeDualRun(records)
  console.log(
    `dual run: ${counts.match} match, ${counts.empty} empty, ${counts.diff} diff, ` +
      `${counts['not-installed']} not installed, ${counts.busy} busy, ${counts.error} error`
  )
  console.log(`log: ${logPath}`)
  return exitCodeForDualRun(records)
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(run())
  } catch (error) {
    console.error(`TokenBoard dual run failed: ${errorMessage(error)}`)
    process.exit(1)
  }
}
