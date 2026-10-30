import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildShadowInvocation,
  classifyShadowRun,
  dualRunLogPath,
  dualRunSources,
  exitCodeForDualRun,
  isUnavailable,
  defaultDualRunSince,
  readRecentRecords,
  readDualRunConfig,
  summarizeDualRun,
  summarizeDualRunTrend,
  validateDualRunFlags
} from './shadow-dual-run.mjs'

const report = (overrides = {}) => JSON.stringify({ status: 'match', snapshots: 12, ...overrides }, null, 2)

test('a matching run logs a match with its snapshot count', () => {
  const record = classifyShadowRun({ source: 'pi', status: 0, stdout: report(), stderr: '' })
  assert.equal(record.status, 'match')
  assert.equal(record.snapshots, 12)
  assert.equal(record.source, 'pi')
})

// Two implementations agreeing on nothing is not agreement. A source whose
// data sits outside the window returns a match with zero snapshots every day,
// and calling that a match is how a log of green lines came to look like
// coverage for sources that had never compared a row.
test('a match over zero snapshots is logged as empty, not match', () => {
  const record = classifyShadowRun({ source: 'grok-build', status: 0, stdout: report({ snapshots: 0 }), stderr: '' })
  assert.equal(record.status, 'empty')
  assert.equal(record.snapshots, 0)
  assert.deepEqual(summarizeDualRun([record, { status: 'match' }]), {
    match: 1,
    empty: 1,
    diff: 0,
    'not-installed': 0,
    busy: 0,
    error: 0
  })
  // `empty` is not a failure: neither side errored, so the run still passes.
  assert.equal(exitCodeForDualRun([record]), 0)
})

// A match that carries no count at all cannot be shown to have compared
// anything, so it takes the same conservative route.
test('a match with no snapshot count is empty', () => {
  const record = classifyShadowRun({ source: 'pi', status: 0, stdout: JSON.stringify({ status: 'match' }), stderr: '' })
  assert.equal(record.status, 'empty')
})

// The diff report carries the keys, and the keys are what tells a reviewer
// whether the difference is the live-write race on the current day or real
// drift on a settled one. The log has to keep them.
test('a differing run logs the counts and the keys, bounded', () => {
  const key = (model) => ({ source: 'codex', usageDate: '2026-10-20', timezone: 'UTC', model })
  const stdout = report({
    status: 'diff',
    onlyInTs: [key('a')],
    onlyInGo: [key('b')],
    differing: [{ key: key('c'), fields: [{ field: 'inputTokens', ts: 1, go: 2 }] }]
  })
  const record = classifyShadowRun({ source: 'codex', status: 1, stdout, stderr: '' })
  assert.equal(record.status, 'diff')
  assert.equal(record.onlyInTs, 1)
  assert.equal(record.onlyInGo, 1)
  assert.equal(record.differing, 1)
  assert.deepEqual(
    record.keys.map((k) => k.model),
    ['a', 'b', 'c']
  )

  const many = Array.from({ length: 40 }, (_, index) => key(`m${index}`))
  const bounded = classifyShadowRun({
    source: 'codex',
    status: 1,
    stdout: report({ status: 'diff', onlyInTs: many }),
    stderr: ''
  })
  assert.equal(bounded.keys.length, 20)
})

// A source the machine does not have is not a difference and must not fail
// the run: the Go client prints the same "Skipping unavailable" diagnostic
// the scheduled sync does.
test('an unavailable source is not installed, not a diff', () => {
  const stderr =
    'Skipping unavailable opencode source: OpenCode database not found: /home/x/.local/share/opencode/opencode.db\n'
  const record = classifyShadowRun({ source: 'opencode', status: 1, stdout: '', stderr })
  assert.equal(record.status, 'not-installed')
})

test('isUnavailable recognises every diagnostic the two sides print', () => {
  const cases = [
    'Skipping unavailable pi source: No Pi sessions found: /x/.pi/agent/sessions',
    'No Grok Build sessions found: /x/.grok/sessions, /x/.grok/archived_sessions',
    'No DeepSeek Harness sessions found: /x/.dsh/sessions',
    'Antigravity collection: source=antigravity-cli status=unavailable category=history-unavailable',
    // A named `--source` run is fail-fast, so the same absence arrives as a
    // raw error instead of a "Skipping unavailable" line. Both shapes mean
    // the tool is not installed here.
    'shadow: Go collection failed: OpenCode database not found: /x/.local/share/opencode/opencode.db',
    'shadow: Go collection failed: OpenCode SQLite reader unavailable',
    'shadow: Go collection failed: Antigravity collection: source=antigravity-cli status=failed category=history-unavailable',
    'shadow: Go collection failed: Antigravity SQLite reader unavailable',
    'OpenCode database not found: /x/.local/share/opencode/opencode.db'
  ]
  for (const stderr of cases) assert.equal(isUnavailable(stderr), true, stderr)
  // A genuine failure is still a failure: this one is the codex symlink
  // refusal, which is an install problem the operator has to fix, not an
  // absent tool.
  assert.equal(
    isUnavailable(
      'shadow: Go collection failed: Unable to inspect session directory /x: symbolic links are not supported'
    ),
    false
  )
})

test('a genuine error is still an error, not an unavailable source', () => {
  const record = classifyShadowRun({
    source: 'codex',
    status: 1,
    stdout: '',
    stderr: 'shadow: Go collection failed: Unable to inspect session directory /x: symbolic links are not supported'
  })
  assert.equal(record.status, 'error')
})

// Anything that is neither a match, a diff, nor an unavailable source is a
// real failure: a broken client, a missing checkout, a crashed scan. The log
// has to carry the reason, or the operator cannot act on it.
test('an unexpected failure logs an error with its last stderr line', () => {
  const stderr = 'shadow: TypeScript preview failed: exit status 1\nsome useful reason\n'
  const record = classifyShadowRun({ source: 'codex', status: 1, stdout: '', stderr })
  assert.equal(record.status, 'error')
  assert.equal(record.exitCode, 1)
  assert.equal(record.message, 'some useful reason')
})

test('stdout that is not a report falls back to stderr classification', () => {
  const record = classifyShadowRun({
    source: 'pi',
    status: 1,
    stdout: 'not json at all\n',
    stderr: 'Skipping unavailable pi source: No Pi sessions found: /x'
  })
  assert.equal(record.status, 'not-installed')
})

// A run that could not take the collector lock was racing a sync. Calling it
// a failure trains the operator to ignore the log; the comparison is
// meaningless in that state either way.
test('a lock timeout is busy, not an error', () => {
  const record = classifyShadowRun({
    source: 'codex',
    status: 1,
    stdout: '',
    stderr: 'TokenBoard collector lock timed out\n'
  })
  assert.equal(record.status, 'busy')
  assert.equal(exitCodeForDualRun([record]), 0)
})

test('the run fails only for a diff or an error', () => {
  assert.equal(exitCodeForDualRun([{ status: 'match' }, { status: 'not-installed' }]), 0)
  assert.equal(exitCodeForDualRun([{ status: 'match' }, { status: 'diff' }]), 1)
  assert.equal(exitCodeForDualRun([{ status: 'error' }]), 1)
})

test('summarizeDualRun counts every outcome', () => {
  assert.deepEqual(
    summarizeDualRun([
      { status: 'match' },
      { status: 'match' },
      { status: 'empty' },
      { status: 'diff' },
      { status: 'not-installed' },
      { status: 'busy' },
      { status: 'error' }
    ]),
    { match: 2, empty: 1, diff: 1, 'not-installed': 1, busy: 1, error: 1 }
  )
})

// readRecentRecords trusts its caller: it slices with a negative limit, where
// NaN reads the whole log and a negative count reads from the wrong end. The
// CLI rejects those before they reach it, so the only contract the function
// owes is that a positive limit returns exactly that many trailing records.
test('readRecentRecords returns the requested tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-dual-'))
  const logPath = join(dir, 'log.jsonl')
  try {
    const lines = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({ at: `t${index}`, source: 'pi', status: 'match' })
    )
    writeFileSync(logPath, `${lines.join('\n')}\n`)

    assert.equal(readRecentRecords(logPath, 5).length, 5)
    assert.equal(readRecentRecords(logPath, 5).at(-1).at, 't11')
    assert.equal(readRecentRecords(logPath, 50).length, 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --until is a usage error for any source other than claude-code and codex,
// so the harness must not pass it to the others; doing so would turn a dual
// run into a wall of usage errors on a machine with Grok Build.
test('buildShadowInvocation only passes --until to the sources that accept it', () => {
  const config = { binary: '/bin/tokenboard', collectorDir: '/repo', timezone: 'UTC' }
  const claude = buildShadowInvocation({ config, source: 'claude-code', until: '2026-10-20' })
  assert.deepEqual(claude.args, ['shadow', '--source', 'claude-code', '--until', '2026-10-20'])
  assert.equal(claude.env.TOKENBOARD_UNTIL, '2026-10-20')

  const grok = buildShadowInvocation({ config, source: 'grok-build', until: '2026-10-20' })
  assert.deepEqual(grok.args, ['shadow', '--source', 'grok-build'])
  assert.equal(grok.env.TOKENBOARD_UNTIL, undefined)
})

// The ccusage-backed sources must run the same ccusage binary on both sides,
// or the comparison measures two different tools. The others have no ccusage
// to pin.
test('buildShadowInvocation pins ccusage only for the sources that use it', () => {
  const config = { binary: '/bin/tokenboard', collectorDir: '/repo', timezone: 'UTC', ccusageBin: '/bin/ccusage' }
  assert.equal(buildShadowInvocation({ config, source: 'claude-code' }).env.TOKENBOARD_CCUSAGE_BIN, '/bin/ccusage')
  assert.equal(buildShadowInvocation({ config, source: 'codex' }).env.TOKENBOARD_CCUSAGE_BIN, '/bin/ccusage')
  assert.equal(buildShadowInvocation({ config, source: 'pi' }).env.TOKENBOARD_CCUSAGE_BIN, undefined)
})

// A machine whose Codex archive is a symlink refuses the scan unless the
// configured roots are passed through, which is exactly what sync does.
test('buildShadowInvocation passes the configured codex symlink roots', () => {
  const config = {
    binary: '/bin/tokenboard',
    collectorDir: '/repo',
    timezone: 'UTC',
    codexSymlinkRoots: ['/Volumes/Work/CodexArchive/archived_sessions']
  }
  const invocation = buildShadowInvocation({ config, source: 'codex', env: {} })
  assert.equal(
    invocation.env.TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON,
    JSON.stringify(['/Volumes/Work/CodexArchive/archived_sessions'])
  )
})

// A dual run started from a notifier hook inherits hook mode; the comparison
// must still be a full preview on both sides.
test('buildShadowInvocation strips an inherited hook mode', () => {
  const config = { binary: '/bin/tokenboard', collectorDir: '/repo', timezone: 'UTC' }
  const invocation = buildShadowInvocation({ config, source: 'codex', env: { TOKENBOARD_HOOK_MODE: '1' } })
  assert.equal(invocation.env.TOKENBOARD_HOOK_MODE, undefined)
})

test('readDualRunConfig defaults to the installed binary and the pinned ccusage', () => {
  const root = mkdtempSync(join(tmpdir(), 'dual-run-config-'))
  try {
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    const binary = join(binDir, process.platform === 'win32' ? 'tokenboard.exe' : 'tokenboard')
    const ccusage = join(binDir, process.platform === 'win32' ? 'ccusage.exe' : 'ccusage')
    writeFileSync(binary, '')
    writeFileSync(ccusage, '')

    const previous = process.env.TOKENBOARD_CONFIG_DIR
    process.env.TOKENBOARD_CONFIG_DIR = root
    try {
      const config = readDualRunConfig({ env: {}, config: { timezone: 'UTC' } })
      assert.equal(config.binary, binary)
      assert.equal(config.ccusageBin, ccusage)
      assert.equal(config.collectorDir, join(root, 'TokenBoard'))
      assert.equal(config.logPath, join(root, 'logs', 'shadow-dual-run.jsonl'))
    } finally {
      if (previous === undefined) delete process.env.TOKENBOARD_CONFIG_DIR
      else process.env.TOKENBOARD_CONFIG_DIR = previous
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readRecentRecords reads the tail and skips a torn line', () => {
  const root = mkdtempSync(join(tmpdir(), 'dual-run-log-'))
  try {
    const logPath = join(root, 'log.jsonl')
    const lines = Array.from({ length: 60 }, (_, index) => JSON.stringify({ at: `t${index}`, source: 'pi' }))
    writeFileSync(logPath, `${lines.join('\n')}\n{"torn"\n`)
    const records = readRecentRecords(logPath, 10)
    assert.equal(records.length, 10)
    assert.equal(records.at(-1).at, 't59')
    assert.equal(readRecentRecords(join(root, 'missing.jsonl')).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every comparable source is one the client accepts', () => {
  // The list must stay inside the contract's source set; a typo here would
  // turn every dual run into a usage error for that source.
  assert.deepEqual(dualRunSources, [
    'claude-code',
    'codex',
    'antigravity-cli',
    'opencode',
    'pi',
    'grok-build',
    'deepseek-harness',
    // The ccusage tool family, in usage-core's declaration order.
    'amp',
    'droid',
    'codebuff',
    'hermes',
    'goose',
    'kilo',
    'copilot',
    'gemini-cli',
    'kimi',
    'qwen',
    'openclaw',
    'zcode'
  ])
  // The two GUI sources need a language server, so they stay out of the dual
  // run. Asserted on the list rather than on the file text: the module names
  // them to exclude them, which is not the same as comparing them.
  for (const source of ['antigravity', 'antigravity-ide']) {
    assert.equal(dualRunSources.includes(source), false, `${source} must stay out of the dual run`)
  }
})

// The tool family collects through ccusage, so the harness has to pin the
// binary for it too. Without the pin the Go side resolves ccusage its own way
// (bundled copy, then PATH, then a download) while the TypeScript child uses
// the checkout's node_modules copy — a difference that shows up as a diff
// rather than as the configuration bug it is.
test('buildShadowInvocation pins the ccusage binary for the tool sources', () => {
  const config = { binary: '/bin/tokenboard', collectorDir: '/repo', timezone: 'UTC', ccusageBin: '/bin/ccusage' }
  for (const source of ['amp', 'gemini-cli', 'zcode', 'claude-code']) {
    const invocation = buildShadowInvocation({ config, source })
    assert.equal(invocation.env.TOKENBOARD_CCUSAGE_BIN, '/bin/ccusage', `${source} must run the pinned ccusage`)
  }
  // A file-backed source never touches ccusage; injecting the variable would
  // make the environment look like a difference between the two runs.
  const pi = buildShadowInvocation({ config, source: 'pi' })
  assert.equal(pi.env.TOKENBOARD_CCUSAGE_BIN, undefined)
})

// The dual run's default comparison is a full preview, but production runs the
// hook path. --hook lets the harness measure the code that actually collects
// scheduled usage.
test('buildShadowInvocation passes --hook only for the hook-installed sources', () => {
  const config = { binary: '/bin/tokenboard', collectorDir: '/repo', timezone: 'UTC' }
  for (const source of ['claude-code', 'codex']) {
    const invocation = buildShadowInvocation({ config, source, hook: true })
    assert.ok(invocation.args.includes('--hook'), `${source} must compare the hook path`)
  }
  // Grok Build and the other file-backed sources have no hook mode at all;
  // passing the flag would be a usage error on both clients.
  const grok = buildShadowInvocation({ config, source: 'grok-build', hook: true })
  assert.equal(grok.args.includes('--hook'), false)
})

test('buildShadowInvocation leaves the hook path off by default', () => {
  const config = { binary: '/bin/tokenboard', collectorDir: '/repo', timezone: 'UTC' }
  const invocation = buildShadowInvocation({ config, source: 'codex' })
  assert.equal(invocation.args.includes('--hook'), false)
})

// Both clients reject --until in hook mode: the hook window comes from the
// changed cursor dates, not from a flag. Passing the pair would turn every
// claude-code/codex comparison into a usage error, so --hook must drop it.
test('buildShadowInvocation drops --until when comparing the hook path', () => {
  const config = { binary: '/bin/tokenboard', collectorDir: '/repo', timezone: 'UTC' }
  const invocation = buildShadowInvocation({ config, source: 'codex', until: '2026-10-20', hook: true })
  assert.ok(invocation.args.includes('--hook'), 'the hook path must still be selected')
  assert.equal(invocation.args.includes('--until'), false)
  assert.equal(invocation.env.TOKENBOARD_UNTIL, undefined)
})

// Without --hook the same arguments still narrow the comparison to settled
// days, which is what keeps the live-write race out of a preview comparison.
test('buildShadowInvocation keeps --until for a preview comparison', () => {
  const config = { binary: '/bin/tokenboard', collectorDir: '/repo', timezone: 'UTC' }
  const invocation = buildShadowInvocation({ config, source: 'codex', until: '2026-10-20' })
  assert.deepEqual(invocation.args, ['shadow', '--source', 'codex', '--until', '2026-10-20'])
  assert.equal(invocation.env.TOKENBOARD_UNTIL, '2026-10-20')
})

// A dual run must compare what production actually collects. The scheduled
// sync sends a lookback window (seven days by default), and the collector's
// own default is "everything" when neither the flag nor the variable is set —
// so a harness that stays silent compares the full history while production
// collects a week. That is a different dataset: on this machine it reaches
// rows from months back that the collector has always failed to price, and
// the run fails for a reason no scheduled sync would ever hit.
test('the harness sends the same lookback window the scheduled sync sends', () => {
  const now = new Date('2026-10-21T12:00:00Z')
  const since = defaultDualRunSince({ config: { timezone: 'UTC' }, now })
  assert.equal(since, '20261014')
})

test('a configured lookback changes the default window', () => {
  const now = new Date('2026-10-21T12:00:00Z')
  const since = defaultDualRunSince({ config: { timezone: 'UTC', lookbackDays: 30 }, now })
  assert.equal(since, '20260921')
})

// The hook window comes from the cursor, but both clients still record the
// sync's window in the run: keeping the default means a hook comparison starts
// from the same baseline the scheduled runs do.
test('buildShadowInvocation omits --since when the caller passes none, leaving the default to the caller', () => {
  const config = { binary: '/bin/tokenboard', collectorDir: '/repo', timezone: 'UTC' }
  const invocation = buildShadowInvocation({ config, source: 'pi' })
  assert.equal(invocation.env.TOKENBOARD_SINCE, undefined)
})

// The Go client attributes today's token growth to the source being written
// while the comparison ran. The harness must keep that count visible in the
// log — an operator wants to know the day was not still — without turning the
// run red, or every dual run on a machine with an active session reports a
// false failure.
test('live-write rows are recorded but do not fail the run', () => {
  const key = (model) => ({ source: 'claude-code', usageDate: '2026-10-22', timezone: 'Asia/Shanghai', model })
  const stdout = report({ status: 'match', snapshots: 298, liveWrite: [key('a'), key('b')] })
  const record = classifyShadowRun({ source: 'claude-code', status: 0, stdout, stderr: '' })
  assert.equal(record.status, 'match')
  assert.equal(record.liveWrite, 2)
  assert.equal(exitCodeForDualRun([record]), 0)
})

// A report with no liveWrite field (an older client, or a run with no
// differences) must not grow a spurious zero.
test('a run without live-write rows has no liveWrite field', () => {
  const record = classifyShadowRun({ source: 'pi', status: 0, stdout: report(), stderr: '' })
  assert.equal(record.status, 'match')
  assert.equal('liveWrite' in record, false)
})

// A real difference still fails the run even when the same report also
// carries live-write rows: the client only labels rows it can explain.
test('a diff with live-write rows alongside still fails', () => {
  const key = (model) => ({ source: 'codex', usageDate: '2026-10-22', timezone: 'UTC', model })
  const stdout = report({
    status: 'diff',
    liveWrite: [key('a')],
    differing: [{ key: key('b'), fields: [{ field: 'inputTokens', ts: 1, go: 2 }] }]
  })
  const record = classifyShadowRun({ source: 'codex', status: 1, stdout, stderr: '' })
  assert.equal(record.status, 'diff')
  assert.equal(record.liveWrite, 1)
  assert.equal(exitCodeForDualRun([record]), 1)
})

// The status report surfaces the dual run's recent verdicts, so the daily
// health check answers "is the Go client still matching?" without a second
// command. The trend is counts and a span only: a record's message can carry
// a client's error text — including local paths — and status output must
// never contain either.
test('summarizeDualRunTrend condenses the window without record contents', () => {
  const records = [
    { at: '2026-10-22T10:34:05.576Z', source: 'claude-code', status: 'match', snapshots: 40 },
    { at: '2026-10-22T10:58:21.024Z', source: 'codex', status: 'diff', message: '/home/user/private' },
    { at: '2026-10-23T13:15:14.327Z', source: 'pi', status: 'not-installed' },
    { at: '2026-10-23T13:15:15.000Z', source: 'grok-build', status: 'error', message: 'boom /private/path' }
  ]
  const trend = summarizeDualRunTrend(records)
  assert.deepEqual(trend, {
    records: 4,
    firstAt: '2026-10-22T10:34:05.576Z',
    lastAt: '2026-10-23T13:15:15.000Z',
    match: 1,
    empty: 0,
    diff: 1,
    notInstalled: 1,
    busy: 0,
    error: 1,
    lastDiffAt: '2026-10-22T10:58:21.024Z',
    lastErrorAt: '2026-10-23T13:15:15.000Z'
  })
  assert.equal(JSON.stringify(trend).includes('/home/user'), false)
  assert.equal(JSON.stringify(trend).includes('/private'), false)
})

test('summarizeDualRunTrend has nothing to say about an empty window', () => {
  assert.equal(summarizeDualRunTrend([]), undefined)
})

// status must find the log where the harness writes it, including a moved
// log via the same env override `--log` sets.
test('the dual-run log path follows the config directory and the log override', () => {
  assert.equal(dualRunLogPath({ env: {}, root: '/cfg' }), join('/cfg', 'logs', 'shadow-dual-run.jsonl'))
  assert.equal(
    dualRunLogPath({ env: { TOKENBOARD_SHADOW_DUAL_RUN_LOG: '/tmp/moved.jsonl' }, root: '/cfg' }),
    '/tmp/moved.jsonl'
  )
})

// The harness is where both clients' stderr converges into a log line and a terminal echo.
// It must not assume either side redacted: a provider or ccusage error can carry
// `tb_upload_…` or `https://user:token@host/…`.
test('classifyShadowRun redacts credentials from an error message before logging it', () => {
  const record = classifyShadowRun({
    source: 'codex',
    status: 1,
    stdout: '',
    stderr: 'upload failed: POST https://ci-user:ci-token@example.invalid/ingest rejected tb_upload_abcdef123456'
  })

  assert.equal(record.status, 'error')
  assert.match(record.message, /https:\/\/example\.invalid\/ingest/)
  assert.doesNotMatch(record.message, /ci-token/)
  assert.doesNotMatch(record.message, /tb_upload_abcdef123456/)
})

// A named `--until` that the source cannot honor must not be dropped quietly: the operator
// asked for a settled-day window and would otherwise read an unbounded comparison as that
// window. (An `all` run keeps passing --until to the two sources that accept it, which the
// invocation test above pins down.)
test('buildShadowInvocation still drops --until for sources that do not accept it', () => {
  const config = { binary: '/bin/tokenboard', collectorDir: '/repo', timezone: 'UTC' }
  assert.equal(buildShadowInvocation({ config, source: 'pi', until: '2026-10-20' }).args.includes('--until'), false)
  assert.equal(buildShadowInvocation({ config, source: 'codex', until: '2026-10-20' }).args.includes('--until'), true)
})

// A named source that cannot honor `--until` or `--hook` is a usage error, not a silently
// wider comparison: both would let the operator read the run as evidence for a window or
// code path it never exercised.
test('validateDualRunFlags refuses flags a named source cannot honor', () => {
  assert.match(validateDualRunFlags({ source: 'pi', until: '2026-10-20' }), /--until is only supported/)
  assert.match(validateDualRunFlags({ source: 'pi', hook: true }), /--hook is only supported/)
  assert.equal(validateDualRunFlags({ source: 'codex', until: '2026-10-20' }), null)
  assert.equal(validateDualRunFlags({ source: 'codex', hook: true }), null)
  // An all-source run is allowed: the two hook sources use the flag, the rest run a preview.
  assert.equal(validateDualRunFlags({ source: undefined, until: '2026-10-20', hook: true }), null)
})
