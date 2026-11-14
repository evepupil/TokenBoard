// The closed source set, mirrored from packages/usage-core/src/schema.ts.
//
// The skill scripts run from a plain git checkout with no build step, so they
// cannot import the TypeScript package. This module is the one copy they share;
// `usage-sources.test.mjs` parses the usage-core declaration and fails when the
// two drift, so a source added on one side cannot be forgotten here.
//
// The order is usage-core's declaration order. Lists that derive from it keep
// that order on purpose: it is what the collector walks and what the dashboard
// renders, so a reordering would show up as a diff in both.
export const usageSources = [
  'claude-code',
  'codex',
  'antigravity-cli',
  'antigravity',
  'antigravity-ide',
  'opencode',
  'pi',
  'grok-build',
  'deepseek-harness',
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
]

// The subset collected by shelling out to the pinned ccusage runtime, one
// subcommand per tool (`gemini-cli` maps to `gemini`).
export const ccusageToolSources = [
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
]
