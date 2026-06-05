#!/usr/bin/env sh
set -eu

cd /app/apps/web

PORT="${PORT:-7860}"
PERSIST_DIR="${TOKENBOARD_WRANGLER_PERSIST_DIR:-/data/wrangler}"

export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:${PORT}}"
if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
  BETTER_AUTH_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  export BETTER_AUTH_SECRET
fi
export TOKENBOARD_DAILY_REPORT_HISTORY_DAYS="${TOKENBOARD_DAILY_REPORT_HISTORY_DAYS:-30}"
export TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT="${TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT:-50}"
export TOKENBOARD_USAGE_SUMMARY_STRICT="${TOKENBOARD_USAGE_SUMMARY_STRICT:-false}"
export TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS="${TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS:-90}"
export TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE="${TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE:-5}"

mkdir -p "$PERSIST_DIR"

pnpm exec wrangler d1 migrations apply DB \
  --local \
  --persist-to "$PERSIST_DIR" \
  --config wrangler.jsonc

exec pnpm exec wrangler dev \
  --local \
  --ip 0.0.0.0 \
  --port "$PORT" \
  --persist-to "$PERSIST_DIR" \
  --config wrangler.jsonc \
  --log-level info
