# TokenBoard

TokenBoard collects local AI token usage from Claude Code and Codex, uploads normalized daily
aggregates to Cloudflare Workers + D1, and shows usage stats on a hosted dashboard.

## Features

- Claude Code and Codex usage collection through a local collector.
- Daily dashboard, details, CSV export, public JSON, README SVG cards, and leaderboards.
- Total-token, no-cache-read token, and cache-rate views across dashboard, exports, public APIs, cards, rankings, and notifications.
- Scheduled daily token reports to WeCom, DingTalk, and Feishu webhook bots.
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

Public JSON includes total token counts, `tokensWithoutCacheRead`, and `cacheReadRate`.
`tokensWithoutCacheRead` is `input_tokens + output_tokens + cache_creation_tokens`; `cacheReadRate`
is `(total_tokens - tokensWithoutCacheRead) / total_tokens`, or `0` when total is zero. Dashboard
source splits, details, CSV export, README SVG cards, leaderboards, and notifications use the same
derived cache-rate definition.

## Daily Webhook Reports

Authenticated users can add webhook bots from `/settings/notifications`. Each subscription stores an
encrypted webhook URL, optional signing secret, provider, local send time, timezone, and enabled state.
The Worker cron trigger scans due subscriptions every 15 minutes and sends that day's token report.

Reports include total tokens, tokens without cache reads, cache rate, cost, sessions, source split,
top models, and a dashboard link. Test sends are labeled as previews so they are not confused with
scheduled daily reports. Delivery logs keep success, skipped, and failure records; failed daily
reports retry up to three attempts before moving to the next scheduled day. Cron workers claim a
short delivery lock before sending, process at most 50 due subscriptions per tick, and the delivery
log has a per-day success unique key to avoid duplicate daily pushes.

Before enabling webhook reports, configure a 32-byte base64 encryption key as a Worker secret:

```bash
openssl rand -base64 32
pnpm --filter @tokenboard/web exec wrangler secret put WEBHOOK_ENCRYPTION_KEY
```

Create a group bot in WeCom, DingTalk, or Feishu/Lark, copy its webhook URL into TokenBoard, and
copy the bot signing secret into `signing secret` when that platform's security mode requires one.

Supported webhook hosts are restricted to official bot endpoints:

- WeCom: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?...`
- DingTalk: `https://oapi.dingtalk.com/robot/send?...`
- Feishu/Lark: `https://open.feishu.cn/open-apis/bot/v2/hook/...` or `https://open.larksuite.com/open-apis/bot/v2/hook/...`

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

Production `master` pushes also run GitHub Actions checks, apply D1 migrations, and deploy the
Worker with the same generated production config.
Configure these GitHub repository secrets under `Settings` -> `Secrets and variables` -> `Actions`:

- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare dashboard account ID, or `wrangler whoami`.
- `CLOUDFLARE_API_TOKEN`: Cloudflare `My Profile` -> `API Tokens` token with D1 edit access for
  the target account.
- `D1_DATABASE_ID`: Cloudflare D1 database UUID from `Workers & Pages` -> `D1 SQL Database`, or
  `pnpm --filter @tokenboard/web exec wrangler d1 list`.

Configure these GitHub repository variables in the same `Actions` page:

- `TOKENBOARD_WORKER_ROUTE`: production custom domain host, for example `tokenboard.example.com`.
- `BETTER_AUTH_URL`: canonical production origin, for example `https://tokenboard.example.com`.

GitHub Actions and clean Cloudflare Workers Builds generate an ignored `wrangler.production.ci.jsonc`
from `wrangler.production.example.jsonc` and environment variables; tracked `wrangler.jsonc` stays
local-preview only.

`pnpm run deploy` validates the selected production Wrangler config before building or deploying. Copy
`apps/web/wrangler.production.example.jsonc` to the ignored local
`apps/web/wrangler.production.jsonc`, fill the route, `BETTER_AUTH_URL`, and D1 `database_id`, and
the deploy script will validate that file before building or deploying. If that ignored private file
is not present, `pnpm run deploy` generates `wrangler.production.ci.jsonc` from `TOKENBOARD_WORKER_ROUTE`,
`BETTER_AUTH_URL`, and `D1_DATABASE_ID`. The preflight requires `workers_dev: false`, a production
route, an HTTPS auth origin, a D1 UUID, and the notification cron trigger, so the local `wrangler.jsonc`
cannot pass production validation. Use `TOKENBOARD_WRANGLER_CONFIG=<path-to-private-config>` when
deploying with a different private config file.

The production Wrangler config also includes a `*/15 * * * *` cron trigger for webhook reports. Cron
times are UTC; user-facing report times are evaluated against each subscription's configured timezone.

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
