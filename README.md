# TokenBoard

TokenBoard collects local AI token usage from Claude Code and Codex, uploads normalized daily
aggregates to Cloudflare Workers + D1, and shows usage stats on a hosted dashboard.

## Install Collector

Open the deployed site and visit:

```txt
https://<your-tokenboard-domain>/settings/install
```

Generate an install prompt, paste it into Codex or Claude Code, and let the agent install the
TokenBoard skill. The skill runs `setup.mjs`, exchanges the short-lived pairing code for an upload
token, installs the collector, creates the daily schedule, installs lightweight notifier hooks, and
runs the first sync.

The web app detects the browser's IANA timezone with `Intl.DateTimeFormat().resolvedOptions()`.
New profiles use that timezone when it is available and valid, with `UTC` as the fallback. Existing
profiles are not silently reinterpreted as browser-detected values. The install prompt uses the
timezone shown in the install form and passes it through `--timezone`, so the generated setup
command follows the user's current browser timezone unless they edit it.

The collector uploads aggregate token counts only. It does not upload prompts, completions, file
contents, or raw conversation logs.

Collector compatibility:

- `POST /api/v1/ingest` is the long-lived upload endpoint. It accepts the stable body shape
  `{ "snapshots": [...] }` and must remain compatible with older collectors.
- `POST /api/v1/ingest/check` is an optimization used by newer collectors to skip unchanged
  snapshots. Older collectors do not call it and should still upload through `/api/v1/ingest`.
- Upload tokens created before device pairing may have no `device_id`. Server ingest stores those
  rows under the `legacy` device id so old collectors and old tokens keep syncing.
- All-device dashboard, details, CSV, public card, and leaderboard views dedupe overlapping
  `legacy` and paired-device rows. A concrete device filter still reads that device's raw rows.

`setup.mjs` clones or updates the collector checkout in `~/.tokenboard/TokenBoard`, writes
`~/.tokenboard/config.json`, installs the platform scheduler and notifier hooks, and runs a
full-history initial sync unless `--skip-initial-sync` is set. The default schedule is
`09:00,12:00,18:00,23:00`, and custom schedules must be passed as
`--schedule-times HH:MM,HH:MM`.

When setup skips the initial full sync, or runs an explicitly bounded initial sync with `--since`,
it warms hook cursors before installing notifier hooks. This prevents the first hook event from
silently backfilling the historical sessions that setup intentionally skipped. A normal full-history
initial sync does not need that warm step.

Notifier hook installation is recommended but optional. Pass `--skip-hook` to setup when the user
does not want Codex or Claude Code config changed during initial install. Hooks can be installed
later with:

```bash
node ~/.tokenboard/TokenBoard/skills/tokenboard/scripts/install-hook.mjs --source all
```

Use `--source codex` or `--source claude-code` to install only one terminal integration.

Scheduler targets:

- macOS: `~/Library/LaunchAgents/com.tokenboard.daily-sync.plist`
- Linux: `~/.config/systemd/user/tokenboard-daily-sync.timer`
- Windows: one `TokenBoardDailySyncHHMM` scheduled task per configured time

Notifier hooks:

- Codex: `~/.codex/config.toml` `notify` points to `~/.tokenboard/bin/notify.cjs`.
- Claude Code: `~/.claude/settings.json` `hooks.SessionEnd` runs the same notifier.
- The notifier only appends `~/.tokenboard/notify.signal` and starts background `notify.mjs`;
  it does not run `ccusage`, scan files, or upload from the foreground hook process.
- Background notify runs use `~/.tokenboard/sync.lock`, `last-success.json`, `last-run.json`,
  and `runs/*.json`. A 5-minute cooldown and trailing run coalesce bursts.
- Hook syncs pass `TOKENBOARD_HOOK_MODE=1` to the collector. The collector keeps
  `codex-cursor.json` and `claude-code-cursor.json` in `~/.tokenboard`, reprocesses only new or
  changed session JSONL files, and marks those cursor entries pending until upload succeeds.
- The hook parser reads only usage counters, model names, and timestamps from session JSONL files
  to identify affected dates. Uploaded snapshots are still produced by a narrow `ccusage`
  reconciliation window for those dates.
- Hook-triggered syncs do not run the auto-upgrade path. They only enqueue and reconcile local
  usage so session-end hooks stay lightweight and cannot mutate the collector checkout.

Daily and manual sync default to a 7-day local-time lookback window. Use `--since all` only for
explicit backfills. For large Codex histories, set `TOKENBOARD_CODEX_BATCH_SIZE=200` during full
history scans. If a Codex session file disappears while the collector is copying a scanned batch,
that file is skipped with a stderr warning and the rest of the Codex source continues. Other copy
errors still fail visibly.

Daily and manual sync run a lightweight upgrade first by default. The upgrade updates the local
collector checkout and installed skill from the configured repo, then continues with collection.
Use `--skip-upgrade`, `TOKENBOARD_SKIP_UPGRADE=1`, or `TOKENBOARD_AUTO_UPGRADE=0` only for
troubleshooting. Run `node skills/tokenboard/scripts/upgrade.mjs` for a manual upgrade without
syncing.

Scheduled runs write logs to `~/.tokenboard/logs/daily-sync.out.log` and
`~/.tokenboard/logs/daily-sync.err.log`. Rotated logs are capped at 1 MiB and kept for 7 days.

## Development

Node.js 22 or newer is required. The web workspace uses Wrangler 4.95, and that
version no longer supports older Node.js runtimes.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Deploy:

```bash
cp apps/web/wrangler.production.example.jsonc apps/web/wrangler.production.jsonc
# Fill route, BETTER_AUTH_URL, and D1 database_id in apps/web/wrangler.production.jsonc.
pnpm --filter @tokenboard/web exec wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
pnpm run deploy
```

The tracked `apps/web/wrangler.jsonc` is local-only and contains placeholder bindings. Production
deploys use the ignored `apps/web/wrangler.production.jsonc` file so public source does not contain
deployment-specific D1 ids or domains. Run the D1 migrations as part of every server rollout. The
current compatibility path depends on the device and snapshot-hash schema migrations, including
`device_id` on upload tokens and `snapshot_hash` on `daily_usage`.

`pnpm run deploy` validates that `apps/web/wrangler.production.jsonc` exists and does not contain
placeholder route, auth URL, or D1 values before it builds or deploys.

## Package Managers

The repository defaults to pnpm for development and CI. Collector workspace dependencies are always
bootstrapped with `corepack pnpm install --frozen-lockfile`, including setup on Windows. The
collector depends on `ccusage` directly, so the normal hot path uses the local
`packages/collector/node_modules/.bin/ccusage` binary after install. If that binary is missing,
the configured package manager is used as a fallback:

```bash
node skills/tokenboard/scripts/install-collector.mjs --package-manager pnpm
node skills/tokenboard/scripts/install-collector.mjs --package-manager bun
node skills/tokenboard/scripts/install-collector.mjs --package-manager npm
```

The same option is available for sync:

```bash
node skills/tokenboard/scripts/sync.mjs --mode sync --source all --package-manager pnpm
```

You can also set `TOKENBOARD_PACKAGE_MANAGER=pnpm|bun|npm`. When unset, scripts use pnpm.
Set `TOKENBOARD_CCUSAGE_BIN=/path/to/ccusage` to force a specific local binary, or
`TOKENBOARD_FORCE_PACKAGE_RUNNER=1` to force the fallback package-manager runner.

## Operations

Inspect local config, installed schedule, and hook status:

```bash
node skills/tokenboard/scripts/status.mjs
```

Remove only the installed schedule:

```bash
node skills/tokenboard/scripts/uninstall.mjs
```

Remove the local config file and installed notifier hooks, while keeping the collector checkout:

```bash
node skills/tokenboard/scripts/uninstall.mjs --remove-config
```

Remove the schedule, notifier hooks, collector checkout, and local config directory:

```bash
node skills/tokenboard/scripts/uninstall.mjs --all
```
