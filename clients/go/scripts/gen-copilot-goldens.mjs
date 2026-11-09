#!/usr/bin/env node
/**
 * gen-copilot-goldens.mjs — mint the copilot adapter's row-level goldens from a
 * real ccusage 20.0.33 binary.
 *
 * The semantic source is ccusage v20.0.33 (commit 1308c416),
 * rust/adapters/copilot. Upstream ships one integration fixture tree — the very
 * tree its own CLI snapshots (rust/crates/ccusage/tests/copilot_cli.rs) are
 * taken over — and this script uses it as the golden input rather than
 * inventing another one:
 *
 *   otel/trace.jsonl                        three OTel chat spans
 *   session-state/session-a/events.jsonl    a malformed line, a non-shutdown
 *                                           event, and two cumulative shutdowns
 *                                           for one model
 *   session-state/session-b/events.jsonl    one shutdown with a cache/reasoning
 *                                           breakdown and no credit totals
 *   session-state/session-credits/events.jsonl
 *                                           two checkpoints around a model-
 *                                           attributed shutdown, which leaves a
 *                                           credit gap at each checkpoint
 *
 * The tree is COMMITTED at clients/go/testdata/copilot-goldens-fixtures/copilot/
 * exactly as upstream ships it (sha256 pinned below) and is what the test
 * drives. The goldens are minted with the provider's own argv
 * (`daily|session --json --timezone UTC --since 20260101 --until 20260228`)
 * plus --offline --single-thread, under the `auto` and `calculate` cost modes.
 *
 * Load-bearing details:
 *
 *   1. NO `--config`, `--offline` REQUIRED, HOME pinned to an empty directory:
 *      the same three rules as gen-tool-goldens.mjs.
 *   2. COPILOT_HOME points at the fixture tree; COPILOT_OTEL_FILE_EXPORTER_PATH
 *      is removed so a maintainer's exporter cannot leak in.
 *   3. A report with no rows is an ERROR, not an empty golden.
 *
 * Cross-check: the upstream CLI snapshots (`copilot_cli__*_json.snap`) are
 * re-minted by this script in memory from the same tree and compared against
 * the committed copy in clients/go/testdata/copilot-goldens-fixtures/upstream/
 * for the commands they cover (daily, and session in focused mode), so a drift
 * between the two sources of truth fails --check too.
 *
 * Usage:
 *   node clients/go/scripts/gen-copilot-goldens.mjs
 *   node clients/go/scripts/gen-copilot-goldens.mjs --check   # drift gate, no write
 *   CCUSAGE_BIN=/path/to/ccusage node clients/go/scripts/gen-copilot-goldens.mjs
 *
 * Output: clients/go/internal/collect/providers/ccusagetool/copilot-goldens/copilot-reports.json
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { scrubbedEnv } from "./child-env.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");
const goldensDir = join(repoRoot, "clients", "go", "internal", "collect", "providers", "ccusagetool", "copilot-goldens");
const goldensPath = join(goldensDir, "copilot-reports.json");
const fixtureRoot = join(repoRoot, "clients", "go", "testdata", "copilot-goldens-fixtures");
const copilotHome = join(fixtureRoot, "copilot");
const upstreamSnapshots = join(fixtureRoot, "upstream");

const ccusageBin = process.env.CCUSAGE_BIN || join(homedir(), ".tokenboard", "bin", "ccusage");
const expectedVersion = "20.0.33";

/** The window the upstream CLI test uses (copilot_cli.rs:6-7). */
const since = "20260101";
const until = "20260228";
const timezone = "UTC";
const modes = ["auto", "calculate"];

/**
 * The committed fixture files, byte for byte as rust/adapters/copilot/tests/
 * fixtures ships them at commit 1308c416. --check hashes the committed copies
 * against these, so a hand edit (or a "helpful" redaction that changes the
 * numbers) fails the gate instead of quietly moving the baseline.
 */
const fixtureHashes = {
  "otel/trace.jsonl": "a47adece8e83f255e9c19386a457806c2922624fa2050a37e28852d63884b799",
  "session-state/session-a/events.jsonl": "770ba2ec5841dabb02253259096c60a817c14dd51939b0092ebd5b9f421e9b70",
  "session-state/session-b/events.jsonl": "ac291c5408668474ce31485c60f1bcd6ad887c19a099d39d8feae71460dc79f2",
  "session-state/session-credits/events.jsonl": "e56bf9008a5a4a8f6f80a4ef3a17b11daceafdd7f1b327fc239c3284d79bfa72",
};

/**
 * The upstream CLI snapshots this script re-derives. Each entry names the
 * snapshot file, the ccusage argv it wraps, and the label line the snapshot
 * prints before the JSON body (copilot_cli.rs).
 */
const snapshotChecks = [
  { file: "copilot_cli__focused_daily_json.snap", argv: ["copilot", "daily", "--json"], label: "Daily JSON" },
  {
    file: "copilot_cli__focused_monthly_and_session_json.snap",
    // The snapshot wraps monthly AND session; the adapter only answers
    // session, so the check re-mints both lines the way the test does.
    argv: ["copilot", "session", "--json"],
    monthly: true,
    label: "Session JSON",
  },
];

const checkOnly = process.argv.includes("--check");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--check");
if (unknownArgs.length > 0) {
  fail(`unknown arguments: ${unknownArgs.join(" ")} (only --check is accepted)`);
}

function fail(message) {
  console.error(`gen-copilot-goldens: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Version pin and clean environment.
// ---------------------------------------------------------------------------
let versionOutput;
try {
  versionOutput = execFileSync(ccusageBin, ["--version"], { encoding: "utf8" }).trim();
} catch (error) {
  console.error(`gen-copilot-goldens: cannot run ${ccusageBin}: ${error.message}`);
  console.error("  Pass the binary through CCUSAGE_BIN, or install ccusage " + expectedVersion + ".");
  process.exit(1);
}
if (versionOutput !== `ccusage ${expectedVersion}`) {
  fail(
    `version drift — the goldens are frozen against "ccusage ${expectedVersion}", ` +
      `${ccusageBin} reports "${versionOutput}".`,
  );
}
const aliasValue = process.env.CCUSAGE_MODEL_ALIASES;
if (aliasValue !== undefined && aliasValue !== "") {
  fail(`CCUSAGE_MODEL_ALIASES is set; the goldens must be minted with an empty alias table.`);
}
for (const path of new Set([
  join(homedir(), ".claude", "ccusage.json"),
  join(homedir(), ".config", "claude", "ccusage.json"),
  join(repoRoot, ".ccusage", "ccusage.json"),
  join(process.cwd(), ".ccusage", "ccusage.json"),
])) {
  if (existsSync(path)) {
    fail(`${path} exists; ccusage would apply it. Move it aside and rerun.`);
  }
}

// ---------------------------------------------------------------------------
// 2. Verify the committed fixture tree.
// ---------------------------------------------------------------------------
function walkFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
      } else {
        fail(`${path} is neither a regular file nor a directory.`);
      }
    }
  };
  if (!existsSync(root)) {
    fail(`missing fixture tree ${root}; restore it from rust/adapters/copilot/tests/fixtures.`);
  }
  walk(root);
  return files.sort();
}

const committed = walkFiles(copilotHome);
const expected = Object.keys(fixtureHashes).sort();
if (JSON.stringify(committed) !== JSON.stringify(expected)) {
  fail(`fixture tree holds ${JSON.stringify(committed)}, want ${JSON.stringify(expected)}.`);
}
for (const [path, sha] of Object.entries(fixtureHashes)) {
  const actual = createHash("sha256").update(readFileSync(join(copilotHome, path))).digest("hex");
  if (actual !== sha) {
    fail(`fixture ${path} does not match the upstream tree at ccusage ${expectedVersion} (${actual} != ${sha}).`);
  }
}

// ---------------------------------------------------------------------------
// 3. Mint one report per (report, mode).
// ---------------------------------------------------------------------------
const workDir = mkdtempSync(join(tmpdir(), "tb-copilot-goldens-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));
const emptyHome = join(workDir, "home");
mkdirSync(emptyHome, { recursive: true });
const scratchCwd = join(workDir, "cwd");
mkdirSync(scratchCwd, { recursive: true });

function runCcusage(argv) {
  const fullArgv = [
    ...argv,
    "--offline",
    "--single-thread",
    "--timezone",
    timezone,
    "--since",
    since,
    "--until",
    until,
  ];
  try {
    return execFileSync(ccusageBin, fullArgv, {
      encoding: "utf8",
      cwd: scratchCwd,
      env: scrubbedEnv({
        ...process.env,
        HOME: emptyHome,
        USERPROFILE: emptyHome,
        COPILOT_HOME: copilotHome,
        COPILOT_OTEL_FILE_EXPORTER_PATH: undefined,
        LOG_LEVEL: "0",
        NO_COLOR: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail(`ccusage ${fullArgv.join(" ")} failed:\n${error.stderr || error.message}`);
  }
}

function mintReport(report, mode) {
  const argv = ["copilot", report, "--json", "--mode", mode];
  const output = runCcusage(argv);
  let document;
  try {
    document = JSON.parse(output);
  } catch (error) {
    fail(`ccusage ${argv.join(" ")} printed invalid JSON: ${error.message}`);
  }
  const rowsKey = report === "session" ? "sessions" : "daily";
  if (!Array.isArray(document[rowsKey]) || document[rowsKey].length === 0) {
    fail(`ccusage ${argv.join(" ")} returned no ${rowsKey} rows; the fixture no longer matches its reader.`);
  }
  if (document.totals == null) {
    fail(`ccusage ${argv.join(" ")} returned a null totals block for a non-empty report.`);
  }
  return { argv: ["ccusage", ...argv, "--offline", "--single-thread", "--timezone", timezone,
    "--since", since, "--until", until], report: document };
}

// ---------------------------------------------------------------------------
// 4. Re-derive the upstream CLI snapshots the adapter covers.
// ---------------------------------------------------------------------------
function snapshotBody(text) {
  // insta: `---\n…\n---\n<body>`; the body starts after the second `---` line.
  const parts = text.split("\n---\n");
  if (parts.length !== 2) {
    fail("snapshot file has no insta header");
  }
  return parts[1].replace(/\n$/, "");
}

function comparable(tree) {
  // Key order is irrelevant in JSON; compare parsed values with sorted keys.
  if (Array.isArray(tree)) {
    return `[${tree.map(comparable).join(",")}]`;
  }
  if (tree !== null && typeof tree === "object") {
    return `{${Object.keys(tree).sort().map((key) => `${JSON.stringify(key)}:${comparable(tree[key])}`).join(",")}}`;
  }
  return JSON.stringify(tree);
}

const crossChecks = [];
for (const check of snapshotChecks) {
  const path = join(upstreamSnapshots, check.file);
  if (!existsSync(path)) {
    fail(`missing committed upstream snapshot ${path}.`);
  }
  const body = snapshotBody(readFileSync(path, "utf8"));
  const expectedBody = check.monthly
    ? `Monthly JSON\n${runCcusage(["copilot", "monthly", "--json"]).replace(/\n$/, "")}\nSession JSON\n${runCcusage(check.argv).replace(/\n$/, "")}`
    : `${check.label}\n${runCcusage(check.argv).replace(/\n$/, "")}`;
  // Compare one section (the daily body, or the session half of the
  // monthly+session snapshot) section by section; key order is irrelevant.
  const sections = (text) => text.replace(/^(Monthly|Session|Daily) JSON\n(.*?)(?=\n(?:Monthly|Session|Daily) JSON\n|$)/gs,
    (_, label, json) => `${label}\x00${comparable(JSON.parse(json))}\n`);
  if (sections(body) !== sections(expectedBody)) {
    fail(`${check.file} drifted: ccusage ${expectedVersion} no longer prints the committed snapshot for this tree.`);
  }
  crossChecks.push(check.file);
}

// ---------------------------------------------------------------------------
// 5. Collect, serialise, write or compare.
// ---------------------------------------------------------------------------
const reports = {};
const commands = [];
for (const mode of modes) {
  for (const report of ["daily", "session"]) {
    const id = `${report}/${mode}`;
    const minted = mintReport(report, mode);
    reports[id] = minted.report;
    commands.push({ id, argv: minted.argv, copilotHome: "<fixture-tree>/copilot" });
  }
}
const document = {
  ccusageVersion: expectedVersion,
  since,
  until,
  timezone,
  commands,
  crossCheckedSnapshots: crossChecks,
  reports,
};
const serialised = `${JSON.stringify(document, null, 2)}\n`;

if (checkOnly) {
  if (!existsSync(goldensPath)) {
    fail(`missing golden ${goldensPath}; run without --check to mint it.`);
  }
  if (readFileSync(goldensPath, "utf8") !== serialised) {
    fail(
      "the committed copilot goldens drifted from what ccusage 20.0.33 prints today " +
        `(${goldensPath}). Review the change, then re-mint without --check.`,
    );
  }
  console.log(`gen-copilot-goldens: goldens and ${crossChecks.length} upstream snapshots match.`);
} else {
  mkdirSync(goldensDir, { recursive: true });
  writeFileSync(goldensPath, serialised);
  console.log(`gen-copilot-goldens: wrote ${goldensPath}.`);
}
