# TokenBoard

TokenBoard is a hosted AI token usage dashboard for Claude Code, Codex, Antigravity, OpenCode, Pi,
Grok Build and DeepSeek Harness. A local collector normalizes daily usage snapshots, uploads them to
a Cloudflare Workers + D1 backend, and the web app serves private dashboards, leaderboards, public
JSON, README SVG cards, and scheduled reports.

TokenBoard never uploads prompts, completions, raw conversation logs, local paths, or plaintext upload
tokens.

## Highlights

- Claude Code, Codex, Antigravity CLI, Antigravity, Antigravity IDE, OpenCode, Pi, Grok Build and
  DeepSeek Harness collection through a local Node.js collector.
- Dashboard totals, detail drill-down, CSV export, public JSON, README SVG cards, and leaderboards.
- Total tokens, tokens without cache reads, and cache-read rate across every reporting surface.
- Device-aware upload tokens, device-link reconnect, and legacy collector compatibility.
- Sources that report no cost of their own (Antigravity, Grok Build, DeepSeek Harness) are marked
  unavailable everywhere instead of being treated as complete `$0.00` usage.
- Daily webhook reports for WeCom, DingTalk, Feishu, and Lark.
- D1 summary caches and bounded cron backfills tuned for Cloudflare free-tier limits.

## Quick Start

Open the deployed app and visit:

```txt
https://<your-tokenboard-domain>/settings/install
```

Generate an install prompt, paste it into Codex or Claude Code, and let the agent run setup. The
setup flow pairs the device, writes `~/.tokenboard/config.json` and the local
`~/.tokenboard/device-link.json` recovery claim, installs scheduled sync and notifier hooks, then
runs the initial sync unless `--skip-initial-sync` is used.

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

Provider payload behavior:

| Provider | Message shape | CTA behavior |
| --- | --- | --- |
| WeCom | Markdown capped to the WeCom webhook byte budget. | Inline report link, or leaderboard link when report sharing is unavailable. |
| DingTalk | Signed `actionCard` when a signing secret is configured; the message keeps the `TokenBoard` keyword for keyword-protected robots. | `singleTitle` / `singleURL` button plus a preserved inline fallback link outside truncated text. |
| Feishu / Lark | Interactive Card 2.0 with optional signed webhook body. | Card button uses `open_url` behavior, with report detail as the preferred target and leaderboard fallback. |

Reports include totals, tokens without cache reads, cache rate, cost, sessions, source split, top
models, and a link to that report's aggregate snapshot page when daily report sharing is enabled.
Test sends are labeled as previews. Scheduled sends are deduped by subscription, report date, and
schedule slot; failures retry up to three attempts before moving to the next slot.

Daily report history stores only aggregate snapshots. Users can disable unauthenticated access for
all report links or revoke a single report link from `/settings/notifications`. Owners can still view
their own unexpired private or revoked snapshots while signed in. Anonymous `/reports/daily/:id`
reads require the global sharing switch, an unrevoked report link, and a report date inside the
configured retention window. Retention defaults to 30 days and can be configured with
`TOKENBOARD_DAILY_REPORT_HISTORY_DAYS`.

Shared report pages reuse the same usage metric cards as the private dashboard and detail pages. The
four headline metrics keep the raised card surface, compact number formatting, and responsive
four-column, two-column, then single-column layout.

## Collector Behavior

- Scheduled/manual sync uses a 7-day local-time lookback by default.
- `--since` accepts `YYYYMMDD` and `YYYY-MM-DD` for every source; `--since all` performs an
  explicit full-history backfill.
- Hook mode ignores the external full-history setting and reconciles only the changed Claude Code and Codex session dates.
- New collectors upload at most 30 snapshots per request to reduce D1 write pressure.
- The server still accepts legacy 500-snapshot batches and chunks database writes internally.
- `POST /api/v1/ingest/check` lets newer collectors skip unchanged snapshots.
- Upload tokens without `device_id` are stored under the `legacy` device id.
- Aggregate views dedupe overlapping legacy and paired-device rows; concrete device filters read raw
  rows for that device.
- `device-link.json` is local sensitive recovery state. Reconnect requires explicit
  `--use-device-link`; setup never prints the install claim.
- Generated install and upgrade commands resolve the remote default branch from `origin/HEAD`.
  Explicit repo refs try branch checkout first, including all-hex branch names, then fall back to raw
  ref checkout.
- Legacy multi-profile Codex configuration uses a comma-separated `CODEX_HOME`. When a home path
  itself contains a comma, use `TOKENBOARD_CODEX_HOMES_JSON` with a non-empty JSON array of paths
  instead of an ambiguous `CODEX_HOME` value.
- Antigravity collection reads local metadata only and emits `costUsd: 0`. Web, public, report, and
  leaderboard surfaces label those costs as unavailable.
- OpenCode, Pi, Grok Build and DeepSeek Harness read each tool's own local usage records. A tool that
  is not installed is skipped; a genuine read failure fails the run instead of dropping usage.
- Grok Build and DeepSeek Harness report no cost of their own, so they emit `costUsd: 0` and every
  surface labels the cost as unavailable rather than deriving a figure from a pricing table.

Local usage sources:

| Source | Reads |
| --- | --- |
| OpenCode | `~/.local/share/opencode/opencode.db` (`XDG_DATA_HOME` respected) |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`) |
| Grok Build | `~/.grok/{sessions,archived_sessions}/**/updates.jsonl` (`GROK_HOME`) |
| DeepSeek Harness | `~/.dsh/sessions/**/session.jsonl[.zstd]` (`DSH_HOME`, `DSH_SESSION_ROOT`) |
| amp, droid, codebuff, hermes, goose, kilo, copilot, gemini-cli, kimi, qwen, openclaw, zcode | the tool's own store, read through the pinned `ccusage` runtime |

The twelve `ccusage` tools share one collector: each runs `<tool> daily --json` and `<tool> session
--json`, and `gemini-cli` uses ccusage's `gemini` subcommand. A tool that is not installed answers
with an empty report, which is not an error — the source simply contributes nothing to that run.
None of them installs a notifier hook, and none accepts a `--until` window.

Only token counts, model ids and timestamps are read from these stores. For OpenCode the token fields
are projected inside SQLite so the message blob, which also holds prompts and a local path, never
enters the collector. SQLite is read through Node's built-in `node:sqlite`, so nothing has to be
installed; runtimes without it fall back to a `sqlite3` executable, and setting
`TOKENBOARD_SQLITE_BIN` selects that executable explicitly. Both open the database read-only.
Scanning is bounded: depth-capped, symlinked directories are not followed, and oversized files are
skipped.

Notifier hooks:

| Source | Hook |
| --- | --- |
| Codex | `~/.codex/config.toml` `notify` |
| Claude Code | `~/.claude/settings.json` `hooks.SessionEnd` |
| Antigravity CLI | `~/.gemini/antigravity-cli/settings.json` `statusLine.command`, explicit opt-in only |

Hooks coalesce pending work by source in `~/.tokenboard/notify.signal.d`, start at most one background
`notify.mjs` dispatcher or reuse a live cooldown trailing process, and skip auto-upgrade. The legacy
`~/.tokenboard/notify.signal` file is retained only as a visible fallback when atomic queueing fails.
Scheduled, manual, preview, and hook collection share `sync.lock`; a hook child reuses the lock held
by its coordinator. Signals received during a running collection are retained and coalesced into one
trailing run after the default 15-minute cooldown instead of immediately repeating a full reconciliation.
Set `TOKENBOARD_NOTIFY_COOLDOWN_MS` to an integer from `60000` through `7200000` to tune this
hook-only window. The hook handler persists its signal before the background notifier validates this
setting; without shared-lock contention, the configured window is the maximum delay after the most
recent successful TokenBoard reconciliation. Lock timeouts
continue to retry after one minute.
A hook trigger landing within 30 minutes of a scheduled sync time (the config file's `scheduleTimes`)
is skipped: the scheduled run collects the same usage minutes later, and the queued signal is left
for the next hook run to acknowledge.
If a scheduled sync reaches the lock timeout, it records a private deferred state and performs a
bounded in-process retry: at most five attempts with a one-minute delay after each continued lock
contention. The retry never runs checkout upgrade and stops immediately for a real collector failure.
`status.mjs` reports the retry phase and attempt count without exposing local paths or error details.
For verified append-only Claude Code and Codex JSONL files, hook collection reads only the appended
suffix and reconciles only newly affected dates. A missing cursor file hash or trailing-newline
marker, truncation, or replacement falls back to the full-file path.
Bounded Antigravity collection also retries up to 30 older pending daily-model groups per run, and
only acknowledges groups that were included in the successful upload.
Antigravity CLI token totals are derived only from local SQLite history. Its optional status line
handler writes a bounded, sanitized local diagnostic log and never contributes snapshots or uploads.
After acknowledgement, recent SQLite event identities are retained for incremental reconciliation;
older identities are compacted with a persisted frontier. A bounded scan that encounters an unknown
event at or before that frontier stops and requires `--since all`. A full-history scan rebuilds the
canonical daily-model snapshot from SQLite rather than adding a retained local aggregate, keeping
replays idempotent without raw conversation identifiers or unbounded cursor state.

Logs:

```txt
~/.tokenboard/logs/daily-sync.out.log
~/.tokenboard/logs/daily-sync.err.log
```

Rotated logs are capped at 1 MiB and kept for 7 days.

## Development

Node.js 22.23.4+ or 24.22.1+ is required (the range is `^22.23.4 || ^24.22.1 || >=26.12.1`; older releases are missing security fixes for CVE-2026-111497 and the Node TLS hostname bypasses). `.npmrc` sets `engine-strict=true`, so an unsupported Node fails the install instead of warning.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
node --test skills/tokenboard/scripts/*.test.mjs
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
D1 migrations, verifies the critical production schema, and deploys. Cloudflare Workers Builds and
GitHub Actions automatic deployment are intentionally not configured in this repository.

```bash
pnpm --filter @tokenboard/web run deploy
```

Do not deploy with a raw `wrangler deploy` command when migrations are pending. The guarded helper and
the manual release procedure intentionally apply migrations before changing the Worker version.

Required production secrets:

| Secret | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | Better Auth session signing |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client id |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app secret |
| `WEBHOOK_ENCRYPTION_KEY` | 32-byte base64 webhook URL encryption key |

Manual deploy environment:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |
| `CLOUDFLARE_API_TOKEN` | API token with D1 edit and Worker deploy access |
| `D1_DATABASE_ID` | Production D1 database UUID |

Deployment variables:

| Variable | Default | Notes |
| --- | ---: | --- |
| `TOKENBOARD_WORKER_ROUTE` | required | production custom domain host |
| `BETTER_AUTH_URL` | required | canonical `https://...` origin |
| `TOKENBOARD_DAILY_REPORT_HISTORY_DAYS` | `30` | `1` to `31` |
| `TOKENBOARD_COLLECTOR_REPO_URL` | required | GitHub repository used in generated collector install prompts |
| `TOKENBOARD_COLLECTOR_REF` | required | branch/ref used in generated collector install prompts |
| `TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS` | `90` | `1` to `365` |
| `TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE` | `5` | `1` to `5` due subscriptions per tick |
| `TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT` | `50` | `1` to `500` summary keys per cron tick |
| `TOKENBOARD_USAGE_SUMMARY_STRICT` | `false` | set `true` only after summary backfill completes |

Set `TOKENBOARD_COLLECTOR_REPO_URL` and `TOKENBOARD_COLLECTOR_REF` explicitly when the deployed install
prompt must use a different repository or ref.

`wrangler.production.example.jsonc` is the production template. Copy it to the ignored
`apps/web/wrangler.production.jsonc`, fill the route, auth origin, and D1 database id, then run
`pnpm run deploy`.

Production config validation requires:

- `workers_dev: false`
- an HTTPS `BETTER_AUTH_URL`
- a production route
- a D1 UUID
- a GitHub collector repository URL and branch/ref for generated install prompts
- the `*/15 * * * *` notification cron trigger
- numeric retention, cron batch, and summary backfill values

For production recovery after code was deployed without its D1 migrations, follow
[`docs/reviews/UPSTREAM-PRODUCTION-RECOVERY-2026-07-16.md`](docs/reviews/UPSTREAM-PRODUCTION-RECOVERY-2026-07-16.md).

Cron times are UTC. User-facing report times are evaluated against each subscription's configured
timezone.
