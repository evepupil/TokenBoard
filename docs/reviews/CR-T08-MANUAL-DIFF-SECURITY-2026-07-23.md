# T08 Final Manual Diff Security Review

Created: 2026-07-25

Last updated: 2026-09-05

Baseline: `c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`

Branch: `fix/post-merge-reliability-followups`

## Constraint

The user explicitly disabled the `codex-security` plugin. No plugin scan was run for this final
candidate. This record describes a manual diff-scoped review and does not replace the independent
Claude Code and OMP reviews required by T09.

## Reviewed Boundaries

- Web and D1: device pairing/reconnect conditional writes, tenant predicates, token rotation UI,
  schema indexes, migrations `0028` and `0029`, and critical-schema verification.
- Collector: CLI dispatch, strict date normalization, Codex scoped files and attribution caches,
  Antigravity history/cursor/GUI paths, hook cursor acknowledgement, and lock liveness.
- Local scripts: statusline passthrough, coordinator and notifier locks, hook installation and
  uninstallation, process liveness, and sync lock inheritance.
- Dependency overrides: only constrained transitive package versions; no lifecycle, registry, or
  credential behavior was added.

## Result

No confirmed security finding was identified in the final diff.

Two collector observations were checked against current code and deterministic regression tests:

1. Scoped Codex collection rejects symbolic link session roots and source files through `lstat`,
   rejects a copied symbolic link before adding it to `CODEX_HOME`, and cleans the temporary target.
2. Scoped Codex batches enforce both a per-file and cumulative batch-byte limit. A matching
   multi-profile group over the configured limit fails explicitly instead of being copied.

The final Codex cache-warming adjustment resolves `sessionFile` and `sessionId` through the same
contained path logic before mapping a scoped file back to its source. Its regression covers a
directory-qualified `.jsonl` session ID, so this normalization cannot turn into an unbounded or
out-of-root path lookup.

The later bounded Codex fallback was also reviewed. It performs live `CODEX_HOME` access only for
session discovery, then runs daily reporting, bounded session reconciliation, and canonical
attribution from a disposable frozen scope. When discovery returns no sessions but a local scope
can still be frozen, it preserves the daily report and reports zero sessions rather than silently
dropping usage. When no frozen scope can be obtained, it fails explicitly. The change adds no
network, privilege, or unbounded local-path access.

## Current Candidate Addendum

The prior review snapshot became stale after the local Codex preflight exposed child session files
larger than the former 8 MiB total-file limit. The current candidate keeps a 4 GiB total file cap
aligned with the existing scoped collector boundary and adds a 1 MiB byte-level line cap. The
JSONL reader now splits raw byte chunks before decoding a complete line, so it rejects an
oversized line before `readline`-style aggregation can retain it in memory.

The added reader has no network, subprocess, privilege, configuration, or credential behavior. It
only reads the bounded source file, destroys the stream on early exit or error, checks the source
file fingerprint after a completed read, and fails explicitly when its file, line, or event bounds
are exceeded. The review also checked the multi-profile correction cache: its serialized state is
size- and retention-bounded, its lock is ownership-checked, and a changed session is retried once
before it fails without caching unstable usage.

The latest bounded-attribution repair was also reviewed. A canonical attribution can update a
bounded session's model, but its date now replaces the bounded row date only when it falls inside
the requested `--since`/`--until` calendar window. The deterministic until-window regression
proves that a newer canonical record cannot create an out-of-window snapshot. This remains local
file attribution only; it does not add network, credential, or writable-path behavior.

The final Web/D1 reconnect review added two SQLite-contract cases beyond the existing mock-level
checks. A source install claim changed after device-link lookup now produces no reconnect
installation, upload token, audit record, or pairing-code consumption. A later audit insert
failure rolls back the source-claim rotation together with every reconnect credential write. Both
cases exercise the transactional batch shape used by D1 rather than only statement ordering.

The final Antigravity CLI bounded-history review rechecked the SQLite candidate filter. An
unprocessed database is now read even when its database and WAL mtimes predate the requested
lower bound; its metadata events still pass through the timestamp range filter before a snapshot
can be emitted. After a row cursor exists, the mtime filter continues to bound routine reads.
This closes the observed near-month undercount without adding network, credential, privilege, or
unbounded state behavior.

That review also found that the SQLite row parser had accepted a numeric prefix such as
`7invalid` through `Number.parseInt`. The parser now accepts only a digit-only safe integer before
it can advance a persisted row cursor. The regression proves that malformed output fails before
any cursor acknowledgement. This is a local malformed-input hardening change only.

## Threat Model And Worklist

The review treated the following as untrusted boundaries:

- local Codex and Antigravity history files, including malformed JSONL, SQLite metadata, changed
  files, symbolic links, oversized files, oversized lines, and hostile model/date values;
- local hook/statusline stdin and generated handler environment values;
- device pairing, reconnect, upload-token rotation, and tenant-scoped D1 writes;
- Worker deployment configuration, migrations, package overrides, and public response rendering.

The current candidate worklist contains 92 tracked path changes and 36 untracked directly supporting
files relative to the fixed baseline. It was reviewed by ownership boundary: Web/D1, collector,
skill scripts, dependencies, migrations, tests, and documentation. Each source-path change was
checked for externally controlled path construction, privilege changes, secret persistence or
logging, missing tenant predicates, unbounded buffering, unsafe subprocess execution, and silent
failure paths. Fixture-only token strings and documented placeholder values were excluded after
confirming that they are not credentials or production configuration.

## Attack-Path Review And Findings

- Session-file traversal and symlink substitution: contained path resolution, `lstat` checks,
  copied-file revalidation, and bounded scoped batches reject the candidate rather than following
  it.
- Child-session resource exhaustion: total bytes, byte-level line length, unique event count,
  merged-event count, cache bytes, cache entries, and cache retention are all bounded. The new
  chunk splitter preserves CR, LF, CRLF, malformed-row diagnostics, and early-consumer cleanup.
- Cross-profile duplicate or stale usage: event identities are merged before daily correction;
  stable file fingerprints prevent a changing input from being cached or applied silently.
- Device and token state races: conditional D1 writes retain zero-row error mapping and profile
  recovery keeps server-scoped credentials separated. No plaintext credential is introduced into
  source, cursor, public payload, or review artifact.
- Hook and statusline takeover: original command forwarding, output handling, private local state,
  lock ownership, Windows process liveness, and uninstall recovery retain explicit failure paths.
- Deployment and dependency supply chain: package overrides are version-pinned, no lifecycle or
  registry override was added, and the high-severity dependency audit is clean.
- Dirty-worktree upgrade safety: an existing Git collector checkout is inspected with
  `git status --porcelain --untracked-files=all` before any remote, fetch, checkout, pull, copy,
  or dependency-install step. A dirty or unreadable worktree fails explicitly and does not take the
  archive fallback path.

No reportable security finding was confirmed. This is a manual review result, not a substitute for
the independent external review or private Cloudflare runtime validation.

## Verification

- `pnpm test`: passed, 9 usage-core, 548 collector, and 578 web tests.
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed, 352 tests.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- File-level Web/D1 targeted regression: 8 test files and 123 tests passed, including migrations,
  critical schema, SQLite reconnect conditional writes and rollback, API pairing, and device-page
  rendering.
- File-level collector regression: 17 test files and 174 tests passed, covering Codex bounded
  attribution, multi-profile cursors, scoped paths and JSONL limits, Antigravity CLI rebuild,
  compaction, bounded old-mtime discovery, strict SQLite row parsing, and GUI/IDE limits.
- Applying every migration in name order to a temporary SQLite database, then running
  `db/verify-critical-schema.sql` and `PRAGMA foreign_key_check`, passed with no output.
- Current JSONL boundary regression: CR, LF, CRLF, delayed CRLF, cross-chunk LF, early cleanup,
  oversized total file, oversized line, and oversized event collection all passed.
- High-confidence secret-marker checks over tracked additions and untracked supporting files
  passed without printing potential credential values.

## Manifest

Review baseline: `c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`.

Frozen-candidate inventory at review time: 92 tracked path changes and 36 untracked supporting files.
The review command set was `git diff --check`, full workspace tests, workspace type checking, skill
tests, production build, high-severity dependency audit, migration/schema application, a
status-only secret-marker check, and the targeted Web/D1 and collector commands listed above. The
final pass re-read the complete ownership worklist and specifically re-reviewed the new bounded
SQLite candidate and row-index parser paths, the dirty-worktree upgrade preflight, and the
dependency override graph. The current high-confidence marker scan reported zero potential
credential matches without printing file content. Under Node 24, the Web test loader emits a
non-fatal `module.register()` deprecation warning from `@tailwindcss/node` 4.2.4 while Vite loads
the test configuration. It is outside the changed application code and did not occur as a test,
typecheck, build, audit, or migration failure. It remains a documented toolchain warning rather
than a release-success claim. Any later source or directly supporting test change invalidates this
record and requires a new manual review before stateful sync, deployment, commit, push, or PR.

## Boundary

This is local static and regression evidence only. It is not proof of a deployed Worker, a D1
migration, authenticated-page rendering, or real collector ingestion. Those remain T07, T09, and
T10 gates.

## 2026-07-27 T09 Confirmed-Finding Repair Review

The previous snapshot was reopened after the independent review confirmed a Codex path ambiguity,
test fixture weaknesses, a D1 foreign-key coverage gap, and a session-root compatibility boundary.
The current diff was re-read at the exact call sites and the fixes were checked against the new
deterministic regressions.

- `CODEX_HOME` keeps its legacy comma-separated multi-profile format, while an existing single path
  containing a comma fails explicitly and `TOKENBOARD_CODEX_HOMES_JSON` provides an unambiguous JSON
  array. Hook reconciliation for such a path uses one disposable frozen scope for daily, bounded
  session, and canonical attribution commands; it never sends the ambiguous source path to `ccusage`.
- `walkJsonlFiles` resolves only the caller-supplied root symlink. It still rejects every symlink
  entry below that root, and session cursor reads retain their final-file `lstat` and containment
  checks. The root-symlink regression returns only a relative JSONL path; the nested-entry regression
  fails explicitly.
- The seed cleanup fixture now runs a complete dependent graph with both immediate and deferred
  foreign-key enforcement and checks `PRAGMA foreign_key_check` after migration. This expands the
  SQLite contract without changing the production migration order.
- Codex-only CLI tests fail fast if Claude collection is invoked; the profile cursor assertion uses
  the persisted POSIX key on every platform. The skill, README, Antigravity verification note, and
  test-size review no longer describe ambiguous paths, raw history inputs, dirty-checkout fallback,
  or duplicate file-size rows.

No fix adds network, privilege, credential, or raw conversation access. No confirmed security,
privacy, data-correctness, or reliability finding remains from the reviewed receipts.

Current verification for this candidate:

- `pnpm test`: passed, 9 usage-core, 593 collector, and 578 Web tests (1,180 total).
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed, 353 tests.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- The complete migration set was applied to SQLite `:memory:`, followed by
  `db/verify-critical-schema.sql` and `PRAGMA foreign_key_check`; both produced no output.
- Web/D1 focused regression: 35 tests passed, including both foreign-key cleanup modes, migration
  indexes, and deployment schema checks. Collector focused regressions for clone helper, session
  scope, session cursor, CLI, and profile hooks passed; collector typecheck passed.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` passed. The high-confidence marker scan
  found only test-fixture encryption-key placeholders and no production credential values.

This addendum is still local manual evidence. T07 client reconciliation, T09 final Claude/OMP review,
and T10 private Cloudflare validation remain required.

## 2026-07-25 Freeze Update

The prior 2026-07-24 snapshot became stale after the bounded Codex child-session JSONL reader was
changed to preserve its verified file descriptor through the read and verify the path and descriptor
fingerprints before a successful read can be accepted. The current review re-read the complete
ownership worklist and the final JSONL reader, child-usage, cache, scoped-session, hook-cursor,
Antigravity history, Web/D1, local-script, migration, dependency, test, and documentation deltas.

The JSONL path now rejects a symlink, oversized file, oversized line, invalid UTF-8, changed path,
changed descriptor, or incomplete changed-file read before a cache or cursor can be committed. A
normal complete read verifies the original descriptor and current path after consumption. An early
consumer stop or read error destroys the stream and does not establish read completion. The direct
regression includes same-size atomic replacement after the first record and expects an explicit
changed-while-reading failure.

No confirmed security finding was identified. The final candidate inventory is 92 tracked path
changes and 36 untracked supporting files. A high-confidence credential marker scan over every
existing changed path reported no match without printing candidate content. The user prohibited the
`codex-security` plugin, so this remains a manual, diff-scoped review rather than a plugin scan.

Current verification for this frozen runtime and direct-test snapshot:

- `pnpm test`: passed, 9 usage-core, 548 collector, and 578 Web tests (1,135 total).
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed, 352 tests.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed before this documentation-only update.
- Web/D1 targeted regression: 8 test files and 123 tests passed, including both new migrations,
  critical schema verification, conditional reconnect writes, pairing route behavior, and device-page rendering.
- Collector JSONL, bounded Codex, cursor, and Antigravity coverage is included in the complete
  collector suite; the final focused run covered 56 files and 548 tests.

This update changes only review documentation. It does not make T07 local reconciliation, T09
independent review, or T10 private Cloudflare validation complete.

## 2026-07-25 Status Output Addendum

The prior frozen snapshot became stale when the local status command was changed to stop exposing
configuration identity fields. The final review re-read the status command, its direct regression,
and the `hookStatus` producer. The public status object now exposes only configuration-presence
booleans, the existing non-secret runtime settings, and a fixed whitelist of hook state values.
The internal notification-handler path and any future unrecognized hook metadata are not copied
into the public JSON.

The direct regression supplies both a local notification path and an unknown nested diagnostic
field, then asserts that neither can appear in serialized output. A real CLI shape check also
confirmed the fixed top-level and hook-key sets without printing local configuration values.

Current verification for this candidate:

- `pnpm test`: passed, 9 usage-core, 548 collector, and 578 Web tests (1,135 total).
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed, 352 tests.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- Web/D1 focused regression: 8 files and 123 tests passed.
- Collector focused regression: 14 files and 77 tests passed.
- Every migration applied in name order to SQLite `:memory:`; critical-schema queries and
  `PRAGMA foreign_key_check` produced no output.
- A no-content credential-marker scan over tracked additions and untracked supporting files
  reported zero matches.

The reviewed inventory is now 94 tracked path changes and 36 untracked directly supporting files.
No confirmed security finding was identified. The user prohibited the `codex-security` plugin, so
this remains a manual diff-scoped review. T07 local reconciliation, T09 independent review, and
T10 private Cloudflare validation remain separate incomplete gates.

## 2026-07-25 Status State Correction

The initial hook-state whitelist omitted the existing `installed-local-history` status returned for
Antigravity GUI and IDE local-history detection. A failing regression confirmed the resulting
public `unknown` value, then the whitelist was corrected while retaining the rejection of paths and
unrecognized nested metadata. This is a local status-reporting correction only, with no network,
credential, filesystem-write, or privilege behavior.

Because the status runtime and direct regression changed after the preceding gate, the earlier
verification snapshot is historical evidence only. The full gate and manual review must be rerun
against the corrected candidate before any stateful reconciliation, deployment, commit, push, or
PR action.

## 2026-07-25 Notifier Lock Publication Closure

The final candidate also changes trailing notifier lock publication. The scheduler first acquires
`trailing.lock` with exclusive creation, then starts the detached worker. Instead of truncating
that lock to replace the parent PID with the child PID, it writes the complete child record to a
private temporary file and atomically renames it over the lock. A missing or invalid child PID,
publication failure, or cleanup failure is reported explicitly; there is no fallback to a direct
overwrite.

The lock reader in the generated notify handler therefore sees either the complete parent record
or the complete child record. The deterministic in-memory race regression verifies both sides of
the atomic replacement. The detached handler integration regression repeatedly parses the real
temporary-directory lock while the scheduler hands it to the child and observes a valid positive
PID on every read. This boundary adds no network, privilege, credential, or unbounded data path.

Current final verification was rerun after this source and direct-test change:

- `pnpm test`: passed, 9 usage-core, 552 collector, and 578 Web tests (1,139 total).
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed, 353 tests.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- All migrations `0000` through `0029` applied in order to SQLite `:memory:`; the critical-schema
  query and `PRAGMA foreign_key_check` produced no output.
- A no-content high-confidence credential-marker scan across changed and untracked supporting
  files reported clear.

The final manual review inventory is 94 tracked path changes and 36 untracked supporting files.
No confirmed security finding was identified. The user prohibited the `codex-security` plugin, so
this remains a manual diff-scoped review. T07 local verification, T09 independent review, T10
private Cloudflare validation, upstream integration, commit, push, and PR creation remain separate
incomplete gates.

## 2026-07-25 macOS Clone Helper Closure

The candidate changed after the preceding freeze to replace one Ruby `clonefile(2)` process per
Codex session file with one fixed-path, scope-local helper. The manual review re-read the complete
helper protocol and its integration into scoped copying. `/usr/bin/ruby` is an absolute executable
path, source and target paths have already passed root containment checks, requests are JSON lines,
and helper responses are capped at 8 KiB before parsing. The helper is created only while a frozen
scope is copied and is closed before `ccusage` is invoked.

The review found and corrected one failure-path omission: a helper that exited after a successful
copy but before explicit scope cleanup could previously be treated as a successful close. Cleanup
now drains stderr, terminates an open helper deterministically, and returns the original helper
failure after close. The direct regression covers malformed responses and a late unexpected exit,
including verification that the helper close path ran. Unsupported CoW errors alone retain the
bounded standard-copy fallback; permission, protocol, path, and unrelated `ENOENT` failures remain
explicit errors.

No confirmed security finding was identified. The final inventory is 95 tracked path changes
(including 4 deletions) and 38 untracked directly supporting files relative to
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`. The user prohibited the `codex-security` plugin, so no
plugin scan was run.

Current final verification for this runtime snapshot:

- `pnpm test`: passed, usage-core 9, collector 562, and Web 578 tests (1,149 total).
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed, 353 tests.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- The focused helper, scope, race, bounded-scan, retry, and attribution-cache regression passed
  with 57 collector files and 562 tests.
- The focused Web/D1 migration, critical-schema, reconnect, pairing-route, and devices-page
  regression passed with 8 files and 123 tests.
- Every `0000` through `0029` migration applied in name order to SQLite `:memory:`; the critical
  schema queries and `PRAGMA foreign_key_check` produced no output.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` passed.
- High-confidence credential marker scans over the tracked diff and untracked supporting files
  reported clear without printing file content.

The focused Web test loader emits Node's `module.register()` deprecation warning from the existing
Vite/Tailwind toolchain. It is not a test, typecheck, build, audit, migration, or application
failure and remains a documented dependency warning. This review is local static and regression
evidence only. T07 client reconciliation, T09 independent review, and T10 private Cloudflare
validation remain required before release.

## 2026-07-26 Upload Deadline Closure

The prior review snapshot became stale when real local snapshot-hash reconciliation encountered a
TLS reset after the collector had finished local work. The upload path retried failed requests but
had no per-request deadline, so a half-open connection or a response whose JSON body never settled
could retain the collector and scheduler locks indefinitely.

The revised upload path creates a fresh `AbortController` per attempt, forwards an existing caller
abort signal, and applies the same bounded deadline to the fetch operation and response JSON
parsing. The default deadline is 30 seconds, an explicit positive environment value can shorten or
extend it only up to 120 seconds, and every timeout is a visible error that uses the existing
three-attempt retry policy. Non-retryable HTTP responses and invalid response payloads retain their
previous immediate failure semantics. The injected fetcher is still invoked with `globalThis` as
its receiver, preserving compatibility with Web-platform fetch implementations.

The review checked that the new scope neither logs nor serializes the authorization header, upload
token, snapshot content, endpoint value, response body, or abort reason. It does not add a new
network destination, persistence location, subprocess, privilege boundary, fallback upload mode,
or silent success path. Timers and forwarded listeners are removed in `finally`; an ignored abort
cannot hold the caller because the awaited wrapper rejects on the controller signal while retaining
the underlying promise rejection handler.

Direct regressions prove that a non-settling `/check` request is aborted and retried three times,
and that a non-settling successful upload response body has the same bounded behavior. Existing
hash-check fallback, retryable response, non-retryable response, batch, and receiver-context
coverage remains green.

Current verification for the 2026-07-26 frozen runtime and direct-test snapshot:

- `pnpm test`: passed, usage-core 9, collector 564, and Web 578 tests (1,151 total).
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed, 353 tests.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- `pnpm exec vitest run deploy-config.test.ts development-seed-migration.test.ts pairing-code-index-migration.test.ts`:
  passed, 33 Web/D1 migration and schema tests.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- A no-content high-confidence credential-marker scan across 97 tracked changed paths and 38
  untracked supporting paths reported zero matches.

No confirmed security finding was identified. The user prohibited the `codex-security` plugin, so
this remains a manual diff-scoped review. T07 client reconciliation, T09 independent review, and
T10 private Cloudflare validation remain separate required gates.

## 2026-07-26 Final Freeze Gate

The candidate was re-reviewed after the final Codex hook child-session race handling and upload
request/response deadline changes. The review baseline remains
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`; the frozen inventory contains 97 tracked path
changes (93 modified and 4 deleted) and 39 directly supporting untracked files.

Manual review covered the changed Web/D1 transaction and migration paths, bounded collector file
and cursor paths, upload retry/deadline behavior, Codex child-session retry boundaries, local
hook/statusline/coordinator/upgrade ownership and failure paths, package overrides, and direct
supporting tests. It specifically confirmed that a child-session race receives one narrow retry
only, persistent or non-race failures remain visible with the cursor pending, request and JSON
body waits have bounded retries, lock replacement cannot be removed by a prior owner, and the
canonical Antigravity full rebuild replaces rather than accumulates historical daily totals.

No reportable security finding was confirmed. A no-content high-confidence credential marker
scan over tracked additions/modifications and untracked supporting files produced no matches. The
user prohibited the `codex-security` plugin, so no plugin scan was run.

Current verification for this frozen runtime and direct-test snapshot:

- `pnpm test`: passed, usage-core 9, collector 567, and Web 578 tests (1,154 total).
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed, 353 tests.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- Focused Web/D1 regression: 8 files and 123 tests passed.
- Focused collector regression: 10 files and 52 tests passed.
- Every migration `0000` through `0029` applied in order to SQLite `:memory:`; critical-schema
  queries and `PRAGMA foreign_key_check` produced no output.

The Web test loader continues to emit Node's `module.register()` deprecation warning from the
existing Vite/Tailwind dependency chain. It did not occur as a test, typecheck, build, audit, or
migration failure. This gate is local static and regression evidence only. It does not prove
current collector reconciliation, private Cloudflare deployment, authenticated pages, or real
ingest; those remain T07, T09, and T10 gates.

## 2026-07-27 Final Freeze Addendum

The previous freeze became stale after the Codex hook cursor gained a stable profile identity. The
review confirmed a concrete data-loss case before the change: a single configured profile can move
from one `CODEX_HOME` to another while retaining a colliding relative session path. If the old
legacy cursor contains an unacknowledged snapshot, treating the new home as the same cursor can
replace that entry; a later successful acknowledgement then loses the old usage permanently.

The current cursor stores an irreversible SHA-256 profile marker. A matching profile retains the
legacy cursor, while an unmarked or mismatched profile enters the explicit migration path. Pending
legacy entries that cannot be assigned remain separately uploadable and acknowledgeable. The new
deterministic regression first reproduced the lost `15 + 25` token case, then proves both values
survive profile migration and acknowledgement.

The final manual review covered the full candidate relative to
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: 97 tracked path changes (93 modified and 4 deleted)
and 44 untracked directly supporting paths. It re-read the new Codex profile/cursor/ACK path, the
Antigravity CLI and GUI/IDE collection and cursor paths, Web/D1 transactions and migrations,
hook/statusline/coordinator/upgrade error propagation, package changes, and supporting tests. No
reportable security, data-correctness, compatibility, or reliability finding was confirmed. The
user prohibited the `codex-security` plugin, so no plugin scan was run.

Verification for this freeze:

- `pnpm test`: passed, usage-core 9, collector 578, and Web 578 tests (1,165 total).
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed, 353 tests.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- Focused Web/D1 regression: 8 files and 123 tests passed.
- Focused collector regression: 10 files and 162 tests passed.
- Every migration `0000` through `0029` applied in order to a temporary SQLite database; the
  critical-schema query and `PRAGMA foreign_key_check` produced no output.
- A no-content high-confidence credential-marker scan over 137 changed or supporting paths
  reported zero matches.

This is local static and regression evidence only. It permits the controlled T07 client
reconciliation but does not prove a private Cloudflare deployment, authenticated-page rendering,
or real collector ingestion. Those remain separate T07, T09, and T10 gates.

## 2026-07-27 Upstream Integration Re-Gate

The branch was fast-forwarded to include four upstream commits before this review. The Windows
and hook runtime changes were re-read together with the branch diff. The three integration test
conflicts found after the merge were limited to a duplicate import, four SQLite shell fixtures,
and a Windows hidden-process assertion count; they were repaired with the existing injected
`readSqlite` seam and the generated handler's actual call count. No production behavior was
changed by those repairs.

The current inventory is 102 tracked path changes and 45 supporting untracked paths relative to
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`. The manual review rechecked tenant-scoped D1 writes,
migration ordering, bounded local file and JSONL reads, cursor ACK/rebuild behavior, subprocess
ownership, statusline passthrough, Windows liveness, dependency overrides, and secret logging
boundaries. The high-confidence credential-marker scan reported zero matches without printing
candidate content. No confirmed security, privacy, data-correctness, compatibility, or reliability
finding was identified.

Current re-gate evidence:

- `pnpm test`: usage-core `9/9`, collector `595/595`, Web `580/580`; Web was also independently
  rerun with `580/580` after the workspace output was incomplete.
- `pnpm typecheck` passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: `354/354` passed.
- `pnpm build` passed.
- `pnpm audit --audit-level=high` reported no known vulnerabilities.
- Web/D1 focused regression: `35/35` passed.
- All migrations `0000` through `0029` applied in order to SQLite `:memory:`; critical schema and
  `PRAGMA foreign_key_check` produced no output.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` passed.

OMP was skipped at the user's direction and no OMP configuration was changed. This remains local
static and regression evidence only; T07 client verification, the final T09 review record, and
T10 private Cloudflare validation are still required.

## 2026-07-27 Final Current-Candidate Re-Gate

The upstream-integration review snapshot became stale after the collector was changed to resolve a
caller-supplied session-root symlink once and retain that physical read root for the whole scan. The
logical configured path remains the cache and source identity, so equivalent macOS path spellings do
not create a cursor or attribution-cache identity drift. Nested symlink entries and final JSONL
files remain rejected. The deterministic regression switches the root symlink after discovery and
proves that the collector reads only the initial target.

This review re-read the complete current diff relative to
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: 104 tracked path changes (5 added, 95 modified, and
4 deleted) plus 43 directly supporting untracked paths. It covered tenant-scoped Web/D1 writes and
migrations, local file and JSONL bounds, cursor acknowledgement and rebuild protocols, clone-helper
and subprocess ownership, hook/statusline/upgrade failure paths, package overrides, and supporting
tests. The independent-review receipts were checked at their exact call paths: oversized irrelevant
JSON keys remain structurally validated but are not treated as semantic fields; clone helper requests
and direct JSONL streams have explicit total deadlines and byte caps; cursor offset and Antigravity
acknowledgement inputs are validated; comma-containing single Codex homes use an unambiguous JSON
array configuration; and the seed-cleanup contract runs under immediate and deferred foreign-key
enforcement. No confirmed security, privacy, data-correctness, compatibility, or reliability finding
remains.

Current verification:

- `pnpm test`: passed, usage-core 9, collector 599, and Web 580 tests (1,188 total).
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: 354 tests passed.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- Every migration applied in name order to a temporary SQLite database; the critical-schema query and
  `PRAGMA foreign_key_check` produced no output.
- A no-content high-confidence marker scan of tracked additions/modifications and all untracked
  supporting files reported zero potential credential matches.

The user prohibited the `codex-security` plugin, so no plugin scan was run. OMP is explicitly
skipped at the user's direction: it was not waited on, retried, configured, or counted as a passing
review. This is local static and regression evidence only. It unlocks the current T07 local client
verification, not deployment, authenticated-page rendering, or real collector ingestion.

## 2026-07-28 Final Freeze Evidence

The current candidate contains 107 tracked path changes and 43 directly supporting untracked paths
relative to `c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`. The delta after the prior review was
re-read at the GUI/IDE SQLite-reset, Antigravity cursor acknowledgement, Codex scope, session-file,
hook-lock, upgrade, Web/D1, dependency, migration, and documentation boundaries. No confirmed
security, privacy, data-correctness, compatibility, or reliability finding remains.

Current verification:

- `pnpm test`: usage-core `9/9`, collector `604/604`, and Web `580/580`, for `1,193` tests.
- `pnpm typecheck`, `node --test skills/tokenboard/scripts/*.test.mjs` (`354/354`), `pnpm build`,
  `pnpm audit --audit-level=high`, and the baseline `git diff --check` all passed.
- Focused Web/D1 migration and schema contracts passed `35/35`, including immediate and deferred
  foreign-key seed cleanup, the pairing-code index migration, and critical schema validation.
- A no-content credential-marker scan of tracked additions/modifications and all untracked support
  files reported zero matches.

The multi-profile Codex pending-copy question was verified with the locally locked
`ccusage@20.0.18` binary in an isolated synthetic fixture. Each home independently reported 15
tokens for the same byte-identical session, while the comma-joined two-home invocation also
reported 15 tokens. The current copied-pending de-duplication therefore matches this exact
same-session behavior. This does not claim a rule for distinct session identities.

The user prohibited the `codex-security` plugin, so no plugin scan was run. OMP is explicitly
skipped at the user's direction: it was not waited on, retried, configured, or counted as a passing
review. This evidence unlocks T07 local-client reconciliation only; private deployment, authenticated
page rendering, and real ingest remain separate gates.

## 2026-07-28 Signal-Drain Retention Repair

The manual hook/coordinator review found a confirmed reliability defect after the prior freeze: a
queued or legacy notifier signal is atomically renamed into a drain file before parsing. If that
read fails, the former unconditional cleanup removed the drain file and lost the deferred hook
work. The implementation now preserves unreadable drain files, includes only strict known
queue/drain names in recovery, and deletes a retained file only after its contents have been read
successfully. A later coordinator run consumes the retained source together with its current
trigger; concurrent same-source writes remain in their stable queue marker.

Deterministic regressions cover both queued and legacy signal drain read failures followed by a
successful later retry. The focused coordinator, notifier, hook, sync, upgrade, and statusline
suite passed `222/222`. This runtime and direct-test change invalidates all earlier full-gate
counts in this document. The candidate remains in T08 until the complete current gate, migration
contract, dependency audit, credential-marker scan, and final manual review are rerun after the
source diff is frozen.

## 2026-07-28 Restarted Final Gate

The post-restart review used the fixed baseline
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`. The current candidate contains 109 tracked path
changes: 105 additions or modifications and 4 deletions. It also has 49 untracked directly
supporting files. Manual review re-read the changed D1 conditional writes and migrations, bounded
collector JSONL, cursor, cache, worker and clone boundaries, Antigravity sources, hook, statusline,
coordinator and upgrade failure paths, dependency overrides, and direct supporting tests.

No confirmed security, privacy, data-correctness, compatibility, or reliability finding remains.
One external observation about Windows command injection was checked against the exact current
call path: CLI timezones are validated with `assertValidTimeZone`, and command shims reject shell
metacharacters before Windows `.cmd` execution. It is not a reproducible finding.

Verification for this gate:

- `pnpm test`: usage-core `9/9`, collector `623/623`, and Web `580/580`, totaling `1,212` tests.
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: `360/360` passed.
- Focused coordinator, lock and sync regression: `52/52` passed.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- All `0000` through `0029` migrations applied in order to a new SQLite in-memory database. The
  critical-schema query and `PRAGMA foreign_key_check` produced no output.
- A no-content high-confidence credential marker scan over tracked additions/modifications and all
  untracked supporting files reported zero matches.

The user prohibited the `codex-security` plugin, so no plugin scan was run. OMP remains explicitly
skipped at the user's direction and is not counted as review coverage. This local gate permits T07
client-state verification only; it does not prove private Cloudflare deployment, authenticated UI,
or real ingestion.

## 2026-07-28 Current Candidate Re-Gate

The candidate remains at 109 tracked path changes and 49 directly supporting untracked files
relative to `c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`. The changes after the previous gate were
re-read at the CLI strict-error flag, Codex attribution-cache, bounded canonical-attribution,
Antigravity SQLite full-scan, and sensitive token-rotation UI boundaries.

Four collector reliability fixes were confirmed and covered by deterministic regressions. The
Antigravity language-server strict mode is enabled only when
`TOKENBOARD_FAIL_ON_SOURCE_ERROR` is exactly `1`. A post-copy Codex attribution-cache warming
write now skips an absent or fingerprint-raced source file without converting optional cache
warming into a collection failure. A bounded canonical-attribution row that disappears briefly
causes one complete frozen-scope retry and then fails explicitly if still absent. An Antigravity
full SQLite scan now fails with a stable-directory retry diagnostic when an enumerated database
disappears, while an injected SQLite reader `ENOENT` remains a metadata-read failure instead of
being misreported as a missing `sqlite3` executable.

One proposed Windows command-injection path was not reproducible. CLI flag and environment
timezones are validated through `assertValidTimeZone` before provider invocation. Independently,
the default command runner rejects shell metacharacters in both the command and all arguments when
calling a Windows `.cmd` or `.bat` shim. The direct CLI-timezone and command-shim regressions pass,
as does the complete collector suite.

Current verification:

- `pnpm test`: usage-core `9/9`, collector `628/628`, and Web `580/580`, totaling `1,217` tests.
- `pnpm typecheck`, `pnpm build`, and `pnpm audit --audit-level=high` passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: `362/362` passed.
- The focused Web/D1 migration and schema suite passed `35/35`, including immediate and deferred
  foreign-key seed cleanup, pairing-code index validation, and critical-schema checks.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` passed.
- A no-content high-confidence credential-marker scan over current tracked additions/modifications
  and all untracked supporting files reported zero matches. The four deleted paths were excluded
  because they have no working-tree content to scan.

No confirmed security, privacy, data-correctness, compatibility, or reliability finding remains
from this manual review. CodeRabbit has no final current-candidate result and is not counted as
review coverage; prior agent output was incomplete. OMP remains explicitly skipped at the user's
direction. This documentation-only update does not make T07 local-client reconciliation, T09
independent review, or T10 private Cloudflare validation complete.

## 2026-07-30 Current Candidate Gate

The current uncommitted candidate adds notifier cooldown and signal-drain recovery handling plus
Codex child-session cache-counter compatibility and bounded diagnostic aggregation. The review
re-read the coordinator signal lifecycle, notifier cooldown validation, generated handler boundary,
child JSONL reader, correction arithmetic, and their direct regressions. The diagnostics wrapper
only coalesces the exact safe oversized-row summary emitted by the reader; malformed records,
filesystem failures, cache failures, and correction failures still report immediately.

The 558-line `codex-subagent-usage.ts` production file was added to the current size-review
inventory. It remains below the mandatory split threshold and keeps one correction boundary:
child-event identity, cross-profile aggregation, snapshot adjustment, and diagnostic forwarding.
The inventory records a concrete extraction condition before any further responsibility is added.

Current verification for this frozen runtime and direct-test candidate:

- `pnpm test`: passed, usage-core `9`, Web `582`, and collector `635` tests.
- `pnpm typecheck`: passed.
- `node --test skills/tokenboard/scripts/*.test.mjs`: `397` tests passed.
- `pnpm build`: passed.
- `pnpm audit --audit-level=high`: no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- Every migration from `0000` through `0029` applied in order to an in-memory SQLite database;
  the critical-schema queries and `PRAGMA foreign_key_check` produced no output.

A no-content credential-marker scan over the current branch diff and supporting untracked files
found only synthetic `tb_*` markers in three Web test files. The matched paths are test-only, the
values are fixtures for pairing and device flows, and no production source, configuration, review,
or untracked file matched. No candidate secret value was printed during the scan.

CodeRabbit reviewed the same uncommitted candidate. Its current-state wording observation for T09
and T10 is addressed by the task ledger: both are explicitly incomplete rather than inherited from
historic evidence. Its fixture suggestion is not a behavior finding: the new regression must create
byte-size-dependent oversized JSONL records and already uses the repository's JSONL test helper,
so replacing that generated input with a static fixture would not improve the covered boundary.

No confirmed security, privacy, data-correctness, compatibility, or reliability finding was
identified in this manual review. The user prohibited the `codex-security` plugin, and OMP remains
explicitly skipped rather than counted as review coverage. This local T08 evidence does not make
T07 local reconciliation, T09 independent review, or T10 private Cloudflare validation complete.

## 2026-07-30 Recovery Journal Follow-up

The previous current-candidate gate became stale when the hook audit identified a recovery-window
defect in the notifier signal lifecycle. `drainSignalSources()` created and then removed a recovery
journal before `executeSync()` began. A process termination in that interval could permanently lose
the queued source.

The follow-up review covers the current uncommitted delta on top of the previous gate:

- `coordinator-signal.mjs` now writes bounded, source-specific version-2 recovery journals before
  removing a queue or legacy drain entry. A legacy version-1 multi-source journal is migrated by
  first creating every source journal and only then removing the old record. A migration or cleanup
  error is explicit and leaves recoverable state on disk.
- `coordinator.mjs` acknowledges a source journal only after that source's `executeSync()` returns
  normally. A failed sync or acknowledgement cleanup preserves its journal and causes retry state
  to remain visible. A same-source signal arriving during execution remains in the separate queue
  and cannot be deleted by acknowledgement.
- Recovery journal data contains only a fixed source enum and schema version. It does not introduce
  credentials, paths, payload contents, session identifiers, subprocesses, network access, or an
  unbounded current-format file-growth path; there is at most one version-2 journal for each
  supported source, while a failed legacy cleanup remains visible for a later retry.
- The notifier cooldown configuration remains bounded to `60000` through `3600000` milliseconds
  when read from the environment. Invalid configuration reports an error after the hook signal has
  already been persisted, so it cannot discard work silently.
- The Codex child correction review rechecked the additive-cache discriminator, per-field
  nonnegative subtraction, bounded worker reads, and diagnostic aggregation. The aggregate matches
  only the reader's safe oversized irrelevant-row summary; all malformed, I/O, cache, and correction
  errors remain individually observable.

Deterministic regressions cover the drain-to-execution crash window, legacy multi-source migration,
per-source success acknowledgement, partial source failure, acknowledgement cleanup failure, and a
new same-source signal during execution. The current verification run passed `pnpm test` with 9
usage-core, 582 Web, and 635 collector tests; `node --test skills/tokenboard/scripts/*.test.mjs`
with 402 tests; `pnpm typecheck`; `pnpm build`; and `pnpm audit --audit-level=high`. Every migration
from `0000` through `0029` applied in order to an in-memory SQLite database, with no output from the
critical-schema query or `PRAGMA foreign_key_check`. The final diff whitespace check and a
high-confidence credential-marker scan reported no issues or matches.

No additional confirmed P1/P2 security, privacy, data-correctness, compatibility, or reliability
finding was identified. This is still a manual local review: Claude's prior empty output is not an
external-review receipt, OMP remains explicitly skipped, and current T07, T09, and T10 remain
incomplete.

## 2026-07-30 Antigravity CLI First-Bounded-Scan Closure

The prior gate became stale when the T02 range audit showed that a first bounded Antigravity CLI
scan could read the default 64 SQLite databases, emit a partial daily-model aggregate, and persist
that partial result before the remaining databases were examined. This was reproducible on the
local machine, which has 502 Antigravity CLI conversation databases. It is a data-correctness
boundary, not a hash instability or a statusline behavior.

The final current candidate makes the SQLite reader report `completeDirectoryScan`. A full-history
run and an explicitly unbounded `maxDbFiles: null` run require every enumerated database to be
read. Before a full-history baseline exists, any bounded scan with an incomplete directory fails
before any cursor write and requires `--since all`, including when the selected databases happen to
contain no window usage or pending snapshots. Once a complete baseline exists, bounded incremental
scanning retains its normal behavior. The statusline remains local-only diagnostics and is not an
upload-metering fallback.

The deterministic coverage verifies incomplete bounded usage rejection, incomplete full-history
rejection, incomplete empty-scan rejection without persistence, pending-snapshot rejection, and bounded increments after a
complete baseline. The real isolated-state validation confirmed that a recent-month cold start was
blocked with an empty temporary state directory, while `--since all` created 25 snapshot groups and
a complete baseline without uploading or modifying the production cursor.

For this final runtime and direct-test candidate, the complete gate passed again: `pnpm test` with
usage-core `9`, Web `582`, and collector `640`; `node --test
skills/tokenboard/scripts/*.test.mjs` with `402`; `pnpm typecheck`; `pnpm build`; `pnpm audit
--audit-level=high`; and `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`. Every D1
migration from `0000` through `0029` applied in order to an in-memory SQLite database, and both the
critical-schema query and `PRAGMA foreign_key_check` produced no output. A no-content credential
marker scan over candidate content found no credential-shaped values; expected field-name matches
were limited to tests and scripts.

The final manual review re-read the affected Antigravity SQLite boundary plus the existing Codex,
hook recovery, Web/D1, dependency, and direct-test boundaries. No confirmed P1/P2 security,
privacy, data-correctness, compatibility, or reliability finding remains. The user prohibited the
`codex-security` plugin. OMP remains explicitly skipped and is not counted as review coverage. This
closes T08 only; T07 local reconciliation, T09 independent review, and T10 private Cloudflare
validation remain incomplete.

## 2026-07-30 Final Frozen-Candidate Refresh

The candidate changed after the prior closure to preserve literal backslashes in POSIX Codex session
file names while retaining slash normalization on Windows. This is a file-identity correctness fix,
so every runtime and direct-test gate was rerun before treating the candidate as frozen.

- `pnpm test`: passed with 9 usage-core, 582 Web, and 649 collector tests.
- `pnpm typecheck`, `node --test skills/tokenboard/scripts/*.test.mjs` (402 tests), `pnpm build`,
  and `pnpm audit --audit-level=high`: passed.
- All 30 migrations (`0000` through `0029`) applied in order to SQLite `:memory:`; the critical
  schema query and `PRAGMA foreign_key_check` both produced no output. The focused Web deployment
  and migration suite passed 35 tests.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` passed. Wrangler `4.116.0`
  completed `deploy --dry-run` after the production build, without publishing a Worker or applying
  a remote migration.
- CodeRabbit `0.7.1` reviewed the current uncommitted 37-file scope, including both direct
  untracked tests, and returned 0 issues. Its earlier POSIX path-normalization suggestion is now
  covered by the platform-specific implementation and regression.

The manual review rechecked the changed path normalization and its Codex multi-profile call sites,
alongside the Antigravity, hook recovery, Web/D1, dependency, and direct-test boundaries covered
by this candidate. No confirmed security, privacy, data-correctness, compatibility, or reliability
finding remains in the local frozen gate. The user prohibited the `codex-security` plugin; OMP is
explicitly skipped and is not counted as review coverage. T07 must still be rerun for this
file-identity change, and T09/T10 remain incomplete.

## 2026-07-31 Candidate Reopened

After the preceding gate, `coordinator-signal.mjs` changed to recognize legacy Codex signal filenames
and their retained drain files, with direct regression coverage in
`coordinator-signal.test.mjs`. This runtime and direct-test change invalidates the preceding full gate,
manual review, and CodeRabbit result for the current candidate. The 2026-07-30 evidence remains a
historical record only; a fresh complete gate and manual review are required before T07 can resume.
T09 and T10 remain incomplete, and OMP remains explicitly skipped at the user's direction.

CodeRabbit `0.7.1` was authenticated on 2026-07-31, but the current uncommitted review returned a
service `rate_limit` with an estimated 22-minute reset. No current-candidate CodeRabbit result was
produced; the prior cached or historical result is not counted as review coverage.

## 2026-07-31 Current Gate Closure

The legacy signal filename compatibility change was revalidated with a focused `66/66` coordinator,
signal, and notifier regression. The complete gate then passed with `pnpm test` covering 9 usage-core,
582 Web, and 649 collector tests; `pnpm typecheck`; `node --test skills/tokenboard/scripts/*.test.mjs`
with `403/403`; `pnpm build`; `pnpm audit --audit-level=high`; and the baseline `git diff --check`.
The Web migration/schema suite remained `79/79`, and Wrangler `4.116.0` `deploy --dry-run` resolved
the Worker, Assets, D1, and variable bindings before exiting without publishing or applying a remote
migration. Migrations `0000` through `0029`, the critical schema query, and the foreign-key check
remained clean. The high-confidence credential-shape scan returned zero matches without printing
content.

The manual review found no confirmed P1/P2 behavior, data-correctness, privacy, security, or
compatibility issue in the current diff. CodeRabbit was unavailable due to the documented service
rate limit and is explicitly not counted as review coverage; the user also prohibited the
`codex-security` plugin and OMP remains skipped. T08 was complete for that candidate only. T07 local
reconciliation, T09 independent review, and T10 private Cloudflare validation remained outstanding.

## 2026-09-05 Current Candidate Revalidation

The candidate changed after the historical July closure and the August deployment records. This entry
is the current local gate for the dirty worktree; it does not claim a release deployment or merge.

- `pnpm test`: passed with usage-core `13/13`, Web `687/687`, and collector `935` passing with `3`
  existing platform scenarios skipped.
- `pnpm typecheck`, `pnpm build`, `node --test skills/tokenboard/scripts/*.test.mjs` (`528/528`),
  `pnpm audit --audit-level=high` (`No known vulnerabilities found`), and `git diff --check HEAD` passed.
- The collector review initially identified a short-read risk in Codex session-tail fingerprinting.
  `hashOpenFileTail` now reads until the complete bounded tail is filled and fails closed on early EOF;
  the deterministic short-read regression and collector typecheck passed. This fix is part of the current
  candidate and invalidates earlier gate counts.
- CodeRabbit `0.7.6` returned a complete collector review: the initial short-read finding and four
  follow-up collector findings were all fixed, and the final collector review returned `findings: 0`.
  Web, usage-core, skill and docs reviews also returned `findings: 0` after their respective checks. No
  CodeRabbit result is treated as a substitute for real client, Windows/Linux host, or private Cloudflare
  validation.
- No `codex-security` plugin was used. No commit, push, deployment, or destructive worktree operation was
  performed in this revalidation.
