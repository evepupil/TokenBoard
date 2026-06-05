# TokenBoard

TokenBoard is a hosted AI token usage dashboard for Claude Code and Codex. A local collector
normalizes daily usage snapshots, uploads them to a Cloudflare Workers + D1 backend, and the web app
serves private dashboards, leaderboards, public JSON, README SVG cards, and scheduled reports.

TokenBoard never uploads prompts, completions, raw conversation logs, local paths, or plaintext upload
tokens.

## Highlights

- Claude Code and Codex collection through a local Node.js collector.
- Dashboard totals, detail drill-down, CSV export, public JSON, README SVG cards, and leaderboards.
- Total tokens, tokens without cache reads, and cache-read rate across every reporting surface.
- Device-aware upload tokens with legacy collector compatibility.
- Daily webhook reports for WeCom, DingTalk, Feishu, and Lark.
- D1 summary caches and bounded cron backfills tuned for Cloudflare free-tier limits.

## Quick Start

Open the deployed app and visit:

```txt
https://<your-tokenboard-domain>/settings/install
```

Generate an install prompt, paste it into Codex or Claude Code, and let the agent run setup. The
setup flow pairs the device, writes `~/.tokenboard/config.json`, installs scheduled sync and notifier
hooks, then runs the initial sync unless `--skip-initial-sync` is used.

The install form passes the browser's IANA timezone from
`Intl.DateTimeFormat().resolvedOptions().timeZone`; `UTC` is used only when the browser cannot provide
a valid timezone.

## Public Sharing

Profiles are private by default. Enable public JSON/SVG and leaderboard participation from
`/settings/profile`.

```txt
GET /api/public/:slug.json
GET /api/public/:slug.svg
```

README card:

```md
[![TokenBoard](https://<your-tokenboard-domain>/api/public/<slug>.svg)](https://<your-tokenboard-domain>)
```

The card editor supports localized labels, light/dark themes, layout variants, custom title/subtitle,
metric ordering, hidden metrics, live private preview, and reset-to-defaults. Invalid stored card
config falls back to a default card instead of breaking the settings page.

## Daily Webhook Reports

Authenticated users can add webhook bots from `/settings/notifications`. Each subscription stores an
encrypted webhook URL, optional signing secret, provider, timezone, selected weekdays, and up to four
local send times. New subscriptions default to `18:00` local time.

Before enabling reports, configure a 32-byte base64 encryption key as a Worker secret:

```bash
openssl rand -base64 32
pnpm --filter @tokenboard/web exec wrangler secret put WEBHOOK_ENCRYPTION_KEY
```

Supported webhook hosts:

| Provider | Host |
| --- | --- |
| WeCom | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?...` |
| DingTalk | `https://oapi.dingtalk.com/robot/send?...` |
| Feishu | `https://open.feishu.cn/open-apis/bot/v2/hook/...` |
| Lark | `https://open.larksuite.com/open-apis/bot/v2/hook/...` |

Reports include totals, tokens without cache reads, cache rate, cost, sessions, source split, top
models, and a link to that report's snapshot page when daily report sharing is enabled. Test sends are
labeled as previews. Scheduled sends are deduped by subscription, report date, and schedule slot;
failures retry up to three attempts before moving to the next slot.

Daily report history stores only aggregate snapshots. Users can disable unauthenticated access for
report links or revoke a single report link from `/settings/notifications`. Retention defaults to 30
days and can be configured with `TOKENBOARD_DAILY_REPORT_HISTORY_DAYS`.

## Collector Behavior

- Scheduled/manual sync uses a 7-day local-time lookback by default.
- Explicit backfill uses `--since all`.
- New collectors upload at most 30 snapshots per request to reduce D1 write pressure.
- The server still accepts legacy 500-snapshot batches and chunks database writes internally.
- `POST /api/v1/ingest/check` lets newer collectors skip unchanged snapshots.
- Upload tokens without `device_id` are stored under the `legacy` device id.
- Aggregate views dedupe overlapping legacy and paired-device rows; concrete device filters read raw
  rows for that device.

Notifier hooks:

| Source | Hook |
| --- | --- |
| Codex | `~/.codex/config.toml` `notify` |
| Claude Code | `~/.claude/settings.json` `hooks.SessionEnd` |

Hooks append `~/.tokenboard/notify.signal`, start background `notify.mjs`, use `sync.lock`, skip
auto-upgrade, and coalesce bursts with a 5-minute cooldown plus a trailing run.

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

Useful collector commands:

```bash
node skills/tokenboard/scripts/status.mjs
node skills/tokenboard/scripts/sync.mjs --mode sync --source all --package-manager pnpm
node skills/tokenboard/scripts/uninstall.mjs
node skills/tokenboard/scripts/uninstall.mjs --remove-config
node skills/tokenboard/scripts/uninstall.mjs --all
```

Package manager overrides:

| Variable | Values |
| --- | --- |
| `TOKENBOARD_PACKAGE_MANAGER` | `pnpm`, `bun`, `npm` |
| `TOKENBOARD_CCUSAGE_BIN` | custom `ccusage` path |
| `TOKENBOARD_FORCE_PACKAGE_RUNNER` | `1` to force package-runner execution |

## Production Deploy

Manual deploy:

```bash
pnpm run deploy
```

The deploy script validates the production Wrangler config, builds the Worker, applies pending remote
D1 migrations, and deploys. For Cloudflare Workers Builds, use the same command:

```bash
pnpm --filter @tokenboard/web run deploy
```

If the Workers Build root directory is `apps/web`, use `pnpm run deploy`.

Required production secrets:

| Secret | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | Better Auth session signing |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client id |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app secret |
| `WEBHOOK_ENCRYPTION_KEY` | 32-byte base64 webhook URL encryption key |

GitHub Actions secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |
| `CLOUDFLARE_API_TOKEN` | API token with D1 edit and Worker deploy access |
| `D1_DATABASE_ID` | Production D1 database UUID |

GitHub Actions variables:

| Variable | Default | Notes |
| --- | ---: | --- |
| `TOKENBOARD_WORKER_ROUTE` | required | production custom domain host |
| `BETTER_AUTH_URL` | required | canonical `https://...` origin |
| `TOKENBOARD_DAILY_REPORT_HISTORY_DAYS` | `30` | `1` to `31` |
| `TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS` | `90` | `1` to `365` |
| `TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE` | `5` | `1` to `5` due subscriptions per tick |
| `TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT` | `50` | `1` to `500` summary keys per cron tick |
| `TOKENBOARD_USAGE_SUMMARY_STRICT` | `false` | set `true` only after summary backfill completes |

`wrangler.production.example.jsonc` is the production template. GitHub Actions and clean Workers
Builds generate the ignored `apps/web/wrangler.production.ci.jsonc` from environment variables. For
manual deploys, copy the template to the ignored `apps/web/wrangler.production.jsonc`, fill the route,
auth origin, and D1 database id, then run `pnpm run deploy`.

Production config validation requires:

- `workers_dev: false`
- an HTTPS `BETTER_AUTH_URL`
- a production route
- a D1 UUID
- the `*/15 * * * *` notification cron trigger
- numeric retention, cron batch, and summary backfill values

Cron times are UTC. User-facing report times are evaluated against each subscription's configured
timezone.
