#!/usr/bin/env node
/**
 * gen-claude-goldens.mjs — mint the Claude adapter's row-level goldens from a
 * real ccusage 20.0.33 binary.
 *
 * The goldens are the end-to-end anchor for clients/go/internal/collect/
 * adapters/claude: they are the exact three JSON documents the upstream
 * `ccusage claude daily` and `ccusage claude session` commands print for the
 * committed fixture tree, so goldens_test.go compares the Go port against
 * ccusage's own answers rather than against itself.
 *
 * Recipe (three commands, one shared environment):
 *
 *   CLAUDE_CONFIG_DIR=<fixture-tree> ccusage claude daily --json --breakdown \
 *     --offline --single-thread -z UTC -s 20260225 -u 20260331 --mode auto
 *   ... same with --mode calculate
 *   CLAUDE_CONFIG_DIR=<fixture-tree> ccusage claude session --json \
 *     --offline --single-thread -z UTC -s 20260225 -u 20260331
 *
 * Four details are load-bearing and each was learned by measurement:
 *
 *   1. NO `--config`. The S1 pricing generator passes the shipped
 *      packages/collector/ccusage.json because it is minting pricing parity
 *      goldens; this corpus is minting ADAPTER parity goldens and the Go test
 *      calls Collect with Overrides == nil. Passing a config here would apply
 *      `defaults.pricingOverrides` on the ccusage side only and every
 *      overridden model (claude-opus-4-6 is one) would mismatch. The
 *      environment assertions below exist because without --config ccusage will
 *      happily discover a user-level config file instead.
 *   2. `--offline` is REQUIRED: without it ccusage fetches the day's live prices
 *      and the goldens drift daily.
 *   3. `--single-thread` keeps the collection order — and therefore the dedupe
 *      index's first-seen order, which decides ties — deterministic.
 *   4. Fixture JSONL must be COMPACT (no space after a colon). ccusage 20.0.33
 *      returns an EMPTY `daily` array when a line is pretty-printed. The single
 *      deliberate exception is the invalid-line fixture in
 *      projects/project-b/session-gamma.jsonl, which writes `"usage": {` on
 *      purpose to prove the line is dropped; this script asserts that it is the
 *      ONLY non-compact line so a stray editor format cannot slip through.
 *
 * Usage:
 *   node clients/go/scripts/gen-claude-goldens.mjs
 *   CCUSAGE_BIN=/path/to/ccusage node clients/go/scripts/gen-claude-goldens.mjs
 *
 * Output: clients/go/internal/collect/adapters/claude/goldens/claude-reports.json
 *
 * The script is byte-stable: two consecutive runs produce identical files.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");
const fixtureDir = join(
  repoRoot,
  "clients",
  "go",
  "internal",
  "collect",
  "adapters",
  "claude",
  "testdata",
  "claude-fixture",
);
const goldensDir = join(repoRoot, "clients", "go", "internal", "collect", "adapters", "claude", "goldens");
const goldensPath = join(goldensDir, "claude-reports.json");

const ccusageBin = process.env.CCUSAGE_BIN || join(homedir(), ".tokenboard", "bin", "ccusage");

/** The binary this corpus was frozen against (collect.go, paths.go headers). */
const expectedVersion = "20.0.33";
/** The window every command passes; it covers every fixture date (03-02..03-13). */
const since = "20260225";
const until = "20260331";
const timezone = "UTC";

function fail(message) {
  console.error(`gen-claude-goldens: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Version pin.
// ---------------------------------------------------------------------------
let versionOutput;
try {
  versionOutput = execFileSync(ccusageBin, ["--version"], { encoding: "utf8" }).trim();
} catch (error) {
  console.error(`gen-claude-goldens: cannot run ${ccusageBin}: ${error.message}`);
  console.error("  Pass the binary through CCUSAGE_BIN, or install ccusage " + expectedVersion + ".");
  process.exit(1);
}
if (versionOutput !== `ccusage ${expectedVersion}`) {
  fail(
    `version drift — the goldens are frozen against "ccusage ${expectedVersion}", ` +
      `${ccusageBin} reports "${versionOutput}".`,
  );
}

// ---------------------------------------------------------------------------
// 2. Clean environment.
//
// Without --config ccusage falls back to a user-level config file, and
// CCUSAGE_MODEL_ALIASES rewrites the model names that land in modelsUsed and
// modelBreakdowns. Any of them would change the goldens silently, so each one
// is a hard error instead.
// ---------------------------------------------------------------------------
const aliasValue = process.env.CCUSAGE_MODEL_ALIASES;
if (aliasValue !== undefined && aliasValue !== "") {
  fail(
    `CCUSAGE_MODEL_ALIASES is set to ${JSON.stringify(aliasValue)}; the goldens must be ` +
      "minted with an empty alias table so model names match the fixture verbatim.",
  );
}
const forbiddenConfigs = [
  join(homedir(), ".claude", "ccusage.json"),
  join(homedir(), ".config", "claude", "ccusage.json"),
  join(repoRoot, ".ccusage", "ccusage.json"),
  join(fixtureDir, "ccusage.json"),
];
for (const path of forbiddenConfigs) {
  if (existsSync(path)) {
    fail(
      `${path} exists; ccusage would apply it and the goldens would not match a ` +
        "no-override Collect. Move it aside and rerun.",
    );
  }
}

if (!existsSync(join(fixtureDir, "projects"))) {
  fail(`fixture tree ${fixtureDir} has no projects/ directory.`);
}

// ---------------------------------------------------------------------------
// 3. Fixture hygiene: one JSONL line per line, compact JSON, and a date set
//    every report must cover.
// ---------------------------------------------------------------------------
/** Every file under dir, as paths relative to dir with "/" separators, sorted. */
function relativeFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...relativeFiles(path, base));
    } else if (entry.isFile()) {
      files.push(relative(base, path).split(sep).join("/"));
    } else {
      fail(`${path} is neither a regular file nor a directory; the fixture tree must be plain files.`);
    }
  }
  return files.sort();
}

const fixtureFiles = relativeFiles(fixtureDir);
if (fixtureFiles.length === 0) {
  fail(`fixture tree ${fixtureDir} is empty.`);
}

// A date is "covered" when a fixture line names it. Both timestamp shapes count:
// the direct assistant line, and the AgentProgress wrapper whose timestamp sits
// at data.message.timestamp (the shape ccusage parses, daily.rs:206-227).
const timestampPattern = /"timestamp":"(\d{4}-\d{2}-\d{2})/g;
const fixtureDates = new Set();
const nonCompact = [];
for (const relativePath of fixtureFiles) {
  const content = readFileSync(join(fixtureDir, relativePath), "utf8");
  if (content.length > 0 && !content.endsWith("\n")) {
    fail(`${relativePath} does not end with a newline.`);
  }
  content.split("\n").forEach((line, index) => {
    if (line === "") return;
    if (line.includes('": ')) {
      nonCompact.push({ relativePath, lineNumber: index + 1, line });
    }
    for (const match of line.matchAll(timestampPattern)) {
      fixtureDates.add(match[1]);
    }
  });
}
if (fixtureDates.size === 0) {
  fail("no fixture line carries a timestamp; cannot derive the expected date set.");
}
// One deliberate exception: the invalid-line fixture proves ccusage drops a
// non-compact line. Any other pretty-printed line would silently empty the
// report (see the header), so it is a hard error.
if (nonCompact.length !== 1 || !nonCompact[0].line.includes('"usage": {')) {
  const detail = nonCompact
    .map((item) => `  ${item.relativePath}:${item.lineNumber}: ${item.line}`)
    .join("\n");
  fail(
    `expected exactly one non-compact line (the deliberate "usage": { invalid-row probe), ` +
      `found ${nonCompact.length}:\n${detail || "  (none)"}`,
  );
}

// ---------------------------------------------------------------------------
// 4. The three commands.
// ---------------------------------------------------------------------------
const dailyArgv = [
  "claude",
  "daily",
  "--json",
  "--breakdown",
  "--offline",
  "--single-thread",
  "-z",
  timezone,
  "-s",
  since,
  "-u",
  until,
];
const sessionArgv = [
  "claude",
  "session",
  "--json",
  "--offline",
  "--single-thread",
  "-z",
  timezone,
  "-s",
  since,
  "-u",
  until,
];

function run(argv, label) {
  let stdout;
  try {
    stdout = execFileSync(ccusageBin, argv, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: fixtureDir, CCUSAGE_MODEL_ALIASES: "" },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    console.error(`gen-claude-goldens: ccusage (${label}) failed: ${error.message}`);
    if (error.stderr) console.error(error.stderr.toString());
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    fail(`ccusage (${label}) did not print parseable JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    fail(`ccusage (${label}) printed ${JSON.stringify(parsed)}, want a JSON object.`);
  }
  return parsed;
}

const dailyAuto = run([...dailyArgv, "--mode", "auto"], "daily --mode auto");
const dailyCalculate = run([...dailyArgv, "--mode", "calculate"], "daily --mode calculate");
const sessions = run(sessionArgv, "session");

for (const [label, report, key] of [
  ["daily --mode auto", dailyAuto, "daily"],
  ["daily --mode calculate", dailyCalculate, "daily"],
  ["session", sessions, "sessions"],
]) {
  const rows = report[key];
  if (!Array.isArray(rows)) {
    fail(`ccusage (${label}) printed no "${key}" array.`);
  }
  if (rows.length === 0) {
    fail(
      `ccusage (${label}) printed an EMPTY "${key}" array. That is the symptom of a ` +
        "pretty-printed fixture line — refusing to mint empty goldens.",
    );
  }
}

// Each fixture date must produce at least one daily row; a date that silently
// vanished means ccusage dropped every line on it.
const dailyDates = new Set(dailyAuto.daily.map((row) => row.date));
const missingDates = [...fixtureDates].filter((date) => !dailyDates.has(date)).sort();
if (missingDates.length > 0) {
  fail(
    `these fixture dates produced no daily row: ${missingDates.join(", ")} — ` +
      "a dropped line, not a report to freeze.",
  );
}

// `auto` trusts a stored costUSD, `calculate` ignores it. If both modes print
// the same total, the fixture lost its reported-cost rows and half the mode
// matrix would be tested twice against the same numbers.
const autoCost = dailyAuto.totals?.totalCost;
const calculateCost = dailyCalculate.totals?.totalCost;
if (typeof autoCost !== "number" || typeof calculateCost !== "number") {
  fail("daily totals carry no numeric totalCost; refusing to freeze an unreadable report.");
}
if (autoCost === calculateCost) {
  fail(
    `--mode auto and --mode calculate both total ${autoCost}; the fixture no longer carries a ` +
      "reported costUSD, so the mode distinction is untested. Restore the costUSD rows.",
  );
}

// ---------------------------------------------------------------------------
// 5. Fixture tree hash.
//
// The Go test recomputes this with the same algorithm and fails when the tree
// changed without a regeneration. The algorithm is deliberately trivial so two
// languages can agree on it by reading the comment:
//
//   files := every regular file below the fixture root, relative paths with
//            "/" separators, sorted ascending by byte value
//   for each file, feed sha256:  path 0x00 decimal-byte-length 0x00 content 0x00
//
// An empty file therefore hashes as path + "0" + "", and no length prefix can
// be confused with content because the separators are NUL, which no path holds.
// ---------------------------------------------------------------------------
function fixtureTreeHash(root) {
  const hash = createHash("sha256");
  for (const relativePath of relativeFiles(root)) {
    // Raw bytes, never a decoded string: a transcript that is not valid UTF-8
    // must still hash to the same value on both sides.
    const bytes = readFileSync(join(root, relativePath));
    hash.update(relativePath, "utf8");
    hash.update("\u0000");
    hash.update(String(bytes.length), "utf8");
    hash.update("\u0000");
    hash.update(bytes);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

const fixtureSha256 = fixtureTreeHash(fixtureDir);

// ---------------------------------------------------------------------------
// 6. Write the goldens.
// ---------------------------------------------------------------------------
const document = {
  claudeVersion: expectedVersion,
  commands: [
    recordedCommand("auto", [...dailyArgv, "--mode", "auto"]),
    recordedCommand("calculate", [...dailyArgv, "--mode", "calculate"]),
    recordedCommand("session", sessionArgv),
  ],
  fixtureSha256,
  daily: { auto: dailyAuto, calculate: dailyCalculate },
  sessions,
};

/** One command record: argv with the binary elided, env with the tree elided. */
function recordedCommand(mode, argv) {
  return {
    mode,
    argv: ["ccusage", ...argv],
    env: { CLAUDE_CONFIG_DIR: "<fixture-tree>", CCUSAGE_MODEL_ALIASES: "" },
  };
}

mkdirSync(goldensDir, { recursive: true });
writeFileSync(goldensPath, JSON.stringify(document, null, 2) + "\n");

console.log(`gen-claude-goldens: ccusage ${expectedVersion}`);
console.log(`gen-claude-goldens: fixture ${relative(repoRoot, fixtureDir)} (${fixtureFiles.length} files)`);
console.log(`gen-claude-goldens: fixtureSha256 ${fixtureSha256}`);
console.log(
  `gen-claude-goldens: daily auto ${dailyAuto.daily.length} rows, totalCost ${autoCost}` +
    `; calculate ${dailyCalculate.daily.length} rows, totalCost ${calculateCost}`,
);
console.log(
  `gen-claude-goldens: sessions ${sessions.sessions.length} rows: ` +
    sessions.sessions.map((row) => row.sessionId).join(", "),
);
console.log(`gen-claude-goldens: wrote ${relative(repoRoot, goldensPath)}`);
