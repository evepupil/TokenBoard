#!/usr/bin/env node
/**
 * build-codex-fixture.mjs — write (or rewrite) the committed Codex fixture tree
 * under clients/go/internal/collect/adapters/codex/testdata/codex-fixture.
 *
 * The tree is small, deterministic and reviewed as text in git; this script
 * exists so the content is readable in one place instead of twenty JSONL files,
 * and so a reviewer can regenerate it and see the diff. The generator
 * (clients/go/scripts/gen-codex-goldens.mjs) reads the committed tree; it does
 * not run this script, so a corrupted tree cannot silently mint new goldens.
 *
 * Scenarios, each mirroring a rule the adapter tests pin line by line:
 *
 *   alpha    normal cumulative events with last_token_usage present
 *   beta     last_token_usage absent (cumulative differences only)
 *   gamma    compacted marker pairs, in both orders, plus an unmatched record
 *   parent / child   fork replay: the child copies the parent's events
 *   burst    fork with an unavailable parent and a sub-second rewrite burst
 *   review   codex-auto-review model fallback
 *   fast/flex  thread_settings_applied service tiers
 *   spaced   a whitespace-formatted event, and a >64 KiB one
 *   archived a rollout under archived_sessions
 *   zeta     concatenated zstd frames with a truncated tail frame
 *   broken   one line with invalid UTF-8 in an unmodeled member (billed by
 *            ccusage) and one non-JSON line (dropped), next to a valid event
 *   exec     the headless `codex exec` shape (usage on a result object)
 *
 * Usage:
 *   node clients/go/internal/collect/adapters/codex/testdata/build-codex-fixture.mjs [root]
 *
 * The zstd file is compressed with node's bundled zstd at its default level.
 * Compression output is not guaranteed byte-stable across Node releases, so
 * this script is for (re)creating the tree, not for a CI diff: edit a text
 * fixture directly when only its content changes.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? process.argv[2] : join(scriptDir, "codex-fixture");

const files = {};

function json(value) {
  return JSON.stringify(value);
}

function sessionMeta(timestamp, id, parentId) {
  const payload = { id };
  if (parentId) payload.forked_from_id = parentId;
  return json({ type: "session_meta", timestamp, payload });
}

function turnContext(model) {
  return json({ type: "turn_context", payload: { model } });
}

function tokenCount(timestamp, info) {
  return json({ type: "event_msg", timestamp, payload: { type: "token_count", info } });
}

/** One token_count whose last and cumulative snapshots agree. */
function usageEvent(timestamp, usage) {
  return tokenCount(timestamp, { total_token_usage: usage, last_token_usage: usage });
}

function usage(input, options = {}) {
  return {
    input_tokens: input,
    ...(options.cached !== undefined ? { cached_input_tokens: options.cached } : {}),
    ...(options.created !== undefined ? { cache_creation_input_tokens: options.created } : {}),
    output_tokens: options.output ?? 0,
    ...(options.reasoning !== undefined ? { reasoning_output_tokens: options.reasoning } : {}),
    total_tokens: options.total ?? input + (options.output ?? 0),
  };
}

function lines(...entries) {
  return entries.join("\n") + "\n";
}

// alpha: cumulative snapshots with last_token_usage present. Two requests.
files["sessions/2026/05/18/rollout-2026-05-18T09-00-00-alpha.jsonl"] = lines(
  sessionMeta("2026-05-18T09:00:00.000Z", "alpha"),
  turnContext("gpt-5.1-codex"),
  usageEvent("2026-05-18T09:01:00.000Z", usage(1000, { cached: 200, output: 100, reasoning: 10, total: 1100 })),
  usageEvent("2026-05-18T09:05:00.000Z", usage(2500, { cached: 500, output: 300, reasoning: 30, total: 2800 })),
);

// beta: no last_token_usage at all; the adapter must difference the cumulative
// snapshots instead of reading them as one request each.
files["sessions/2026/05/19/rollout-2026-05-19T10-00-00-beta.jsonl"] = lines(
  sessionMeta("2026-05-19T10:00:00.000Z", "beta"),
  turnContext("gpt-5.1-codex"),
  tokenCount("2026-05-19T10:01:00.000Z", { total_token_usage: usage(500, { output: 50 }) }),
  tokenCount("2026-05-19T10:05:00.000Z", { total_token_usage: usage(900, { output: 90 }) }),
);

// gamma: token_usage_record pairs with the compacted marker in both orders, and
// one record that never pairs (it must not be counted).
files["sessions/2026/05/20/rollout-2026-05-20T08-00-00-gamma.jsonl"] = lines(
  sessionMeta("2026-05-20T08:00:00.000Z", "gamma"),
  turnContext("gpt-5.1-codex"),
  json({ type: "token_usage_record", timestamp: "2026-05-20T08:01:00.000Z", payload: { response_id: "rec-pending", usage: { input_tokens: 5, output_tokens: 2 } } }),
  json({ type: "compacted", payload: { compaction_response_id: "rec-pending" } }),
  json({ type: "compacted", payload: { compaction_response_id: "rec-first" } }),
  json({ type: "token_usage_record", timestamp: "2026-05-20T08:02:00.000Z", payload: { response_id: "rec-first", usage: { input_tokens: 7, output_tokens: 3 } } }),
  json({ type: "token_usage_record", timestamp: "2026-05-20T08:03:00.000Z", payload: { response_id: "rec-unmatched", usage: { input_tokens: 9, output_tokens: 4 } } }),
);

// parent / child: the child starts by replaying the parent's three events, then
// adds one of its own. The replayed prefix must not be billed twice.
const parentEvents = [
  usageEvent("2026-05-20T12:00:00.000Z", usage(100, { output: 10 })),
  usageEvent("2026-05-20T12:00:10.000Z", usage(200, { output: 20 })),
  usageEvent("2026-05-20T12:00:11.000Z", usage(300, { output: 30 })),
];
files["sessions/2026/05/20/rollout-2026-05-20T12-00-00-parent.jsonl"] = lines(
  sessionMeta("2026-05-20T12:00:00.000Z", "fork-parent"),
  turnContext("gpt-5.1-codex"),
  ...parentEvents,
);
files["sessions/2026/05/21/rollout-2026-05-21T09-00-00-child.jsonl"] = lines(
  sessionMeta("2026-05-21T09:00:00.000Z", "fork-child", "fork-parent"),
  turnContext("gpt-5.1-codex"),
  ...parentEvents,
  usageEvent("2026-05-21T09:00:01.000Z", usage(400, { output: 40 })),
);

// burst: a fork whose parent is not in the tree, so the replay heuristic falls
// back to detecting a rewritten burst: the first two events sit 400 ms apart and
// are suppressed, the third (a minute later) is counted.
files["sessions/2026/05/22/rollout-2026-05-22T09-00-00-burst.jsonl"] = lines(
  sessionMeta("2026-05-22T09:00:00.000Z", "burst-child", "ghost-parent"),
  turnContext("gpt-5.1-codex"),
  usageEvent("2026-05-22T09:00:00.000Z", usage(100, { output: 10 })),
  usageEvent("2026-05-22T09:00:00.400Z", usage(100, { output: 10 })),
  usageEvent("2026-05-22T09:01:30.000Z", usage(7, { output: 3 })),
);

// review: the synthetic codex-auto-review model is rewritten to the model that
// was current on the event's date.
files["sessions/2026/05/25/rollout-2026-05-25T09-00-00-review.jsonl"] = lines(
  sessionMeta("2026-05-25T09:00:00.000Z", "review"),
  turnContext("codex-auto-review"),
  usageEvent("2026-05-25T09:01:00.000Z", usage(1000, { cached: 100, output: 20 })),
);

// fast / flex: the thread_settings_applied tier is what the multiplier applies
// to, and it is recorded per event.
files["sessions/2026/05/26/rollout-2026-05-26T09-00-00-fast.jsonl"] = lines(
  sessionMeta("2026-05-26T09:00:00.000Z", "fast"),
  json({ type: "event_msg", timestamp: "2026-05-26T09:00:30.000Z", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "fast" } } }),
  turnContext("gpt-5.4"),
  usageEvent("2026-05-26T09:01:00.000Z", usage(1000, { cached: 200, output: 100 })),
);
files["sessions/2026/05/27/rollout-2026-05-27T09-00-00-flex.jsonl"] = lines(
  sessionMeta("2026-05-27T09:00:00.000Z", "flex"),
  json({ type: "event_msg", timestamp: "2026-05-27T09:00:30.000Z", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "flex" } } }),
  turnContext("gpt-5.4"),
  usageEvent("2026-05-27T09:01:00.000Z", usage(1000, { cached: 200, output: 100 })),
);

// spaced: the compact finders miss this event, so the second-stage whitespace
// scan has to classify it. The second line is the same shape past the 64 KiB
// nested-search gate.
const spacedEvent = (timestamp, input) =>
  `{ "type" : "event_msg", "timestamp" : "${timestamp}", "payload" : { "type" : "token_count", "info" : { "last_token_usage" : { "input_tokens" : ${input}, "output_tokens" : 2 } } } }`;
const bigFill = "x".repeat(70 * 1024);
const bigSpacedEvent =
  `{ "type" : "event_msg", "timestamp" : "2026-05-28T09:02:00.000Z", "note" : "${bigFill}", "payload" : { "type" : "token_count", "info" : { "last_token_usage" : { "input_tokens" : 30, "output_tokens" : 3 } } } }`;
files["sessions/2026/05/28/rollout-2026-05-28T09-00-00-spaced.jsonl"] = lines(
  sessionMeta("2026-05-28T09:00:00.000Z", "spaced"),
  turnContext("gpt-5.1-codex"),
  spacedEvent("2026-05-28T09:01:00.000Z", 11),
  bigSpacedEvent,
);

// archived: proves archived_sessions is scanned alongside sessions.
files["archived_sessions/2026/05/18/rollout-2026-05-18T18-00-00-archived.jsonl"] = lines(
  sessionMeta("2026-05-18T18:00:00.000Z", "archived"),
  turnContext("gpt-5.1-codex"),
  usageEvent("2026-05-18T18:01:00.000Z", usage(50, { output: 5 })),
);

// broken: invalid UTF-8 inside a member the typed decode never reads, and an
// unparseable line, between two valid ones. serde validates only the strings it
// decodes, so ccusage bills the corrupted line's 9 input tokens (the unknown
// member is skipped, not validated) and drops only the non-JSON line; the
// golden's 2026-05-24 row pins both halves.
files["sessions/2026/05/24/rollout-2026-05-24T09-00-00-broken.jsonl"] = Buffer.concat([
  Buffer.from(lines(sessionMeta("2026-05-24T09:00:00.000Z", "broken"), turnContext("gpt-5.1-codex"))),
  Buffer.from('{"type":"event_msg","timestamp":"2026-05-24T09:00:30.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":9,"note":"'),
  Buffer.from([0xff]),
  Buffer.from('"}}}}\n'),
  Buffer.from("this line is not json\n"),
  Buffer.from(lines(usageEvent("2026-05-24T09:01:00.000Z", usage(20, { output: 2 })))),
]);

// exec: the `codex exec` headless shape - no session record types, usage on a
// result object. The root timestamp keeps the file's mtime out of the report,
// and the date sits before the window so only the unbounded daily carries it.
files["sessions/2026/05/12/rollout-2026-05-12T07-00-00-exec.jsonl"] = lines(
  json({ timestamp: "2026-05-12T07:00:00.000Z", model: "gpt-5.1-codex", result: { usage: usage(14, { cached: 2, output: 3, reasoning: 1, total: 17 }) } }),
);

// zeta: Codex appends whole zstd frames, and a frame still being written is cut
// short. The complete frames count; the truncated tail contributes nothing.
const zstdFrame = (text) => zstdCompressSync(Buffer.from(text));
const zetaTail = zstdFrame(lines(usageEvent("2026-05-23T09:03:00.000Z", usage(999, { output: 99 }))));
const zeta = Buffer.concat([
  zstdFrame(
    lines(
      sessionMeta("2026-05-23T09:00:00.000Z", "zeta"),
      turnContext("gpt-5.1-codex"),
      usageEvent("2026-05-23T09:01:00.000Z", usage(60, { output: 6 })),
    ),
  ),
  zstdFrame(lines(usageEvent("2026-05-23T09:02:00.000Z", usage(70, { output: 7 })))),
  zetaTail.subarray(0, Math.floor(zetaTail.length / 2)),
]);
files["sessions/2026/05/23/rollout-2026-05-23T09-00-00-zeta.jsonl.zst"] = zeta;

rmSync(root, { recursive: true, force: true });
for (const [relativePath, content] of Object.entries(files)) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
console.log(`build-codex-fixture: wrote ${Object.keys(files).length} files under ${root}`);
