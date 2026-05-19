# TokenBoard

TokenBoard collects local AI token usage from Claude Code and Codex, uploads normalized daily
aggregates to Cloudflare Workers + D1, and shows usage stats on a hosted dashboard.

## Install Collector

Open the deployed site and visit:

```txt
https://tokenboard.chaosyn.com/settings/install
```

Generate an install prompt, paste it into Codex or Claude Code, and let the agent install the
TokenBoard skill. The skill runs `setup.mjs`, exchanges the short-lived pairing code for an upload
token, installs the collector, creates the daily schedule, and runs the first sync.

The collector uploads aggregate token counts only. It does not upload prompts, completions, file
contents, or raw conversation logs.

`setup.mjs` clones or updates the collector checkout in `~/.tokenboard/TokenBoard`, writes
`~/.tokenboard/config.json`, installs the platform scheduler, and runs a full-history initial sync
unless `--skip-initial-sync` is set. The default schedule is `09:00,12:00,18:00,23:00`, and
custom schedules must be passed as `--schedule-times HH:MM,HH:MM`.

Scheduler targets:

- macOS: `~/Library/LaunchAgents/com.tokenboard.daily-sync.plist`
- Linux: `~/.config/systemd/user/tokenboard-daily-sync.timer`
- Windows: one `TokenBoardDailySyncHHMM` scheduled task per configured time

Daily and manual sync default to a 7-day local-time lookback window. Use `--since all` only for
explicit backfills. For large Codex histories, set `TOKENBOARD_CODEX_BATCH_SIZE=200` during full
history scans.

Scheduled runs write logs to `~/.tokenboard/logs/daily-sync.out.log` and
`~/.tokenboard/logs/daily-sync.err.log`. Rotated logs are capped at 1 MiB and kept for 7 days.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Deploy:

```bash
pnpm run deploy
```

## Package Managers

The repository defaults to pnpm for development and CI. Collector workspace dependencies are always
bootstrapped with `corepack pnpm install --frozen-lockfile`, including setup on Windows. The
configured package manager controls how local usage providers are invoked after install:

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

## Operations

Inspect local config and installed schedule:

```bash
node skills/tokenboard/scripts/status.mjs
```

Remove only the installed schedule:

```bash
node skills/tokenboard/scripts/uninstall.mjs
```

Remove the schedule, collector checkout, and local config directory:

```bash
node skills/tokenboard/scripts/uninstall.mjs --all
```
