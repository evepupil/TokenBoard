#!/usr/bin/env node
/**
 * gen-native-pricing-goldens.mjs — mint the cost parity goldens from a real
 * ccusage binary.
 *
 * The goldens are the anchor of the native pricing engine's parity chain: once
 * ccusage leaves the repository they can never be regenerated, so this recipe
 * is deliberately explicit and fails closed at every step.
 *
 * Recipe (mirrors clients/go/scripts/check-deps.sh:92-104, the proven one):
 *
 *   CLAUDE_CONFIG_DIR=<fixture-tree> ccusage claude daily --json --breakdown \
 *     --offline --config packages/collector/ccusage.json -z UTC -s <day> -u <day>
 *
 * Three details are load-bearing and were each learned by measurement:
 *
 *   1. `--offline` is REQUIRED. The production Claude path does not pass it
 *      (claudecode.go:291) and would fetch the day's live prices, so goldens
 *      taken without it drift daily. `--offline` is what pins ccusage's own
 *      embedded snapshot — the exact thing the native engine ports.
 *   2. `--config packages/collector/ccusage.json` is REQUIRED. The shipped
 *      config carries `defaults.pricingOverrides` (48 camelCase entries) and
 *      ccusage applies them on top of the snapshot. The Go test applies the
 *      same block via Corpus.WithServerOverrides.
 *   3. Fixture JSONL must be COMPACT (no space after a colon). ccusage 20.0.33
 *      returns an EMPTY `daily` array for a session line written with spaces
 *      after colons, which would silently mint empty goldens. This script
 *      asserts a non-empty row per fixture and exits 1 otherwise.
 *
 * Do NOT add a "272k custom threshold" fixture: ccusage 20.0.33 emits
 * Above200k only at threshold == 200000, and `max_input_tokens` is not a tier
 * boundary.
 *
 * Usage:
 *   node clients/go/scripts/gen-native-pricing-goldens.mjs
 *   CCUSAGE_BIN=/path/to/ccusage node clients/go/scripts/gen-native-pricing-goldens.mjs
 *
 * Output: clients/go/internal/nativepricing/goldens/cost-cases.json
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { scrubbedEnv } from "./child-env.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");
const goldensPath = join(
  repoRoot,
  "clients",
  "go",
  "internal",
  "nativepricing",
  "goldens",
  "cost-cases.json",
);
const configPath = join(repoRoot, "packages", "collector", "ccusage.json");

const ccusageBin = process.env.CCUSAGE_BIN || join(process.env.HOME ?? "", ".tokenboard", "bin", "ccusage");

/** The binary this corpus was frozen against (Corpus doc comment, corpus.go). */
const expectedVersion = "20.0.33";

// ---------------------------------------------------------------------------
// Fixture cases.
//
// `usage` carries only the fields ccusage's Claude adapter reads
// (TokenUsageRaw, types.rs:29-39): input_tokens, output_tokens,
// cache_creation_input_tokens, cache_read_input_tokens, the cache_creation
// breakdown, and speed.
//
// Each case owns a distinct UTC day so no two merge into one daily row.
// ---------------------------------------------------------------------------
const cases = [
  // 1. A normal model with all four token buckets.
  {
    name: "normal-all-buckets",
    model: "claude-sonnet-4-5",
    usage: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 3_000,
    },
  },

  // 2. Above-200k marginal tiering: claude-sonnet-4-5-20250929-v1:0 is one of
  //    the 11 LiteLLM rows that publish `*_above_200k_tokens` bands, so it
  //    bills marginally rather than switching the whole request.
  {
    name: "marginal-200k-below",
    model: "claude-sonnet-4-5-20250929-v1:0",
    usage: {
      input_tokens: 199_999,
      output_tokens: 100,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 500,
    },
  },
  {
    name: "marginal-200k-above",
    model: "claude-sonnet-4-5-20250929-v1:0",
    usage: {
      input_tokens: 250_000,
      output_tokens: 100,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 500,
    },
  },

  // 3. A real whole-request tier model. gemini-2.5-pro is models.dev-only and
  //    its row carries `cost.tiers` with a 200000-token context boundary, so
  //    the request's whole context picks the band.
  {
    name: "whole-request-tier-below",
    model: "gemini-2.5-pro",
    usage: {
      input_tokens: 100_000,
      output_tokens: 2_000,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 50_000,
    },
  },
  {
    name: "whole-request-tier-above",
    model: "gemini-2.5-pro",
    usage: {
      input_tokens: 100_000,
      output_tokens: 2_000,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 150_000,
    },
  },

  // 4. 1h cache creation: the breakdown splits the buckets and the 1h rate is
  //    input × 2 (cost.rs:8 CACHE_CREATE_1H_INPUT_MULTIPLIER).
  {
    name: "cache-creation-1h",
    model: "claude-sonnet-4-5",
    usage: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
      cache_read_input_tokens: 0,
    },
  },

  // 5. fast speed. The Claude adapter reads `usage.speed == "fast"` and both
  //    suffixes the breakdown name with "-fast" and bills whole-cost ×
  //    fast_multiplier (daily.rs:338-346, cost.rs:110-115).
  {
    name: "fast-speed-multiplier",
    model: "gpt-5.5",
    usage: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_input_tokens: 2_000,
      speed: "fast",
    },
  },

  // 6. Unknown model: no corpus entry, so cost 0 and missingPricing.
  {
    name: "unknown-model",
    model: "tokenboard-unknown-model-zzz",
    usage: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 200,
    },
  },

  // 7. Free model: every rate is 0, so cost 0 and missingPricing == false.
  //    zai/glm-4.5-flash is a LiteLLM row priced 0/0.
  {
    name: "free-model",
    model: "zai/glm-4.5-flash",
    usage: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 200,
    },
  },

  // 8. The separator-variant probe family.
  //
  //    ccusage's ExactOnlyKeys::id_spelled_by (pricing.rs:517-523) answers an
  //    alternate '.'/'@' spelling of an exact-only id from that id's entry.
  //    When a key exists in BOTH embedded snapshots, ccusage answers from its
  //    models.dev map while the merged Corpus (Task 1) holds the primary
  //    rates. Canonical spellings agree; only these respellings can diverge,
  //    so every one of them is recorded here rather than deleted.
  //
  //    See goldens_test.go's knownDivergences for the measured values and the
  //    per-model source lines.
  { name: "family-gpt5-codex-canonical", model: "gpt-5-codex", usage: sharedFamilyUsage() },
  { name: "family-gpt5-codex-dot", model: "gpt-5.codex", usage: sharedFamilyUsage() },
  { name: "family-gpt51-codex-canonical", model: "gpt-5.1-codex", usage: sharedFamilyUsage() },
  { name: "family-gpt51-codex-dot", model: "gpt-5.1.codex", usage: sharedFamilyUsage() },
  { name: "family-gpt51-codex-dash", model: "gpt-5-1-codex", usage: sharedFamilyUsage() },
  { name: "family-gpt52-canonical", model: "gpt-5.2", usage: sharedFamilyUsage() },
  { name: "family-gpt52-dash", model: "gpt-5-2", usage: sharedFamilyUsage() },
  { name: "family-gpt52-at", model: "gpt-5@2", usage: sharedFamilyUsage() },
  { name: "family-gpt52-codex-canonical", model: "gpt-5.2-codex", usage: sharedFamilyUsage() },
  { name: "family-gpt52-codex-dot", model: "gpt-5.2.codex", usage: sharedFamilyUsage() },
  { name: "family-gpt52-codex-dash", model: "gpt-5-2-codex", usage: sharedFamilyUsage() },
  { name: "family-gpt52-codex-at", model: "gpt-5.2@codex", usage: sharedFamilyUsage() },
  // gpt-5.6: the shipped override raises it from the snapshot's $4/$20 to
  // $5/$30 (and its cache rates with it), so a respelled request answers from
  // the un-overridden models.dev row. gpt-5-6-sol is the 1-ULP counterpart:
  // LiteLLM's cache_read=4e-7 vs models.dev 0.4/M, which is below the cost's
  // resolution at these token counts and must still match bit for bit.
  { name: "family-gpt56-dash", model: "gpt-5-6", usage: sharedFamilyUsage() },
  { name: "family-gpt56-sol-dash", model: "gpt-5-6-sol", usage: sharedFamilyUsage() },
  { name: "family-deepseek-canonical", model: "deepseek-flash", usage: sharedFamilyUsage() },
  { name: "family-deepseek-dot", model: "deepseek.flash", usage: sharedFamilyUsage() },
  { name: "family-deepseek-at", model: "deepseek@flash", usage: sharedFamilyUsage() },
  { name: "family-deepseek-provider-canonical", model: "deepseek/deepseek-flash", usage: sharedFamilyUsage() },
  { name: "family-deepseek-provider-dot", model: "deepseek/deepseek.flash", usage: sharedFamilyUsage() },
  { name: "family-deepseek-provider-at", model: "deepseek/deepseek@flash", usage: sharedFamilyUsage() },
  // gpt-4.1 family: the canonical dotted spellings (gpt-4.1-mini, gpt-4.1-nano,
  // and the dated variant) are models.dev exact-only ids whose per-million
  // rates (0.4/M input, 0.1/M cache_read) are not exact in binary floating
  // point. The dash respellings resolve through models.dev id_spelled_by in
  // ccusage while the merged corpus answers from the primary LiteLLM entry,
  // whose rates are the exact doubles, so each differs by 1 ULP at these token
  // counts. See knownDivergences.
  { name: "family-gpt41-mini-dash", model: "gpt-4-1-mini", usage: sharedFamilyUsage() },
  { name: "family-gpt41-mini-date-dash", model: "gpt-4-1-mini-2025-04-14", usage: sharedFamilyUsage() },
  { name: "family-gpt41-nano-dash", model: "gpt-4-1-nano", usage: sharedFamilyUsage() },

  // 9. The rest of the overridden surface, canonical spellings only. These
  //    pin the override application itself (Task 4) against the real binary:
  //    every one of them is a `defaults.pricingOverrides` key.
  { name: "override-gpt5", model: "gpt-5", usage: sharedFamilyUsage() },
  { name: "override-gpt51", model: "gpt-5.1", usage: sharedFamilyUsage() },
  { name: "override-gpt53-codex", model: "gpt-5.3-codex", usage: sharedFamilyUsage() },
  { name: "override-gpt54", model: "gpt-5.4", usage: sharedFamilyUsage() },
  { name: "override-gpt56-sol", model: "gpt-5.6-sol", usage: sharedFamilyUsage() },
  { name: "override-gpt56", model: "gpt-5.6", usage: sharedFamilyUsage() },
  { name: "override-claude-opus-5", model: "claude-opus-5", usage: sharedFamilyUsage() },
  { name: "override-claude-opus-4-6", model: "claude-opus-4-6", usage: sharedFamilyUsage() },
  { name: "override-claude-sonnet-4-5", model: "claude-sonnet-4-5", usage: sharedFamilyUsage() },
  { name: "override-claude-haiku-4-5", model: "claude-haiku-4-5", usage: sharedFamilyUsage() },
  { name: "override-grok-4.5", model: "grok-4.5", usage: sharedFamilyUsage() },

  // 10. Override keys whose base lives only in models.dev. An override of a
  //     models.dev-only id starts from Pricing::empty (pricing.rs:1822-1826
  //     reads `self.entries`, the primary map), so these are the rows that
  //     would silently inherit models.dev rates if the stage were ignored.
  { name: "override-modelsdev-only-gpt55-pro", model: "gpt-5.5-pro", usage: sharedFamilyUsage() },
  { name: "override-modelsdev-only-longcat", model: "longcat-2.5-preview-free", usage: sharedFamilyUsage() },

  // 11. Free rows reached only through the override layer (the shipped config
  //     pins them to 0). A missingPricing == false / cost == 0 pair.
  { name: "override-free-minimax", model: "minimax/MiniMax-M3.1-Flash-Preview", usage: sharedFamilyUsage() },
  { name: "override-free-step-5", model: "step-5-preview-free", usage: sharedFamilyUsage() },

  // 12. A reported cost. ccusage's default mode is `auto` (cli help), which
  //     trusts a stored `costUSD` and computes only without one; `calculate`
  //     ignores it. Both modes are recorded so the native CostMode matrix is
  //     checked against the binary, not just against itself.
  {
    name: "reported-cost-auto",
    model: "claude-sonnet-4-5",
    reportedCostUsd: 1.5,
    usage: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 3_000,
    },
  },
];

function sharedFamilyUsage() {
  return {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 200,
  };
}

// Every field ccusage's Claude adapter reads off `usage` (TokenUsageRaw,
// types.rs:29-39). Anything else is silently dropped by serde, and the
// generator reads the same names, so a typo would zero a bucket on BOTH sides
// and the case would "pass" while testing nothing.
const usageFields = new Set([
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "cache_creation",
  "speed",
]);
const cacheCreationFields = new Set(["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]);

function validateUsage(testCase) {
  const usage = testCase.usage ?? {};
  for (const key of Object.keys(usage)) {
    if (!usageFields.has(key)) {
      throw new Error(
        `case "${testCase.name}": unknown usage field "${key}" — ccusage would ignore it ` +
          `(TokenUsageRaw keys are ${[...usageFields].join(", ")})`,
      );
    }
  }
  // input_tokens and output_tokens carry no #[serde(default)]; a line without
  // them is a deserialization failure, which ccusage then skips entirely.
  for (const required of ["input_tokens", "output_tokens"]) {
    if (typeof usage[required] !== "number") {
      throw new Error(`case "${testCase.name}": usage.${required} is required`);
    }
  }
  if (usage.cache_creation != null) {
    for (const key of Object.keys(usage.cache_creation)) {
      if (!cacheCreationFields.has(key)) {
        throw new Error(
          `case "${testCase.name}": unknown cache_creation field "${key}" ` +
            `(keys are ${[...cacheCreationFields].join(", ")})`,
        );
      }
    }
  }
  if (usage.speed != null && usage.speed !== "fast" && usage.speed !== "standard") {
    throw new Error(
      `case "${testCase.name}": speed "${usage.speed}" is not a Speed variant (fast|standard)`,
    );
  }
}

for (const testCase of cases) {
  validateUsage(testCase);
}
const seenNames = new Set();
for (const testCase of cases) {
  if (seenNames.has(testCase.name)) {
    throw new Error(`duplicate case name "${testCase.name}"`);
  }
  seenNames.add(testCase.name);
}

/** The UTC day case `index` is written on. Kept identical in the goldens. */
function dayForIndex(index) {
  return new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Fixture tree
// ---------------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), "tb-native-goldens-"));
const claudeDir = join(workDir, "claude");
mkdirSync(join(claudeDir, "projects", "goldens"), { recursive: true });

cases.forEach((testCase, index) => {
  const timestamp = `${dayForIndex(index)}T02:00:00.000Z`;
  const costUsdField = testCase.reportedCostUsd != null ? { costUSD: testCase.reportedCostUsd } : {};
  const line = {
    type: "assistant",
    timestamp,
    requestId: `req_${index}`,
    sessionId: `ses_${index}`,
    version: "1.0.0",
    ...costUsdField,
    message: { id: `msg_${index}`, model: testCase.model, usage: testCase.usage },
  };
  // JSON.stringify emits compact JSON: no space after ':' and none after ','.
  // That is the byte shape ccusage 20.0.33 prices; a pretty-printed line (or
  // Python's default json.dumps) yields an EMPTY daily array.
  writeFileSync(join(claudeDir, "projects", "goldens", `${index}.jsonl`), JSON.stringify(line) + "\n");
});

const firstDay = dayForIndex(0);
const lastDay = dayForIndex(cases.length - 1);
const reportArgs = [
  "claude", "daily",
  "--json",
  "--breakdown",
  "--offline",
  "--config", configPath,
  "-z", "UTC",
  "-s", firstDay.replace(/-/g, ""),
  "-u", lastDay.replace(/-/g, ""),
];

let versionOutput;
try {
  versionOutput = execFileSync(ccusageBin, ["--version"], { encoding: "utf8" }).trim();
} catch (error) {
  console.error(`gen-native-pricing-goldens: cannot run ${ccusageBin}: ${error.message}`);
  console.error("  Pass --ccusage-bin through CCUSAGE_BIN, or install ccusage 20.0.33.");
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}
const actualVersion = versionOutput.split(/\s+/).pop();
if (actualVersion !== expectedVersion) {
  console.error(
    `gen-native-pricing-goldens: version drift — the corpus is frozen against ${expectedVersion}, ` +
      `${ccusageBin} reports ${actualVersion}.`,
  );
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

let output;
try {
  output = execFileSync(ccusageBin, [...reportArgs, "--mode", "auto"], ccusageOptions());
} catch (error) {
  console.error(`gen-native-pricing-goldens: ccusage (auto) failed: ${error.message}`);
  if (error.stderr) console.error(error.stderr.toString());
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}
let calculatedOutput;
try {
  calculatedOutput = execFileSync(ccusageBin, [...reportArgs, "--mode", "calculate"], ccusageOptions());
} catch (error) {
  console.error(`gen-native-pricing-goldens: ccusage (calculate) failed: ${error.message}`);
  if (error.stderr) console.error(error.stderr.toString());
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const rows = indexBreakdowns(JSON.parse(output));
const calculatedRows = indexBreakdowns(JSON.parse(calculatedOutput));

/** Index every breakdown as "day\u0000modelName" so a case can be looked up. */
function indexBreakdowns(report) {
  const index = new Map();
  for (const day of report.daily ?? []) {
    for (const breakdown of day.modelBreakdowns ?? []) {
      index.set(`${day.date}\u0000${breakdown.modelName}`, breakdown);
    }
  }
  return index;
}

/** The ccusage invocation, minus the per-mode flag. */
function ccusageOptions() {
  return {
    env: {
      // Third-party binary: never let it read the collector credentials.
      ...scrubbedEnv(),
      CLAUDE_CONFIG_DIR: claudeDir,
      // The shipped configuration leaves this table empty; make that explicit
      // so an inherited value cannot rewrite a model name.
      CCUSAGE_MODEL_ALIASES: "",
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  };
}

// ---------------------------------------------------------------------------
// Assemble the goldens — fail closed on any fixture with no row.
// ---------------------------------------------------------------------------
const overrides = readShippedOverrides(configPath);
const goldens = [];
const missing = [];

cases.forEach((testCase, index) => {
  const day = dayForIndex(index);
  // A "-fast" suffix is what ccusage names the breakdown after reading
  // `usage.speed == "fast"`; the fixture's own model name is the other key.
  const auto =
    rows.get(`${day}\u0000${testCase.model}`) ?? rows.get(`${day}\u0000${testCase.model}-fast`);
  const calculated =
    calculatedRows.get(`${day}\u0000${testCase.model}`) ??
    calculatedRows.get(`${day}\u0000${testCase.model}-fast`);

  if (!auto || !calculated) {
    missing.push(`  ${testCase.name.padEnd(32)} ${testCase.model} (day ${day})`);
    return;
  }
  if (auto.modelName !== calculated.modelName) {
    console.error(
      `gen-native-pricing-goldens: case "${testCase.name}" is named ${auto.modelName} in auto ` +
        `but ${calculated.modelName} in calculate — the two modes disagree on the model.`,
    );
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }
  if (testCase.reportedCostUsd == null && auto.cost !== calculated.cost) {
    console.error(
      `gen-native-pricing-goldens: case "${testCase.name}" has no reported cost yet auto ` +
        `(${auto.cost}) and calculate (${calculated.cost}) differ — the mode semantics assumed ` +
        "by goldens_test.go are wrong.",
    );
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }
  if (testCase.reportedCostUsd != null && auto.cost !== testCase.reportedCostUsd) {
    console.error(
      `gen-native-pricing-goldens: case "${testCase.name}" reports ${auto.cost} in auto mode, ` +
        `expected the stored ${testCase.reportedCostUsd}.`,
    );
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }

  const usage = testCase.usage;
  const breakdownUsage = usage.cache_creation ?? {};
  const tokens = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    // ccusage splits cache creation by TTL only when the breakdown is present
    // and otherwise books the whole count as 5m (cost.rs:119-127).
    cacheCreate5m: breakdownUsage.ephemeral_5m_input_tokens ?? usage.cache_creation_input_tokens ?? 0,
    cacheCreate1h: breakdownUsage.ephemeral_1h_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };

  // Cross-check the fixture against ccusage's own accounting. Without this a
  // mistyped usage key would be silently dropped by both sides (serde defaults
  // an unknown field away, and the generator reads the same key), and the case
  // would "pass" while never exercising that bucket.
  const reportedTokens = {
    input: auto.inputTokens,
    output: auto.outputTokens,
    cacheCreate: auto.cacheCreationTokens,
    cacheRead: auto.cacheReadTokens,
  };
  if (
    tokens.input !== reportedTokens.input ||
    tokens.output !== reportedTokens.output ||
    tokens.cacheRead !== reportedTokens.cacheRead ||
    tokens.cacheCreate5m + tokens.cacheCreate1h !== reportedTokens.cacheCreate
  ) {
    console.error(
      `gen-native-pricing-goldens: case "${testCase.name}" declares ` +
        `${JSON.stringify(tokens)} but ccusage counted ${JSON.stringify(reportedTokens)} — ` +
        "a usage field is probably mistyped.",
    );
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }

  goldens.push({
    name: testCase.name,
    day,
    model: testCase.model,
    // The name ccusage billed under, so a "-fast" suffixing bug is visible in
    // the goldens instead of being silently absorbed by the fixture's name.
    reportedModelName: auto.modelName,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheCreate5m: tokens.cacheCreate5m,
    cacheCreate1h: tokens.cacheCreate1h,
    cacheRead: tokens.cacheRead,
    fast: usage.speed === "fast",
    reportedCostUsd: testCase.reportedCostUsd ?? null,
    // auto mode is ccusage's default and the only mode that surfaces
    // missingPricing; calculate is the pure formula the engine ports.
    cost: auto.cost,
    calculatedCost: calculated.cost,
    missingPricing: auto.missingPricing === true,
  });
});

if (missing.length > 0) {
  console.error("gen-native-pricing-goldens: these fixtures produced NO daily row:");
  console.error(missing.join("\n"));
  console.error(
    "  A fixture missing its row means ccusage did not price it — most often because the\n" +
      "  JSONL was not compact JSON. Refusing to write a partial golden set.",
  );
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}
if (goldens.length === 0) {
  console.error("gen-native-pricing-goldens: zero golden cases produced.");
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}
if (goldens.length !== cases.length) {
  console.error(
    `gen-native-pricing-goldens: ${goldens.length}/${cases.length} cases produced — refusing a partial set.`,
  );
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const document = {
  // Everything a reader needs to judge whether a future regeneration is
  // legitimate. The command is recorded verbatim, with the fixture tree's
  // path elided because it is a fresh mktemp directory on every run.
  generatedBy: {
    ccusageVersion: actualVersion,
    command:
      "CLAUDE_CONFIG_DIR=<fixture-tree> ccusage claude daily --json --breakdown --offline " +
      "--config packages/collector/ccusage.json -z UTC -s 20260101 -u " +
      lastDay.replace(/-/g, "") +
      " --mode {auto,calculate}",
    fixtureNote:
      "One compact-JSON assistant line per case, one distinct UTC day each, " +
      "written under <fixture-tree>/projects/goldens/<index>.jsonl.",
    configPath: "packages/collector/ccusage.json",
    configSha256: createHash("sha256").update(readFileSync(configPath)).digest("hex"),
    pricingOverrides: overrides,
  },
  cases: goldens,
};

mkdirSync(dirname(goldensPath), { recursive: true });
writeFileSync(goldensPath, JSON.stringify(document, null, 2) + "\n");
rmSync(workDir, { recursive: true, force: true });

console.log(`gen-native-pricing-goldens: ccusage ${actualVersion}`);
console.log(`gen-native-pricing-goldens: wrote ${goldens.length} cases to ${relative(repoRoot, goldensPath)}`);
console.log("");
for (const golden of goldens) {
  const flag = golden.missingPricing ? "  (missingPricing)" : "";
  const reported = golden.reportedCostUsd != null ? `  (reported ${golden.reportedCostUsd})` : "";
  console.log(
    `  ${golden.name.padEnd(34)} ${golden.reportedModelName.padEnd(32)} ` +
      `auto=${golden.cost} calculate=${golden.calculatedCost}${flag}${reported}`,
  );
}

/**
 * Read `defaults.pricingOverrides` out of the shipped ccusage config so the
 * Go test applies exactly the block this run's costs were computed under. The
 * goldens carry their own copy on purpose: the test must not silently skip the
 * overrides because a path moved.
 */
function readShippedOverrides(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const values = config?.defaults?.pricingOverrides;
  if (!values || typeof values !== "object" || Object.keys(values).length === 0) {
    console.error(`gen-native-pricing-goldens: ${path} carries no defaults.pricingOverrides.`);
    process.exit(1);
  }
  // A stable key order keeps the committed file diff-friendly.
  return Object.fromEntries(Object.keys(values).sort().map((key) => [key, values[key]]));
}
