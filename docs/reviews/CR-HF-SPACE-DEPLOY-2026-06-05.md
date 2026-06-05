# HuggingFace Space Deploy Verification - 2026-06-05

## Scope

- Branch: `feat/d1-migration-profile-ui-fixes`
- Local image: `tokenboard-hfspace:verified`
- Final web-only image check: `tokenboard-hfspace:final2`
- HuggingFace Spaces:
  - `misonL/tokenboard`
  - `misonL/tokenboard-preview`

## Docker Verification

Commands run in Docker:

```bash
docker build -t tokenboard-hfspace:verified .
docker run --rm tokenboard-hfspace:verified pnpm typecheck
docker run --rm tokenboard-hfspace:verified pnpm test
docker run --rm tokenboard-hfspace:verified pnpm --filter @tokenboard/web build
docker build -t tokenboard-hfspace:final2 .
```

Results:

- `pnpm typecheck`: exit 0.
- `pnpm test`: exit 0. Web test summary: 52 files, 350 tests passed. Collector test summary: 19 files, 141 tests passed. Usage core summary: 1 file, 2 tests passed.
- `pnpm --filter @tokenboard/web build`: exit 0. SSR bundle `dist/index.js` built successfully.
- Docker runtime sanity: container runs as `uid=1000(node)`, `sqlite3` is available, `pnpm --version` returns `10.21.0`, and `chmod 000` files are not readable by the runtime user.
- Final entrypoint smoke: `tokenboard-hfspace:final2` applied all local D1 migrations, `wrangler dev` became ready, and `GET /api/v1/health` returned 200 with `{"ok":true,"name":"TokenBoard"}`.
- `.dockerignore` excludes local environment files, including `.env`, `.env.*`, and `.dev.vars`, so local ignored secrets are not copied into the Docker build context.

Root causes fixed during Docker verification:

- The first Docker test failure was caused by running as `root`, which made chmod-based unreadable file tests invalid.
- After switching to a non-root runtime user, SQLite contract tests failed because `node:24-bookworm-slim` did not include the `sqlite3` CLI. Installing `sqlite3` fixed the real dependency gap.

## Local Container HTTP Verification

Container command:

```bash
docker run --rm -p 7860:7860 --name tokenboard-hfspace-test tokenboard-hfspace:verified
```

Observed startup:

- `wrangler d1 migrations apply DB --local --persist-to /data/wrangler --config wrangler.jsonc` applied all migrations through `0020_daily_report_share_controls.sql`.
- `wrangler dev` became ready on `http://0.0.0.0:7860`.

HTTP checks:

- `GET /api/v1/health`: 200, `{"ok":true,"name":"TokenBoard"}`.
- `GET /reports/daily/bad%20id`: 404 with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.
- Seeded local D1 daily report data:
  - enabled global share plus active report: 200, rendered `Seed User token 日报`, `1,200`, `Codex`, `gpt-5`, and `$1.23`.
  - revoked report: 404.
  - expired report outside 30-day retention: 404.
  - same active report after setting `daily_report_share_enabled = 0`: 404.

One intermediate 500 occurred after manually seeding invalid `source_split` and `top_models` JSON field names. Correcting the seed data to the persisted report schema made the same route return 200.

## HuggingFace Space Deployment

Created and uploaded:

```bash
hf repos create misonL/tokenboard --type space --space-sdk docker --public --exist-ok
hf upload misonL/tokenboard . . --repo-type space
hf repos create misonL/tokenboard-preview --type space --space-sdk docker --public --exist-ok
hf upload misonL/tokenboard-preview . . --repo-type space
```

Current HF state:

- `misonL/tokenboard`: uploaded commit `d24a54235bd672519c8a4a2c6c5d7d2e188fd26c`; runtime is `PAUSED`.
- `misonL/tokenboard-preview`: uploaded commit `88fa4a4d0a0971c97b2f30361a1c4a5181d6e037`; runtime is `PAUSED`.
- Both Spaces report `errorMessage: Flagged as abusive`.
- HF runtime abuse detail: `Blocked by abuse-handler by rule: Streaming`.
- `hf spaces restart misonL/tokenboard --factory-reboot` returned 503 while the Space was in this flagged state.
- `WEBHOOK_ENCRYPTION_KEY` was added as a new HF secret on both Spaces after removing the leaked local file.

The HF deployment is therefore uploaded but not serving traffic. The blocker is HuggingFace platform moderation, not a reproduced Docker build or application runtime failure.

## Security Note

During the first `tokenboard-preview` upload, `apps/web/.dev.vars` was unintentionally included by the broad `apps/web/**` include rule. It contained a `WEBHOOK_ENCRYPTION_KEY`. The file has been removed from both current Space file trees and `.dockerignore` now excludes `.env`, `.env.*`, and `.dev.vars` patterns.

Because the value entered public Space commit history, rotate the exposed `WEBHOOK_ENCRYPTION_KEY` before using webhook encryption in any shared or production environment.
