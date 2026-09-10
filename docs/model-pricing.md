# Model pricing maintenance

TokenBoard now maintains a server-side model price catalogue. The Worker reads a bounded,
machine-readable snapshot from `models.dev`, validates every provider record, and stores the
result in D1. Each row keeps the provider documentation URL supplied by the source, the source URL,
source update date, complete normalized price object, and fetch time.

## Sources and trust boundary

The machine-readable source is:

- <https://models.dev/api.json>

The catalogue accepts every provider exposed by the source as long as it has an HTTPS `doc` URL.
This includes OpenAI, Anthropic, xAI, DeepSeek, Alibaba, Zhipu, Moonshot, MiniMax, Tencent,
SiliconFlow and other domestic or hosted providers. The stored provider URL is the source-supplied
documentation link and is validated to reject credentials, localhost, non-routable
or shared IPv4 ranges, IPv6 loopback/unspecified/private/link-local targets, and local hostnames.
These HTTPS and SSRF checks protect the fetch boundary but do not independently verify that the
provider owns the linked domain.

`models.dev` is a maintained registry, not a provider-owned API. It is used for discovery and
change detection; the stored provider URL is the human verification path. The Worker refuses an
unapproved source host, malformed provider/model IDs, missing provider documentation, unknown
price value types, and responses larger than 8 MiB. A row is retained only when it has numeric
input and output token prices; modality-only rows without both token prices are omitted. Image,
audio, embedding and other modality rows remain available when they also expose those numeric
token prices. Missing or zero context limits are stored as `0` instead of inventing a context size.
A failed sync never clears or partially replaces the last successful catalogue.

The service stores prices in USD per one million tokens. The original normalized `pricing_json`
keeps provider-specific tiers, including OpenAI's 272,000-token long-context tier, instead of
flattening it into an incorrect 128k or 200k threshold. Antigravity sources remain cost-unavailable;
their `costUsd: 0` value is not a free-price entry.

## Worker service

The production Wrangler configuration enables the sync job every 24 hours. The existing 15-minute
Worker Cron trigger invokes the job, but the D1 state row enforces the interval and a 10-minute
ownership lock. Concurrent Worker instances cannot overwrite each other's result. This is a
server-side D1 update path; it does not create GitHub commits or pull requests.

On first deployment, apply migrations `0030_model_pricing.sql` and
`0031_model_pricing_staging.sql` before publishing the Worker. Migration 0030 creates the
generation state column together with the sync state table; migration 0031 contains only
idempotent staging-table and index creation so a retried deployment is safe. Subsequent price changes
are written directly by the Worker Cron and do not require a repository checkout or review loop.

Current prices are available at the deployment's `/api/public/model-pricing` endpoint. The
`model-pricing` slug is reserved for new profiles; an older profile that already owns that slug is
grandfathered and keeps its legacy public-card response at that path. The catalogue remains
available through `/api/v1/model-pricing` in either case. The default
response contains 100 active models; use `limit` and the returned cursor to page through the
catalogue without requesting the full directory at once:

```text
GET /api/public/model-pricing
GET /api/public/model-pricing?provider=openai
GET /api/public/model-pricing?includeInactive=1
GET /api/public/model-pricing?includeInactive=1&cursor=<nextCursor>
GET /api/public/model-pricing?includeInactive=1&limit=1000
```

Use `provider=<models.dev provider id>` to narrow the response. Provider IDs must use the
validated provider-id format; model IDs are stored exactly as published by the source and may
contain characters such as `/` or `:`.
The response contains `models` and `nextCursor`; when `nextCursor` is non-null, pass it unchanged
as `cursor` to read the next page. `limit` is optional (default 100) and accepts an integer from
1 to 10,000; pages contain at most that many rows, so inactive history is never silently
truncated. The response also carries a generation-bound `ETag` and a short public cache policy;
send `If-None-Match` to receive `304` when the active catalogue generation and page are unchanged.
An invalid, expired, or filter-mismatched cursor or limit returns HTTP 400 with an explicit API
error; discard that cursor and restart from the first page. Keep the same `provider`,
`includeInactive`, and active generation (implicitly carried by the cursor) when following a
cursor. The former `/api/v1/model-pricing` GET path remains as a compatibility alias.

For an immediate refresh, configure a Worker secret once and call the protected endpoint:

```bash
pnpm exec wrangler secret put TOKENBOARD_MODEL_PRICING_SYNC_TOKEN --config wrangler.production.jsonc
curl -X POST \
  -H "Authorization: Bearer <the-secret>" \
  https://<tokenboard-domain>/api/v1/model-pricing/sync
```

The secret is not stored in Wrangler vars or committed files. The endpoint accepts a `Bearer`
scheme followed by one non-whitespace token; authorization whitespace is parsed before both token
verification and rate-limit key construction, so equivalent header formatting cannot create new
rate-limit buckets. Invalid or missing credentials are rejected before rate limiting. Valid manual
requests are limited to five requests per 15 minutes for the client IP and parsed token; this is a
burst guard for the forced refresh path and does not replace the D1 ownership lock.

A manual request forces a refresh, but still uses the same due-check override, lock and atomic
replacement path as the scheduled job. The protected manual response reports sync status, model
count, and a redacted sync state (it never returns the lock token); the public catalogue only
returns model rows and the pagination cursor. A failed fetch or activation keeps the last
successful generation and records the failure for the next scheduled retry.

## Collector integration

Claude Code and Codex usage is still calculated locally by the pinned `ccusage@20.0.20` runtime.
The installed TokenBoard sync script passes the checkout's `packages/collector/ccusage.json`
through `--config` for local, pnpm, npm, and bun runners; it does not depend on the caller's current
working directory. The server catalogue is the authoritative maintenance and audit surface, while
the collector override file remains the offline client fallback until a future client protocol can
consume a signed server snapshot.

The catalogue is intentionally not joined into historical usage aggregation. Ingested `costUsd`
values are the collector's timestamped pricing result and remain stable when the catalogue changes;
the catalogue is used for current price discovery, audit and future collector updates. Repricing old
snapshots would require a separate, explicitly versioned migration because provider tiers, cache
semantics and exchange-rate assumptions can change independently of token counts.

The override values are USD per token, so official USD-per-million values are divided by 1,000,000.
`ccusage@20.0.20` exposes only fields named `*Above200kTokens`; those fields are intentionally not
used for GPT-5.x because the current long-context boundary is 272,000 tokens. Do not change that
boundary without upgrading the collector runtime and adding a matching schema test.

For Codex request-level repricing, the collector currently applies the published context tiers to
`gpt-5.6-sol`, `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`,
`gpt-5.4-pro` at 272,000 input tokens, and `grok-4.5` at 200,000 input tokens. These are request
thresholds: once a request is above the threshold, all of its priced input, output, cache-read and
cache-write components use that tier. They are not the models' context-window limits. Raw Codex
`token_count` events are used because the current ccusage schema cannot represent the 272,000
boundary exactly.

Codex session records can use either of two cache representations. In the legacy representation,
`input_tokens` already includes `cached_input_tokens`; in the additive representation,
`cached_input_tokens` and `cache_write_input_tokens` are separate and the positive `total_tokens`
value includes those fields. The collector detects the representation per usage row and does not
add cached input twice. A zero `total_tokens` value is not used as a format discriminator and keeps
the legacy-compatible parsing used by the existing Codex parser. Rows whose billable input,
output, cache-read, and cache-write components are all zero are metadata rows even when a provider
reports a positive aggregate total; they are excluded from request-level repricing.

The source was manually checked on 2026-08-17: the raw payload contained 186 providers and 6,617
model records; after the same validation and token-price normalization used by the Worker, 6,198
priced models were accepted, with `2026-08-16` as the newest model update date.
The raw and accepted counts are an observation of that response, not a catalogue-size guarantee;
the Worker records the actual model count and source update timestamp for each successful generation.
A deployed Worker may temporarily show the previous successful generation until its next due Cron run;
the Worker sync is the mechanism for subsequent discovery, and changes remain visible with their source
metadata rather than being silently rewritten into historical usage rows.
