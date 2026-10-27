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
price value types, and responses larger than 16 MiB. A row is retained only when it has numeric
input and output token prices; modality-only rows without both token prices are omitted. Image,
audio, embedding and other modality rows remain available when they also expose those numeric
token prices. Missing or zero context limits are stored as `0` instead of inventing a context size.
A failed sync never clears or partially replaces the last successful catalogue. The diff publish
is a single transactional batch up to the D1 statement limit; only a single sync removing more
than ~4,657 models (over half the catalogue) would split it, and any later sync converges on
whatever landed. A stored row whose content no longer parses is treated as changed and
overwritten by the next publish, so one corrupt row cannot wedge the sync; only an unreadable
primary key, which the diff cannot name, still fails closed.

The service stores prices in USD per one million tokens. The original normalized `pricing_json`
keeps provider-specific tiers, including OpenAI's 272,000-token long-context tier, instead of
flattening it into an incorrect 128k or 200k threshold. Antigravity sources remain cost-unavailable;
their `costUsd: 0` value is not a free-price entry.

## Worker service

The production Wrangler configuration enables the sync job every 24 hours. The existing 15-minute
Worker Cron trigger invokes the job, but the D1 state row enforces the interval and a 10-minute
ownership lock. Concurrent Worker instances cannot overwrite each other's result. This is a
server-side D1 update path; it does not create GitHub commits or pull requests.

Each due sync diffs the normalized source against the stored active catalogue and publishes only
the changed rows, plus explicit deactivations for rows the source no longer publishes. A day's
upstream edits are a handful of models out of ~8,300 (measured 2026-10-13: 8 price changes, 3
renames against an 8,319-row catalogue), so an unchanged or barely changed day writes one state
row instead of rewriting the whole table through staging, the catalogue and its indexes, and a
full-table `is_active` flip. A forced sync always publishes — and so bumps the generation for
cursor and ETag invalidation — even when the diff is empty. Rows whose content did not change
keep the `fetched_at` and generation they were written with; the active view is served by
`is_active`, not by the generation column.

The sync also reports zero-price flips. A source row that previously carried a positive price and
now reports 0/0 is applied like any other change — a legitimate free launch and an upstream
regression are indistinguishable in the diff — and is listed in the sync result's `zeroFlips` (and
logged by the scheduled handler) so the operator can verify the affected costs before trusting them.
A row that was already zero-priced is not reported again.

On first deployment, apply migrations `0030_model_pricing.sql` through
`0034_drop_api_rate_limits_reset_index.sql` in order before publishing the Worker. Migration 0030
creates the generation state column together with the sync state table; migration 0031 contains only
idempotent staging-table and index creation; migration 0032 repairs legacy ownership of the reserved
public slug; migration 0033 adds the expression index used by rate-limit cleanup; and migration 0034
removes the superseded reset-time index. All five migrations are safe to retry. Subsequent price
changes are written directly by the Worker Cron and do not require a repository checkout or review
loop.

Current prices are available at the deployment's `/api/public/model-pricing` endpoint. The
`model-pricing` slug is reserved and cannot be saved through profile settings. The included
`0032_reserved_model_pricing_slug.sql` migration renames any legacy owner to
`model-pricing-legacy`, or to the first available deterministic
`model-pricing-legacy-<user-id-suffix><sequence>` slug when that target is occupied; rerunning the
migration is idempotent. If the bounded numeric suffix space is exhausted, it first tries a
fixed-width hexadecimal fallback and then continues through deterministic candidates until a free
slug is found. The fixed catalogue route also
takes precedence over the reserved endpoint.
The catalogue remains available through `/api/v1/model-pricing` as a compatibility alias. The default
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
1 to 1,000; pages contain at most that many rows, so Worker and D1 reads remain bounded. Follow
`nextCursor` for larger catalogues; inactive history is never silently truncated. The response also
carries a generation-bound `ETag` and a short public cache policy;
send `If-None-Match` to receive `304` when the active catalogue generation and page are unchanged.
A Cache Rule on the deployed zone rewrites a short positive `max-age` under `/api/public/*`
to the four-hour Browser Cache TTL, so the public route cannot express its policy as a
`max-age` of 60 — it reached clients as `max-age=14400`. The public route therefore answers
`public, max-age=0, must-revalidate`, which the zone passes through untouched (measured), and
relies on the ETag to turn each revalidation into a `304`. Its Worker cache entry is written
separately under `public, max-age=300` so an edge hit does not reach D1; `server.ts` splits the
two the same way for the usage cards. The collector is unaffected either way: it reads
`/api/v1/model-pricing`, which is not matched by the rule and keeps `max-age=60`.
An invalid, expired, or filter-mismatched cursor or limit returns HTTP 400 with an explicit API
error; discard that cursor and restart from the first page. Keep the same `provider`,
`includeInactive`, and active generation (implicitly carried by the cursor) when following a
cursor.

For an immediate refresh, configure a Worker secret once and call the protected endpoint:

```bash
pnpm exec wrangler secret put TOKENBOARD_MODEL_PRICING_SYNC_TOKEN --config wrangler.production.jsonc
curl -X POST \
  -H "Authorization: Bearer <the-secret>" \
  https://<tokenboard-domain>/api/v1/model-pricing/sync
```

The secret is not stored in Wrangler vars or committed files. The endpoint accepts a `Bearer`
scheme followed by one non-whitespace token. The endpoint first performs a read-only availability
check for the invalid-credential shield, then verifies the token. Invalid credentials consume a
separate 30-request-per-15-minute client-IP shield, while valid requests are limited to five requests
per 15 minutes for the configured sync token. The valid limit is intentionally global for callers
sharing that one Worker secret, so rotating source IPs
cannot bypass the burst guard. This keeps invalid traffic from consuming the legitimate operator's
refresh budget while still slowing credential guessing. The invalid shield trusts Cloudflare's
`cf-connecting-ip`; requests through a non-Cloudflare proxy without that header share a fail-safe
`unknown` bucket. The limit is a burst guard for the forced refresh path and does not replace the D1
ownership lock. A rate-limited response is HTTP 429 and includes `Retry-After` in seconds.

A manual request forces a refresh, but still uses the same due-check override, lock and atomic
publish path as the scheduled job (forced, so it republishes and bumps the generation even when
the fetched catalogue is identical). The protected manual response reports sync status, model
count, and a redacted sync state (it never returns the lock token); the public catalogue only
returns model rows and the pagination cursor. A failed fetch or activation keeps the last
successful generation and records the failure for the next scheduled retry.

## Collector integration

Claude Code and Codex usage is calculated locally by the pinned `ccusage@20.0.33` runtime. Before a
normal preview or sync, the collector derives the origin from `TOKENBOARD_ENDPOINT`, reads the
paginated `/api/v1/model-pricing` compatibility alias, and writes a merged temporary `ccusage` config
under `TOKENBOARD_STATE_DIR`. Dynamic catalogue prices override the bundled
`packages/collector/ccusage.json`; a user-supplied `TOKENBOARD_CCUSAGE_CONFIG` remains the highest
priority layer. The generated config is passed through `TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG` and the
same package-runner entry point for local binaries, npx, npm, pnpm, and bun.
For Codex request-level repricing, models explicitly listed in the user's `pricingOverrides` are
excluded from catalogue and static context rules so the explicit prices remain authoritative.

The catalogue is provider-scoped while usage records carry only a model id. When several provider
rows share one model id, they are kept only when every positive-priced row agrees exactly on
input/output/cache prices (and pricing metadata); otherwise the id stays unresolved rather than
guessing which row applies. Agreeing rows collapse to one representative — preferring the
official vendor's row for its spec metadata — and zero-priced rows never join a group that has a
real price, so an official vendor's $0 placeholder cannot silently price a model as free.

`ccusage` does not match an override key to a session's model name exactly: it folds a provider
prefix and a fine-tune variant suffix first, so a `xiaomi/mimo-v2.6-flash-uncensored` key can price
a plain `mimo-v2.6-flash` day. An unresolved id has no key of its own, so such a folding key is the
only candidate left and it wins — one machine billed 3.6x the official rate for `mimo-v2.6-flash`
this way while its reseller rows disagreed. Because an exact key beats a folding one, the official
vendor row for a base id that a variant key could reach is emitted under the base id itself. Only an
official row qualifies; anchoring from a reseller row would re-create the ambiguity the id was left
unresolved for, and an id with no official row keeps whatever `ccusage` would have used.

Several official vendors can price one id differently — `zai` and `zhipuai`, or `alibaba` and
`alibaba-cn`, publish separate regional rates for the same model. The anchor picks the
alphabetically first official provider (then model id) among its rows rather than the first match in
arrival order. Arrival order comes from the public catalogue's `ORDER BY provider, model_id`, so
letting it decide would make every collector's cost depend on a query in the web layer; the sort
here keeps the choice a property of the collector contract, and CI's golden pins it on both sides.
The collapse's representative pick follows the same rule for the same reason: rows that agree on
price can still disagree on context window, and the representative's window becomes
`maxInputTokens`.

Matching is also case-sensitive: a session model `GLM-5.3-Flash` is not priced by a
`glm-5.3-flash` key. The catalogue publishes several spellings of one id, and the collapse emits
only the representative's spelling, so the collector repeats each override under every spelling the
catalogue publishes for that id. Aliases are only added for ids that already have an emitted
override, so the collapse's ambiguity decision stands and no spelling the catalogue does not
publish is invented. On the 2026-10-27 catalogue this added 43 keys; over 2026-10-21..26 the
Claude Code total moved from 6903.42 to 6885.12 — some sessions previously fell back to
`ccusage`'s own table (a different price), others were unpriced at $0.

The catalogue cache is `TOKENBOARD_STATE_DIR/model-pricing-cache.json`, is written atomically, and
has a 24-hour TTL. A regular or manual sync refreshes an expired cache with ETag support. Hook mode
does not make network requests: it uses a fresh or stale last-successful cache, then the bundled
static config. A failed refresh never blocks token collection. Diagnostics identify the selected
source and refresh failure. A model with no TokenBoard override is not by itself a problem —
`ccusage` prices it from its own builtin catalogue — so the warning is emitted only for a model
that came back with real usage and zero cost, which is what an unpriced model actually looks like.

The catalogue is intentionally not joined into historical usage aggregation. An ingested `costUsd`
is the price that applied when the collector measured that day, not a live view of the catalogue, so
it survives later catalogue changes. A scheduled sync re-scans its lookback window on every run and
re-derives each day with the prices current at that moment; ingest therefore keeps the stored cost
whenever the re-derived token counts are identical, which is what a catalogue change alone looks
like. A day whose token counts actually moved is a new measurement and takes the new cost, so a day
that genuinely grew still reports the spend it grew by. Repricing already-ingested days is not
performed and would require a separate, explicitly versioned migration because provider tiers, cache
semantics and exchange-rate assumptions can change independently of token counts.

The override values are USD per token, so official USD-per-million values are divided by 1,000,000.
`ccusage@20.0.33` exposes only fields named `*Above200kTokens`; those fields are intentionally not
used for GPT-5.x because the current long-context boundary is 272,000 tokens. Do not change that
boundary without upgrading the collector runtime and adding a matching schema test.

For Codex request-level repricing, runtime rules are generated from each catalogue row's explicit
`pricing_json.tiers` context threshold and cache prices. Static rules remain available when the
catalogue is unavailable. A 200,000 threshold can be represented by ccusage's `*Above200kTokens`
fields; a 272,000 or other threshold is never incorrectly mapped to 200,000, and is instead applied
from raw Codex `token_count` events. Once a request is above its threshold, all of its priced input,
output, cache-read and cache-write components use that tier. Fast and priority multipliers are kept
when published or when a matching static rule provides them. These are request thresholds, not model
context-window limits.

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
