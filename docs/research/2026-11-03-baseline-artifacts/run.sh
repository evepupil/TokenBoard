#!/bin/bash
# Task 8 baseline: run bench-collect sequentially for single, 30d, full.
# Sequential by design: never run two scenarios at once (they compete for RSS/CPU).
set -euo pipefail

OUT=/tmp/tokenboard-bench-8
BIN="$HOME/.tokenboard/bin/ccusage"
cd ~/.tokenboard/TokenBoard/clients/go

log() { echo "=== $(date '+%Y-%m-%d %H:%M:%S %z') $* ==="; }

mem() {
  uptime
  vm_stat | sed -n '1,8p'
  echo "free+inactive GB: $(vm_stat | awk '
    /Pages free/ {gsub(/\./,"",$3); free=$3}
    /Pages inactive/ {gsub(/\./,"",$3); inact=$3}
    END {printf "%.2f (free %.2f)", (free+inact)*4096/1024/1024/1024, free*4096/1024/1024/1024}')"
}

log "PRE-RUN environment"
mem
echo "ccusage: $($BIN --version)"
echo "ccusage processes: $(ps aux | grep -c '[c]cusage' || true)"
echo "go: $(go version)"

for scn in single 30d full; do
  log "BEFORE $scn"
  mem
  start=$(date +%s)
  set +e
  go run ./cmd/bench-collect -source claude-code -scenario "$scn" -rounds 5 \
    -ccusage-bin "$BIN" -json > "$OUT/$scn.json" 2> "$OUT/$scn.err"
  rc=$?
  set -e
  end=$(date +%s)
  log "AFTER $scn (exit=$rc, wall=$((end-start))s)"
  mem
  echo "--- stderr $scn ---"
  cat "$OUT/$scn.err"
done

log "ALL DONE"
