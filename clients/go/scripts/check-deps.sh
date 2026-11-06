#!/usr/bin/env bash
#
# check-deps.sh — the ccusage dependency gate (docs/specs/go-client-spec.md §5).
#
# ccusage publishes no schemaVersion and no machine-readable changelog, so a
# change to its --json output is silent until a collector mis-parses it and
# uploads wrong numbers. This gate is the only line of defence: it runs a fixed
# fixture tree through the collector's own invocation and diffs the result
# against recorded goldens.
#
# The goldens are the contract the Go client's ccusage layer (M4) is written
# against, so they are pinned before that layer exists rather than after.
#
# Native side: claude-code also has an in-process adapter whose goldens are
# minted from the same binary by scripts/gen-claude-goldens.mjs and compared by
# internal/collect/adapters/claude/goldens_test.go. Those are the native golden
# gate — they must be re-minted (and reviewed) whenever this script's goldens
# change, because both sides are supposed to answer with the same numbers.
# This script still guards the binary itself, which is what production runs
# until useNativeClaude flips (docs/research/2026-11-05-claude-native-parity.md).
#
# Usage:
#   scripts/check-deps.sh                      # verify against the goldens
#   scripts/check-deps.sh --update             # re-mint goldens after review
#   CCUSAGE_BIN=/path/to/ccusage scripts/...   # test a specific binary
#
# Exit codes: 0 in agreement, 1 drift or a setup failure.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
golden_dir="$repo_root/clients/go/testdata/ccusage-golden"
collector_dir="$repo_root/packages/collector"
config_path="$collector_dir/ccusage.json"

update=0
if [[ "${1:-}" == "--update" ]]; then
  update=1
elif [[ $# -gt 0 ]]; then
  echo "usage: $(basename "$0") [--update]" >&2
  exit 1
fi

# The expected version is the TS collector's pin: the two implementations must
# agree on it, and bumping it is a deliberate act that runs this gate.
expected_version=$(node -e \
  "process.stdout.write(require('$collector_dir/package.json').dependencies.ccusage)")

ccusage_bin="${CCUSAGE_BIN:-}"
if [[ -z "$ccusage_bin" ]]; then
  if [[ -x "$collector_dir/node_modules/.bin/ccusage" ]]; then
    ccusage_bin="$collector_dir/node_modules/.bin/ccusage"
  elif command -v ccusage >/dev/null 2>&1; then
    ccusage_bin=$(command -v ccusage)
  else
    echo "check-deps: no ccusage binary found. Run 'pnpm install', or set CCUSAGE_BIN." >&2
    exit 1
  fi
fi

actual_version=$("$ccusage_bin" --version | awk '{print $2}')
if [[ "$actual_version" != "$expected_version" ]]; then
  echo "check-deps: ccusage version drift — packages/collector pins $expected_version, $ccusage_bin is $actual_version." >&2
  echo "            Upgrade deliberately, then re-run with --update after reviewing the diff." >&2
  exit 1
fi

work_dir=$(mktemp -d)
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

# A fixed fixture, not the developer's own history: two models, two dates, and
# the cache buckets the normalizer reads. Timestamps are literal so the output
# is reproducible on any machine.
mkdir -p "$work_dir/claude/projects/proj-a"
cat > "$work_dir/claude/projects/proj-a/session-1.jsonl" <<'FIXTURE'
{"type":"assistant","timestamp":"2026-04-28T02:00:00.000Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":4}}}
{"type":"assistant","timestamp":"2026-04-29T02:00:00.000Z","requestId":"req_2","message":{"id":"msg_2","model":"claude-opus-4-5","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":40}}}
FIXTURE

# Key order is not part of the contract, so it is normalised away; the fixture
# keeps dates, ids and paths fixed, so nothing else is volatile.
canonicalize() {
  node -e '
    let input = ""
    process.stdin.on("data", (chunk) => { input += chunk })
    process.stdin.on("end", () => {
      const sortKeys = (value) => {
        if (Array.isArray(value)) return value.map(sortKeys)
        if (value && typeof value === "object") {
          return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
        }
        return value
      }
      process.stdout.write(JSON.stringify(sortKeys(JSON.parse(input)), null, 2) + "\n")
    })
  '
}

run_ccusage() {
  CLAUDE_CONFIG_DIR="$work_dir/claude" "$ccusage_bin" "$@" \
    --config "$config_path" -z UTC -s 20260428 -u 20260429
}

status=0
mkdir -p "$golden_dir"
for report in daily session; do
  golden="$golden_dir/claude-$report.json"
  if [[ "$report" == "daily" ]]; then
    produced=$(run_ccusage claude daily --json --breakdown | canonicalize)
  else
    produced=$(run_ccusage claude session --json | canonicalize)
  fi

  if [[ $update -eq 1 ]]; then
    printf '%s\n' "$produced" > "$golden"
    echo "check-deps: wrote $golden"
    continue
  fi
  if [[ ! -f "$golden" ]]; then
    echo "check-deps: missing golden $golden — run with --update to mint it." >&2
    status=1
    continue
  fi
  if ! diff -u "$golden" <(printf '%s\n' "$produced") > "$work_dir/$report.diff"; then
    echo "check-deps: ccusage $report output drifted from $golden:" >&2
    cat "$work_dir/$report.diff" >&2
    status=1
  fi
done

if [[ $status -ne 0 ]]; then
  echo "check-deps: shape drift is a breaking change for the collector — review it before updating the goldens." >&2
  exit 1
fi
if [[ $update -eq 0 ]]; then
  echo "check-deps: ccusage $actual_version output matches the goldens."
fi