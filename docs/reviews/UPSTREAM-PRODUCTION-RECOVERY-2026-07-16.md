# Upstream Production Recovery - 2026-07-16

## Incident

After PR #19 was merged, authenticated requests to `/dashboard/details` and `/settings/devices`
returned HTTP 500. Public pages and `/api/v1/health` remained available. Existing collectors also
stopped recording successful uploads.

## Root Cause

The Worker code was updated without applying the matching D1 migrations.

- Both authenticated pages call `listUserDevices`, which queries `device_installations` and
  `upload_tokens.installation_id`.
- Upload token authentication also selects `upload_tokens.installation_id` before parsing the
  collector request body.
- Migration `0022_device_installations.sql` creates and backfills those objects. Migrations `0023`
  and `0024` complete the device identity contract.
- The last recorded GitHub deployment workflow failed because required production configuration was
  absent, and that automatic workflow was later intentionally removed in favor of manual deployment.

This is not an old collector payload incompatibility. Existing Claude Code and Codex snapshots remain
valid. The failure occurs in the server database query before the request payload is parsed.

## Immediate Recovery From Current Master

An upstream maintainer with Cloudflare access can restore service before merging PR #20:

1. Pull the latest upstream `master` into a clean checkout.
2. Authenticate Wrangler against the Cloudflare account that owns the production Worker and D1 database.
3. From `apps/web`, record a D1 Time Travel restore point:

   ```bash
   timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   pnpm exec wrangler d1 time-travel info DB \
     --timestamp "$timestamp" \
     --json \
     --config wrangler.jsonc
   ```

4. From the repository root, run the guarded deploy helper:

   ```bash
   TOKENBOARD_WRANGLER_CONFIG=wrangler.jsonc pnpm --filter @tokenboard/web run deploy
   ```

5. Confirm Wrangler reports no migration or deployment error.
6. Confirm there are no pending migrations:

   ```bash
   cd apps/web
   pnpm exec wrangler d1 migrations list DB --remote --config wrangler.jsonc
   ```

This path applies every pending migration before publishing the Worker. Do not run a standalone
`wrangler deploy` first.

## Recovery After Merging PR #20

PR #20 does not configure GitHub Actions or Cloudflare Workers Builds automatic deployment. An upstream
maintainer with Cloudflare access must run the guarded deploy helper locally.

Before deploying, confirm the production Worker already contains these Worker secrets:

- `BETTER_AUTH_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `WEBHOOK_ENCRYPTION_KEY`

### Run The Guarded Deploy Helper

1. Create a private production Wrangler config from `wrangler.production.example.jsonc`.
2. Set `TOKENBOARD_WRANGLER_CONFIG` to that config and authenticate Wrangler with the production account.
3. Install dependencies, then run workspace tests, skill-script tests, and type checking.
4. Record a D1 Time Travel restore point.
5. Run the guarded deploy helper:

   ```bash
   TOKENBOARD_WRANGLER_CONFIG=wrangler.production.jsonc pnpm --filter @tokenboard/web run deploy
   ```

The helper:

1. validates the selected production Wrangler config;
2. builds the Worker;
3. applies all pending D1 migrations;
4. verifies critical tables and columns using `db/verify-critical-schema.sql`;
5. deploys the Worker.

Tests, type checking, the D1 Time Travel restore point, and the post-deploy health check remain explicit
operator steps outside the helper.

## Historical Local Follow-up Verification - 2026-07-19

The following is a historical local verification snapshot for the follow-up branch against
`c43b67c`. Its test counts are not evidence for later uncommitted changes. The current candidate
must rerun the full T08 quality gate before deployment or PR submission.

- `pnpm test`: passed (9 usage-core, 407 collector, and 572 web tests; 988 total).
- `pnpm typecheck`: passed for every workspace package.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed (347 tests).
- `pnpm --filter @tokenboard/web exec vitest run development-seed-migration.test.ts pairing-code-index-migration.test.ts deploy-config.test.ts`: passed (32 tests).
- `pnpm build`: passed for the client and Worker bundles.
- `pnpm audit --audit-level=high`: reported no known high- or critical-severity vulnerabilities.
- `git diff --check c43b67c`: passed without whitespace errors.

The collector coverage also rejects impossible ISO calendar dates in ccusage data and Codex
subagent session metadata or child usage events, so malformed local timestamps cannot be
normalized into another usage day.

## Current Candidate Quality Gate - 2026-07-23

This is current local quality evidence for the uncommitted
`fix/post-merge-reliability-followups` candidate. It is not a deployment or production recovery
record, and it does not replace the required private Cloudflare migration, authenticated-page, or
existing-collector ingest checks.

- `pnpm test`: passed (9 usage-core, 466 collector, and 576 web tests; 1,051 total).
- `pnpm typecheck`: passed for every workspace package.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed (350 tests).
- `pnpm build`: passed for the client and Worker bundles.
- `pnpm audit --audit-level=high`: reported no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed without whitespace errors.

The user explicitly disabled the `codex-security` plugin. The final code therefore received a
documented manual diff-scoped security review instead; it found no confirmed security issue but does
not replace the independent review required below. Current local collector/hash reconciliation,
independent read-only review, and private Cloudflare deployment validation remain required before a
PR can be submitted or this incident can be declared fully recovered.

## Current Candidate Quality Gate - 2026-07-25

This is the current local quality snapshot for the uncommitted
`fix/post-merge-reliability-followups` candidate after the final Codex JSONL file-identity fix. It
does not establish a Worker deployment, remote D1 migration, authenticated page rendering, or real
existing-collector ingestion.

- `pnpm test`: passed (9 usage-core, 548 collector, and 578 Web tests; 1,135 total).
- `pnpm typecheck`: passed for every workspace package.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed (352 tests).
- `pnpm build`: passed for the client and Worker bundles.
- `pnpm audit --audit-level=high`: reported no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- The focused Web/D1 gate passed 8 test files and 123 tests, including both pending migrations,
  critical schema verification, reconnect conditional writes, the pair route, and device rendering.
- Manual diff-scoped review covered 92 tracked path changes and 36 untracked supporting files. The
  user prohibited the `codex-security` plugin; no plugin scan was run, and no confirmed security
  issue was identified by the manual review.

The remaining gates are local one-month reconciliation, independent read-only review, and a new
private Cloudflare validation with a fresh D1 restore point. The historical private deployment record
below must not be treated as evidence for this uncommitted candidate.

## Historical Candidate Quality Gate - 2026-07-27

This is the current local quality snapshot for the uncommitted
`fix/post-merge-reliability-followups` candidate. It supersedes the preceding local counts after a
Codex profile-cursor data-loss regression was fixed. It is not evidence of a Worker deployment,
remote D1 migration, authenticated page rendering, or an existing collector ingest.

- `pnpm test`: passed (9 usage-core, 578 collector, and 578 Web tests; 1,165 total).
- `pnpm typecheck`: passed for every workspace package.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed (353 tests).
- `pnpm build`: passed for the client and Worker bundles.
- `pnpm audit --audit-level=high`: reported no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`: passed.
- The focused Web/D1 gate passed 8 test files and 123 tests, including migrations, critical schema,
  conditional reconnect writes, the pair route, and device rendering.
- The focused collector gate passed 10 test files and 162 tests, including Codex profile cursor
  migration/acknowledgement, hook pending state, Antigravity replay/rebuild, and upload deadlines.
- Every migration through `0029` applied in order to temporary SQLite; critical schema and foreign
  key checks produced no output.
- The manual diff review and no-content credential-marker scan reported no confirmed finding.
  The user prohibited the `codex-security` plugin, so it was not used.

This snapshot was superseded after the branch incorporated the later upstream integration and its
Windows and hook changes. The historical deployment record below must not be treated as evidence for
the current candidate.

## Current Candidate Quality Gate - 2026-07-27 Upstream Integration

This is the current local quality snapshot for the uncommitted
`fix/post-merge-reliability-followups` candidate after it incorporated the upstream integration.
It is not evidence of a Worker deployment, remote D1 migration, authenticated page rendering, or an
existing collector ingest.

- Package test runs passed: 9 usage-core, 595 collector, and 580 Web tests.
- `pnpm typecheck` passed for every workspace package.
- `node --test skills/tokenboard/scripts/*.test.mjs` passed with 354 tests.
- `pnpm build` passed for the client and Worker bundles.
- `pnpm audit --audit-level=high` reported no known vulnerabilities.
- `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` passed.
- The focused Web/D1 gate passed 35 tests, including immediate and deferred foreign-key seed cleanup,
  migrations, critical schema, conditional reconnect writes, the pair route, and device rendering.
- All migrations through `0029` applied in order to SQLite `:memory:`; critical schema and foreign
  key checks produced no output.
- Manual diff review covered the current candidate's Web/D1, collector, skill, dependency,
  migration, test, and documentation boundaries. The no-content credential-marker scan reported no
  confirmed finding. The user prohibited the `codex-security` plugin, so it was not used.

The remaining gates are the final independent read-only review and a new private Cloudflare deployment
with a fresh D1 restore point. The historical deployment record below must not be treated as evidence
for this candidate.

### Complexity Review

`apps/web/app/routes/settings/devices.tsx` remains a pre-existing 1,488-line device-management
page (1,510 lines after this patch). This follow-up changes only the 41-line rotated-credential
flash and reuses `CopyableCommandBlock`; moving the device list, details, action forms, and dialog
renderers into separate modules would be a separate UI refactor with a wider behavioral surface.
The file is therefore explicitly exempted from this reliability follow-up. A later UI task should
split it by the existing `DevicesPage`, details, credentials, and installation/audit sections while
preserving its route-level tests.

### Historical Private Deployment Record

The following record describes an earlier private Cloudflare deployment after creating a D1 Time Travel
restore point. The guarded deploy helper applied migration `0029`, verified the critical schema, and
published a Worker version receiving all production traffic. Post-deploy checks confirmed that no
migrations remain, the redundant pairing-code index is absent, `/api/v1/health` returns JSON HTTP 200,
and anonymous requests to `/dashboard/details` and `/settings/devices` redirect to `/auth/sign-in`.

It is not deployment evidence for the current uncommitted follow-up patch. A new guarded deployment,
post-deploy health check, authenticated page check, and existing-client ingest check remain required
before treating the current working tree as deployed.

This verification did not sign in as an end user or send a real collector ingest request, so the
authenticated page rendering and existing-client upload checks below remain mandatory before declaring
the incident fully resolved. The private deployment configuration, account identifiers, database
identifiers, restore point, and credentials are intentionally not recorded here.

### Verify Service Recovery

After the guarded deploy helper succeeds:

1. Sign in and load `/dashboard/details`; it must return the rendered page instead of HTTP 500.
2. Load `/settings/devices`; existing devices, legacy installations, and tokens must render.
3. Run one existing collector without reinstalling or pairing it again.
4. Confirm the collector receives a successful ingest response.
5. Confirm the device `last_synced_at` and upload token `last_used_at` advance in D1.
6. Confirm public leaderboards only reflect users who opted in; an empty leaderboard alone does not
   prove ingestion failed.

Migration `0022` backfills each existing device with a legacy installation and assigns existing upload
tokens to it. Existing users do not need new upload tokens or client reinstallations after the migration.

## Rollback

If a migration or deployment produces a new failure:

1. stop additional deployments;
2. use the restore timestamp/bookmark recorded before deployment to restore D1 with Cloudflare Time Travel;
3. roll back the Worker to the previously recorded version;
4. verify health, authenticated pages, and one collector ingest before reopening traffic.
