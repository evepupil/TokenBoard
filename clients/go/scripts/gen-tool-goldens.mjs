#!/usr/bin/env node
/**
 * gen-tool-goldens.mjs — mint the eleven ccusage tool adapters' row-level
 * goldens from a real ccusage 20.0.33 binary.
 *
 * The goldens are the end-to-end anchor for clients/go/internal/collect/
 * adapters/tools. Each source gets one synthetic fixture tree under
 * clients/go/testdata/tool-goldens-fixtures/<source>/ laid out exactly as the
 * tool stores its data, with the tool's own data-directory variable
 * (AMP_DATA_DIR, DROID_SESSIONS_DIR, CODEBUFF_DATA_DIR, HERMES_HOME,
 * GOOSE_PATH_ROOT, KILO_DATA_DIR, GEMINI_DATA_DIR, KIMI_DATA_DIR, QWEN_DATA_DIR,
 * ZCODE_HOME, OPENCLAW_DIR) pointing at it. Goldens are minted for both reports
 * the provider runs — `daily` and `session` — with the provider's own argv
 * (`<cmd> {daily,session} --json --timezone UTC -s <since> -u <until>`) plus
 * --offline --single-thread, and under the `auto` and `calculate` cost modes
 * (amp, gemini, kilo and openclaw bill differently per mode; droid, codebuff,
 * hermes, goose, kimi, qwen and zcode ignore it and must print identical rows
 * in both).
 *
 * The fixture tree is COMMITTED at clients/go/testdata/tool-goldens-fixtures/
 * and this script owns it: running without --check rewrites every JSON file and
 * every SQLite database from the definitions below (SQLite through Node's
 * built-in node:sqlite), so re-minting always starts from the canonical tree.
 * --check validates the committed tree byte for byte (file set, JSON content and
 * SQLite image) and re-mints every report in memory, comparing the committed
 * goldens without writing anything; scripts/check-deps.sh runs it in CI.
 *
 * Load-bearing details (each learned from measurement):
 *
 *   1. NO `--config`. This corpus mints ADAPTER parity goldens and the Go test
 *      bills from the embedded corpus with no overrides. The discovery checks
 *      below exist because without --config ccusage silently loads user-level
 *      config files.
 *   2. `--offline` is REQUIRED: without it ccusage fetches the day's live prices
 *      and the goldens drift daily.
 *   3. The child runs with HOME pinned to an empty directory, so a default data
 *      root (e.g. ~/.factory/sessions) can never leak into a report.
 *   4. A source whose report comes back with no rows is an ERROR, not an empty
 *      golden: an empty report means the fixture no longer matches what ccusage
 *      reads, and a silently empty golden would pass forever.
 *
 * Usage:
 *   node clients/go/scripts/gen-tool-goldens.mjs
 *   node clients/go/scripts/gen-tool-goldens.mjs --check   # drift gate, no write
 *   CCUSAGE_BIN=/path/to/ccusage node clients/go/scripts/gen-tool-goldens.mjs
 *
 * Output: clients/go/internal/collect/adapters/tools/goldens/tool-reports.json
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { scrubbedEnv } from "./child-env.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");
const goldensDir = join(repoRoot, "clients", "go", "internal", "collect", "adapters", "tools", "goldens");
const goldensPath = join(goldensDir, "tool-reports.json");

const ccusageBin = process.env.CCUSAGE_BIN || join(homedir(), ".tokenboard", "bin", "ccusage");

/** The binary this corpus was frozen against (the adapter headers' commit). */
const expectedVersion = "20.0.33";
/**
 * The window every report passes. It covers fixture dates 2026-05-04 and
 * 2026-05-05 and excludes the one KIMI fixture record dated 2026-06-22, which
 * pins the window's lower and upper ends on a real report.
 */
const since = "20260503";
const until = "20260507";
const timezone = "UTC";
/** The cost modes every source is minted under. */
const modes = ["auto", "calculate"];

const checkOnly = process.argv.includes("--check");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--check");
if (unknownArgs.length > 0) {
  fail(`unknown arguments: ${unknownArgs.join(" ")} (only --check is accepted)`);
}

function fail(message) {
  console.error(`gen-tool-goldens: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Fixtures. Each entry writes verbatim JSON under its source directory and,
// for SQLite sources, a list of statements executed in order against each
// database.
//
// Models are chosen so every row carries a price from the embedded corpus:
// a row never priced would surface as missingPricing/unpricedModels noise that
// belongs to the unit tests, not to a fixture whose job is the billing maths.
// ---------------------------------------------------------------------------

const fixtures = {
  // adapters/amp/src/{paths,parser}.rs: one JSON object per thread, assistant
  // messages carrying usage. Two threads: one with a full cache breakdown and a
  // reported credit, one without.
  amp: {
    env: "AMP_DATA_DIR",
    files: {
      "threads/T-11111111-1111-1111-1111-111111111111.json": `{
  "id": "thread-amp-1",
  "messages": [
    {"role": "user", "timestamp": "2026-05-04T01:00:00.000Z"},
    {"role": "assistant", "timestamp": "2026-05-04T01:00:05.000Z", "model": "claude-opus-4-5",
     "usage": {"inputTokens": 1000, "outputTokens": 500, "cacheCreationInputTokens": 100,
               "cacheReadInputTokens": 200, "totalTokens": 1800, "timestamp": "2026-05-04T01:00:05.000Z"}}
  ]
}
`,
      "threads/T-22222222-2222-2222-2222-222222222222.json": `{
  "id": "thread-amp-2",
  "messages": [
    {"role": "assistant", "timestamp": "2026-05-05T02:00:00.000Z", "model": "gpt-5",
     "usage": {"inputTokens": 2000, "outputTokens": 300}}
  ]
}
`,
    },
  },

  // adapters/droid/src/{paths,parser}.rs: <name>.settings.json per session. One
  // file with a bracketed model and thinking tokens, one carrying totalTokens so
  // the output fallback books it, one with the provider inferred from its model.
  droid: {
    env: "DROID_SESSIONS_DIR",
    files: {
      "session-a.settings.json": `{
  "model": "Claude-Sonnet-4-[Anthropic]",
  "providerLock": "anthropic",
  "providerLockTimestamp": "2026-05-04T01:02:03.000Z",
  "tokenUsage": {"inputTokens": 1000, "outputTokens": 500, "cacheCreationTokens": 100,
                 "cacheReadTokens": 50, "thinkingTokens": 25, "totalTokens": 1675}
}
`,
      "session-b.settings.json": `{
  "model": "gemini-2.5-pro",
  "providerLock": "google",
  "providerLockTimestamp": "2026-05-05T04:05:06.000Z",
  "tokenUsage": {"inputTokens": 1000, "totalTokens": 1200}
}
`,
      "session-c.settings.json": `{
  "model": "claude-haiku-4-5-20251001",
  "providerLockTimestamp": "2026-05-05T05:00:00.000Z",
  "tokenUsage": {"inputTokens": 300, "outputTokens": 40}
}
`,
    },
  },

  // adapters/codebuff/src/{paths,parser}.rs: projects/<project>/chats/<chat>/
  // chat-messages.json holding a JSON array. One metadata.usage message with
  // credits, one whose usage only exists in the runState history.
  codebuff: {
    env: "CODEBUFF_DATA_DIR",
    files: {
      "projects/project-one/chats/2026-05-04T01-00-00.000Z/chat-messages.json": `[
  {"role": "user", "text": "hello"},
  {"id": "cb-msg-1", "role": "assistant", "timestamp": "2026-05-04T01:00:05.000Z", "credits": 1.25,
   "metadata": {"model": "claude-sonnet-4-5",
                "usage": {"inputTokens": 1000, "outputTokens": 500, "cacheCreationInputTokens": 100, "cacheReadInputTokens": 200}}}
]
`,
      "projects/project-two/chats/2026-05-05T02-00-00.000Z/chat-messages.json": `[
  {"variant": "agent", "metadata": {"runState": {"sessionState": {"mainAgentState": {"messageHistory": [
    {"role": "user", "providerOptions": {}},
    {"role": "assistant", "providerOptions": {"codebuff": {"model": "gpt-5",
      "usage": {"promptTokens": 2000, "completionTokens": 300, "cachedTokensCreated": 40}}}}
  ]}}}}}
]
`,
    },
  },

  // adapters/hermes/src/{paths,parser}.rs: one state.db per HERMES_HOME.
  hermes: {
    env: "HERMES_HOME",
    databases: {
      "state.db": [
        `CREATE TABLE sessions (
          id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL,
          message_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
          reasoning_tokens INTEGER DEFAULT 0, billing_provider TEXT,
          estimated_cost_usd REAL, actual_cost_usd REAL)`,
        `INSERT INTO sessions (id, source, model, started_at, message_count, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider,
          estimated_cost_usd, actual_cost_usd) VALUES
          ('hermes-1', 'cli', 'claude-sonnet-4-5', 1777856400.5, 3, 1000, 200, 300, 50, 25, 'anthropic', 0.0, 0.0123),
          ('hermes-2', 'cli', 'deepseek-v4-flash', 1777942800.0, 1, 1000, 200, 0, 0, 0, 'deepseek', 0.05, 0),
          ('hermes-3', 'cli', 'claude-haiku-4-5-20251001', 1777946400.0, 2, 500, 100, 0, 0, 0, 'hermes', 0, 0)`,
      ],
    },
  },

  // adapters/goose/src/{paths,parser}.rs: <GOOSE_PATH_ROOT>/data/sessions/sessions.db.
  goose: {
    env: "GOOSE_PATH_ROOT",
    databases: {
      "data/sessions/sessions.db": [
        `CREATE TABLE sessions (
          id TEXT PRIMARY KEY, model_config_json TEXT, provider_name TEXT, created_at TEXT,
          total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
          accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER,
          accumulated_output_tokens INTEGER)`,
        `INSERT INTO sessions VALUES
          ('goose-1', '{"model_name":"claude-sonnet-4-5"}', 'anthropic', '2026-05-04 01:02:03', 0, 0, 0, 1500, 1000, 500),
          ('goose-2', '{"model_name":"gpt-5"}', 'openai', '1777942800000', 0, 0, 0, 0, 2000, 300)`,
      ],
    },
  },

  // adapters/kilo/src/{paths,parser}.rs: message rows of <KILO_DATA_DIR>/kilo.db.
  kilo: {
    env: "KILO_DATA_DIR",
    databases: {
      "kilo.db": [
        `CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)`,
        `INSERT INTO message VALUES
          ('row-1', 'session-a', '{"id":"msg-1","role":"assistant","providerID":"anthropic","modelID":"claude-sonnet-4-5","time":{"created":1777856400000},"tokens":{"input":1000,"output":200,"cache":{"read":300,"write":50}},"cost":0.02}'),
          ('row-2', 'session-b', '{"id":"msg-2","role":"assistant","providerID":"deepseek","modelID":"deepseek-v4-flash","time":{"created":1777942800000},"tokens":{"input":1000,"output":200,"cache":{"read":0,"write":0}}}')`,
      ],
    },
  },

  // adapters/gemini/src/{paths,parser}.rs: JSONL chats under GEMINI_DATA_DIR. A
  // direct token event with a cache and tool split, then a stats block whose
  // models map expands into one event per model.
  gemini: {
    env: "GEMINI_DATA_DIR",
    files: {
      "session-gemini-1.jsonl": `{"sessionId":"gs-1","model":"gemini-2.5-pro","type":"user","message":"hi"}
{"type":"gemini","id":"g1","timestamp":"2026-05-04T10:00:00.000Z","tokens":{"input":1000,"output":200,"cached":400,"thoughts":50,"tool":10,"total":1260}}
{"stats":{"models":{"gemini-2.5-flash":{"tokens":{"input":5000,"output":300,"cached":1000,"thoughts":0}}},"timestamp":"2026-05-05T12:00:00.000Z"}
`,
    },
  },

  // adapters/kimi/src/{paths,parser}.rs: sessions/<group>/<session>/wire.jsonl
  // and sessions/<ws>/<session>/agents/<agent>/wire.jsonl. A new-format turn
  // record (a session-scoped record beside it must be ignored), an old-format
  // StatusUpdate with a float-seconds timestamp, and a record outside the window.
  kimi: {
    env: "KIMI_DATA_DIR",
    files: {
      "config.json": `{"model": "kimi-k2.5"}\n`,
      "sessions/group/session-new/wire.jsonl": `{"type":"usage.record","usageScope":"turn","time":1777856400000,"model":"kimi-k2.5","usage":{"inputOther":1000,"output":200,"inputCacheCreation":50,"inputCacheRead":300}}
{"type":"usage.record","usageScope":"session","time":1777856500000,"model":"kimi-k2.5","usage":{"inputOther":9999,"output":9999}}
`,
      "sessions/group/session-old/wire.jsonl": `{"message":{"type":"StatusUpdate","payload":{"message_id":"old-1","token_usage":{"input_other":100,"output":50,"input_cache_creation":10,"input_cache_read":20,"total":200}}},"timestamp":1777942800.75}
`,
      "sessions/workspace/session-agents/agents/agent-1/wire.jsonl": `{"type":"usage.record","usageScope":"turn","time":1777946400000,"usage":{"inputOther":500,"output":100}}
`,
      "sessions/workspace/session-june/wire.jsonl": `{"type":"usage.record","usageScope":"turn","time":1782113184943,"model":"kimi-k2.5","usage":{"inputOther":700,"output":70}}
`,
    },
  },

  // adapters/qwen/src/{paths,parser}.rs: projects/<project>/chats/<file>.jsonl,
  // assistant records with a usageMetadata block and a sessionId.
  qwen: {
    env: "QWEN_DATA_DIR",
    files: {
      "projects/project-one/chats/session-qwen-1.jsonl": `{"type":"user","message":"hi"}
{"type":"assistant","sessionId":"qs-1","timestamp":"2026-05-04T01:02:03.000Z","model":"qwen3-coder","usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":200,"thoughtsTokenCount":50,"cachedContentTokenCount":300,"totalTokenCount":1550}}
`,
      "projects/project-two/chats/session-qwen-2.jsonl": `{"type":"assistant","sessionId":"qs-2","timestamp":"2026-05-05T03:04:05.000Z","model":"qwen-plus","usageMetadata":{"promptTokenCount":800,"candidatesTokenCount":120}}
`,
    },
  },

  // adapters/zcode/src/{paths,parser,loader}.rs: <ZCODE_HOME>/cli/db/db.sqlite
  // with model_usage joined to session. One completed Z.ai row (its
  // cache-creation bucket is billed as input), one row in another workspace, and
  // one unfinished row that must be ignored.
  zcode: {
    env: "ZCODE_HOME",
    databases: {
      "cli/db/db.sqlite": [
        `CREATE TABLE model_usage (
          id TEXT PRIMARY KEY, session_id TEXT, started_at INTEGER, model_id TEXT,
          provider_id TEXT, status TEXT, input_tokens INTEGER, output_tokens INTEGER,
          cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
          computed_total_tokens INTEGER)`,
        `CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, version TEXT)`,
        `INSERT INTO session VALUES ('zs1', '/workspace/project', '0.16.3')`,
        `INSERT INTO session VALUES ('zs2', '/workspace/other', '0.16.3')`,
        `INSERT INTO model_usage VALUES
          ('u1', 'zs1', 1777856400000, 'GLM-5.3', 'builtin:zai-coding-plan', 'completed', 100, 10, 15, 25, 110),
          ('u2', 'zs1', 1777856500000, 'GLM-5.3', 'builtin:zai-coding-plan', 'running', 999, 999, 0, 0, 0),
          ('u3', 'zs2', 1777942800000, 'deepseek-v4-flash', 'deepseek', 'completed', 1000, 200, 0, 0, NULL)`,
      ],
    },
  },

  // adapters/openclaw/src/{paths,parser}.rs: agents/<id>/sessions/<id>.jsonl.
  // A model_change record followed by a priced message, then a
  // model-snapshot record with a second model and a message without a cost.
  openclaw: {
    env: "OPENCLAW_DIR",
    files: {
      "agents/agent-1/sessions/sess-a.jsonl": `{"type":"model_change","modelId":"claude-sonnet-4-5","provider":"anthropic"}
{"type":"message","id":"m1","message":{"role":"assistant","timestamp":1777856400000,"usage":{"input":1000,"output":200,"cacheRead":300,"cacheWrite":50,"cost":{"total":0.0123}}}}
`,
      "agents/agent-1/sessions/sess-b.jsonl": `{"type":"custom","customType":"model-snapshot","data":{"modelId":"gpt-5","provider":"openai"}}
{"type":"message","id":"m2","message":{"role":"assistant","timestamp":"2026-05-05T01:00:00.000Z","usage":{"input":2000,"output":300}}}
`,
    },
  },
};

// ---------------------------------------------------------------------------
// 1. Version pin.
// ---------------------------------------------------------------------------
let versionOutput;
try {
  versionOutput = execFileSync(ccusageBin, ["--version"], { encoding: "utf8" }).trim();
} catch (error) {
  console.error(`gen-tool-goldens: cannot run ${ccusageBin}: ${error.message}`);
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
  join(process.cwd(), ".ccusage", "ccusage.json"),
];
for (const path of new Set(forbiddenConfigs)) {
  if (existsSync(path)) {
    fail(
      `${path} exists; ccusage would apply it and the goldens would not match a ` +
        "no-override Collect. Move it aside and rerun.",
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Materialise the committed fixture trees.
// ---------------------------------------------------------------------------

const fixtureRoot = join(repoRoot, "clients", "go", "testdata", "tool-goldens-fixtures");

// Scratch space for the reads cache and the empty HOME every child sees.
const workDir = mkdtempSync(join(tmpdir(), "tb-tool-goldens-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));
const emptyHome = join(workDir, "home");
mkdirSync(emptyHome, { recursive: true });
const scratchCwd = join(workDir, "cwd");
mkdirSync(scratchCwd, { recursive: true });

function expectedFixtureFiles(source, fixture) {
  const files = Object.fromEntries(Object.entries(fixture.files ?? {}).map(([path, content]) => [path, content]));
  return files;
}

/**
 * Writes (or rewrites) one source's fixture tree and returns its root.
 * SQLite databases are rebuilt from scratch so a stale binary can never survive
 * a schema change.
 */
function writeFixture(source, fixture) {
  const root = join(fixtureRoot, source);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  let fileCount = 0;
  for (const [relativePath, content] of Object.entries(fixture.files ?? {})) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    fileCount += 1;
  }
  let databaseCount = 0;
  for (const [relativePath, statements] of Object.entries(fixture.databases ?? {})) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
    const database = new DatabaseSync(path);
    try {
      for (const statement of statements) {
        database.exec(statement);
      }
    } finally {
      database.close();
    }
    databaseCount += 1;
  }
  if (fileCount === 0 && databaseCount === 0) {
    fail(`fixture for ${source} is empty.`);
  }
  return root;
}

/**
 * --check's half: verify the committed tree matches the definitions exactly.
 * SQLite images are re-created in memory from the same statements and compared
 * page for page against the committed files, so a hand-edited database fails.
 */
function verifyFixture(source, fixture) {
  const root = join(fixtureRoot, source);
  const committedFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        committedFiles.push(relative(root, path).split(sep).join("/"));
      } else {
        fail(`${path} is neither a regular file nor a directory.`);
      }
    }
  };
  if (!existsSync(root)) {
    fail(`missing fixture tree ${root} — run without --check to materialise it.`);
  }
  walk(root);
  const expectedFiles = Object.keys(expectedFixtureFiles(source, fixture));
  for (const database of Object.keys(fixture.databases ?? {})) {
    expectedFiles.push(database);
  }
  committedFiles.sort();
  expectedFiles.sort();
  if (committedFiles.length !== expectedFiles.length ||
      committedFiles.some((path, index) => path !== expectedFiles[index])) {
    fail(
      `fixture tree for ${source} drifted from the generator's definitions ` +
        `(files ${JSON.stringify(committedFiles)} vs ${JSON.stringify(expectedFiles)}); ` +
        "re-mint with this script without --check.",
    );
  }
  for (const [relativePath, content] of Object.entries(fixture.files ?? {})) {
    const committed = readFileSync(join(root, relativePath), "utf8");
    if (committed !== content) {
      fail(`fixture file ${source}/${relativePath} drifted from the generator's definition; re-mint.`);
    }
  }
  for (const [relativePath, statements] of Object.entries(fixture.databases ?? {})) {
    // Logical comparison, not a byte diff: the committed image was written by
    // whatever SQLite Node bundles for the maintainer, and a Node upgrade may
    // re-lay-out the same content. What matters to the goldens is tables and
    // rows, so compare those.
    const scratch = mkdtempSync(join(workDir, "sqlite-check-"));
    const rebuiltPath = join(scratch, "rebuilt.db");
    const rebuilt = new DatabaseSync(rebuiltPath);
    try {
      for (const statement of statements) {
        rebuilt.exec(statement);
      }
    } finally {
      rebuilt.close();
    }
    const committed = new DatabaseSync(join(root, relativePath), { readOnly: true });
    const expected = new DatabaseSync(rebuiltPath, { readOnly: true });
    try {
      const tableNames = (database) =>
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
          .map((row) => row.name);
      const committedTables = tableNames(committed);
      const expectedTables = tableNames(expected);
      if (JSON.stringify(committedTables) !== JSON.stringify(expectedTables)) {
        fail(
          `fixture database ${source}/${relativePath} has tables ` +
            `${JSON.stringify(committedTables)}, want ${JSON.stringify(expectedTables)}; re-mint.`,
        );
      }
      for (const table of expectedTables) {
        const readRows = (database) =>
          JSON.stringify(database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all());
        if (readRows(committed) !== readRows(expected)) {
          fail(
            `fixture database ${source}/${relativePath} row data in ${table} drifted from the ` +
              "generator's statements; re-mint with this script without --check.",
          );
        }
      }
    } finally {
      committed.close();
      expected.close();
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  return root;
}

// ---------------------------------------------------------------------------
// 4. Mint one report per (source, report, mode).
// ---------------------------------------------------------------------------
function mintReport(source, fixture, report, mode) {
  const argv = [
    source,
    report,
    "--json",
    "--offline",
    "--single-thread",
    "--timezone",
    timezone,
    "--mode",
    mode,
    "--since",
    since,
    "--until",
    until,
  ];
  let output;
  try {
    output = execFileSync(ccusageBin, argv, {
      encoding: "utf8",
      cwd: scratchCwd,
      env: scrubbedEnv({ ...process.env, HOME: emptyHome, [fixture.env]: fixture.root }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail(`ccusage ${argv.join(" ")} failed:\n${error.stderr || error.message}`);
  }
  let document;
  try {
    document = JSON.parse(output);
  } catch (error) {
    fail(`ccusage ${argv.join(" ")} printed invalid JSON: ${error.message}`);
  }
  const rowsKey = report === "session" ? "sessions" : "daily";
  const rows = document[rowsKey];
  if (!Array.isArray(rows) || rows.length === 0) {
    fail(
      `ccusage ${argv.join(" ")} returned no ${rowsKey} rows for the ${source} fixture; ` +
        "the fixture no longer matches what ccusage reads (fix the fixture, do not proceed).",
    );
  }
  return document;
}


const reports = {};
const commands = [];
for (const [source, fixture] of Object.entries(fixtures)) {
  const root = checkOnly ? verifyFixture(source, fixture) : writeFixture(source, fixture);
  fixture.root = root;
  const minted = {};
  for (const mode of modes) {
    for (const report of ["daily", "session"]) {
      const id = `${source}/${report}/${mode}`;
      minted[id] = mintReport(source, fixture, report, mode);
      commands.push({
        id,
        argv: ["ccusage", source, report, "--json", "--offline", "--single-thread",
          "--timezone", timezone, "--mode", mode, "--since", since, "--until", until],
        env: { [fixture.env]: `<fixture-tree>/${source}` },
      });
    }
  }
  // droid, codebuff, hermes and qwen hardcode CostMode::Calculate (or trust a
  // recorded cost regardless of mode), so their two documents must be identical;
  // a difference means the fixture started carrying reported costs.
  for (const report of ["daily", "session"]) {
    const auto = JSON.stringify(minted[`${source}/${report}/auto`]);
    const calculate = JSON.stringify(minted[`${source}/${report}/calculate`]);
    if (auto !== calculate && ["droid", "codebuff", "hermes", "qwen"].includes(source)) {
      fail(`${source} ${report} differs between auto and calculate; it should ignore --mode.`);
    }
  }
  for (const mode of modes) {
    for (const report of ["daily", "session"]) {
      if (minted[`${source}/${report}/${mode}`].totals == null) {
        fail(`${source} ${report}/${mode} returned a null totals block for a non-empty report.`);
      }
    }
  }
  reports[source] = minted;
}

// ---------------------------------------------------------------------------
// 5. Serialise. Keys are sorted throughout so the file is byte-stable.
// ---------------------------------------------------------------------------
const document = {
  ccusageVersion: expectedVersion,
  since,
  until,
  timezone,
  commands,
  reports,
};
const serialised = `${JSON.stringify(document, null, 2)}\n`;

if (checkOnly) {
  if (!existsSync(goldensPath)) {
    fail(`missing golden ${goldensPath} — run without --check to mint it.`);
  }
  const committed = readFileSync(goldensPath, "utf8");
  if (committed !== serialised) {
    fail(
      "the committed tool goldens drifted from what ccusage 20.0.33 prints today " +
        `(${goldensPath}). Review the change, then re-mint by running this script without --check.`,
    );
  }
  console.log(`gen-tool-goldens: ${Object.keys(fixtures).length} sources match the committed goldens.`);
} else {
  mkdirSync(goldensDir, { recursive: true });
  writeFileSync(goldensPath, serialised);
  console.log(`gen-tool-goldens: wrote ${goldensPath} (${Object.keys(fixtures).length} sources).`);
}
