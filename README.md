# TokenBoard

TokenBoard collects local AI token usage from Claude Code and Codex, uploads normalized daily
aggregates to Cloudflare Workers + D1, and shows usage stats on a hosted dashboard.

## Features

- Claude Code and Codex usage collection through a local collector.
- Daily dashboard, details, CSV export, public JSON, README SVG cards, and leaderboards.
- Total-token and no-cache-read token views across dashboard, exports, public APIs, cards, and rankings.
- Device-aware upload tokens with compatibility for legacy tokens.
- Lightweight notifier hooks for near-real-time sync after Codex or Claude Code sessions.
- Private by default: prompts, completions, raw logs, local paths, and upload tokens are not uploaded.

## Install Collector

Open the deployed site and visit:

```txt
https://<your-tokenboard-domain>/settings/install
```

Generate an install prompt, paste it into Codex or Claude Code, and let the agent run setup. The
setup script pairs the device, writes `~/.tokenboard/config.json`, installs the collector schedule
and notifier hooks, then runs the initial sync unless `--skip-initial-sync` is used.

The install form detects the browser's IANA timezone with
`Intl.DateTimeFormat().resolvedOptions().timeZone` and passes it through `--timezone`. `UTC` is used
only when no valid browser timezone is available.

## Public Profile And README Card

Profiles are private by default. Enable public JSON/SVG and leaderboard participation from
`/settings/profile`.

```txt
GET /api/public/:slug.json
GET /api/public/:slug.svg
```

README snippet:

```md
[![TokenBoard](https://<your-tokenboard-domain>/api/public/<slug>.svg)](https://<your-tokenboard-domain>)
```

The card editor supports Chinese/English labels, light/dark themes, layout variants, glow controls,
custom title/subtitle, public URL visibility, metric ordering, hidden metrics, live private preview,
and reset to defaults. Invalid stored card config falls back to the default card instead of breaking
the settings page.

Public JSON includes both total token counts and `tokensWithoutCacheRead`, which is calculated as
`input_tokens + output_tokens + cache_creation_tokens`. Dashboard source splits, details, CSV export,
README SVG cards, and leaderboards can use the same no-cache-read token view.

## Collector Behavior

Sync entry points:

- Scheduled/manual sync: uses a 7-day local-time lookback by default.
- Explicit backfill: pass `--since all`.
- Large Codex histories: set `TOKENBOARD_CODEX_BATCH_SIZE=200`.
- Upgrade before sync: enabled by default for scheduled/manual sync; disable with
  `--skip-upgrade`, `TOKENBOARD_SKIP_UPGRADE=1`, or `TOKENBOARD_AUTO_UPGRADE=0`.

Notifier hooks:

- Codex: `~/.codex/config.toml` `notify` calls `~/.tokenboard/bin/notify.cjs`.
- Claude Code: `~/.claude/settings.json` `hooks.SessionEnd` calls the same notifier.
- Foreground hooks only append `~/.tokenboard/notify.signal` and start background `notify.mjs`.
- Hook syncs set `TOKENBOARD_HOOK_MODE=1`, skip auto-upgrade, use `sync.lock`, and coalesce bursts
  with a 5-minute cooldown plus trailing run.
- Hook cursors live in `codex-cursor.json` and `claude-code-cursor.json`.

Compatibility:

- `POST /api/v1/ingest` is the stable upload endpoint.
- `POST /api/v1/ingest/check` lets newer collectors skip unchanged snapshots.
- Upload tokens without `device_id` are stored under the `legacy` device id.
- Aggregate views dedupe overlapping `legacy` and paired-device rows; concrete device filters read
  that device's raw rows.

Logs:

```txt
~/.tokenboard/logs/daily-sync.out.log
~/.tokenboard/logs/daily-sync.err.log
```

Rotated logs are capped at 1 MiB and kept for 7 days.

## Development

Node.js 22.12 or newer is required.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Deploy manually:

```bash
pnpm run deploy
```

`pnpm run deploy` validates the production config, builds the Worker, applies pending remote D1
migrations, and deploys.

For Cloudflare Workers Builds, set the production deploy command to the same script so migrations
run in the deploy path:

```bash
pnpm --filter @tokenboard/web run deploy
```

If the Workers Build root directory is `apps/web`, use:

```bash
pnpm run deploy
```

Production `master` pushes also run GitHub Actions checks and D1 migrations as an audit trail.
Configure these GitHub repository secrets under `Settings` -> `Secrets and variables` -> `Actions`:

- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare dashboard account ID, or `wrangler whoami`.
- `CLOUDFLARE_API_TOKEN`: Cloudflare `My Profile` -> `API Tokens` token with D1 edit access for
  the target account.

The workflow does not deploy the Worker. If Cloudflare git builds are not enabled, run
`pnpm run deploy` manually.

`pnpm run deploy` validates that `apps/web/wrangler.jsonc` does not contain placeholder route,
auth URL, or D1 values before building or deploying.

## Package Managers

Collector scripts default to pnpm and can use bun or npm:

```bash
node skills/tokenboard/scripts/install-collector.mjs --package-manager pnpm
node skills/tokenboard/scripts/sync.mjs --mode sync --source all --package-manager pnpm
```

Environment overrides:

- `TOKENBOARD_PACKAGE_MANAGER=pnpm|bun|npm`
- `TOKENBOARD_CCUSAGE_BIN=/path/to/ccusage`
- `TOKENBOARD_FORCE_PACKAGE_RUNNER=1`

## Operations

```bash
# Inspect config, schedule, and hooks
node skills/tokenboard/scripts/status.mjs

# Remove only the schedule
node skills/tokenboard/scripts/uninstall.mjs

# Remove config and notifier hooks, keep checkout
node skills/tokenboard/scripts/uninstall.mjs --remove-config

# Remove schedule, hooks, checkout, and config directory
node skills/tokenboard/scripts/uninstall.mjs --all

# Install hooks later or reinstall hooks only
node ~/.tokenboard/TokenBoard/skills/tokenboard/scripts/install-hook.mjs --source all
```
